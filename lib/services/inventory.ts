/**
 * Warehouse stock — the ledger, the balances, and the two ways to correct them.
 *
 * `stock_ledger` is append-only and `stock_balances` is a projection of it. This
 * module reads both and never writes either: every change goes through
 * `post_stock_movement()`, which is the only thing that may.
 *
 * Two corrections exist, and they are not the same thing:
 *
 *   ADJUSTMENT  the count was wrong. A physical stock-take found 38 where the
 *               system said 40. Nothing was mis-posted; reality differs.
 *
 *   REVERSAL    the posting was wrong. §29 says never edit — so a mistake is
 *               corrected by mirroring it, leaving both entries visible.
 *
 * Conflicts that shape this module:
 *
 *   C-18  There is no per-location balance and none will be synthesised.
 *         `stock_balances` is keyed by (site, item, bucket); location lives on
 *         movements and on serialised units. Location filters here run over
 *         ledger entries, never over balances, and the screens say so.
 *
 *   C-21  `v_stock_position` cross-joins sites to items, so every query against
 *         it carries a site predicate. Group-wide figures read `stock_balances`
 *         directly instead.
 */
import { inTransaction, sql } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { postMovement, reverseEntry, availableForUpdate } from '@/lib/services/stock';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'STOCK';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with stock.');
  }
}

/** Sites the caller may see, or null for group-wide. */
function visibleSites(principal: Principal): number[] | null {
  return principal.groupWide ? null : principal.sites.map(s => s.siteId);
}

// =============================================================================
// Position
// =============================================================================

/**
 * Stock at one site, by item.
 *
 * Always site-scoped — `v_stock_position` materialises every site × item pair,
 * so an unfiltered read is sites × items rows for a screen that shows one site
 * (C-21). A caller with no site chosen gets their first one rather than
 * everything.
 */
export async function stockPosition(
  principal: Principal,
  filters: { siteId: number; status?: string; search?: string; belowReorder?: boolean },
): Promise<Row[]> {
  const allowed = visibleSites(principal);
  if (allowed !== null && !allowed.includes(filters.siteId)) {
    throw forbidden('You do not have access to that site.');
  }

  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;

  return sql<Row[]>`
    SELECT p.*, i.is_serialised
      FROM v_stock_position p
      JOIN items i ON i.id = p.item_id
     WHERE p.site_id = ${filters.siteId}
       AND i.status = 'ACTIVE'
       -- An item with no stock and no reorder level has never been at this
       -- site. The cross join invents the row; there is nothing to show.
       AND (p.on_hand <> 0 OR p.reorder_level > 0)
       AND (${filters.status ?? null}::text IS NULL OR p.stock_status = ${filters.status ?? null})
       AND (${filters.belowReorder ?? null}::boolean IS NULL
            OR (p.stock_status = 'BELOW_REORDER') = ${filters.belowReorder ?? null})
       AND (${search}::text IS NULL OR p.code ILIKE ${search} OR p.name ILIKE ${search})
     ORDER BY
       CASE p.stock_status WHEN 'BELOW_REORDER' THEN 0 WHEN 'NEAR_REORDER' THEN 1 ELSE 2 END,
       p.code`;
}

/** One item at one site: balances by bucket, plus its recent movements. */
export async function itemAtSite(
  principal: Principal,
  siteId: number,
  itemId: number,
): Promise<{ position: Row | null; buckets: Row[]; recent: Row[]; units: Row[] }> {
  const allowed = visibleSites(principal);
  if (allowed !== null && !allowed.includes(siteId)) {
    throw forbidden('You do not have access to that site.');
  }

  const [position] = await sql<Row[]>`
    SELECT p.*, i.is_serialised, i.warranty_months
      FROM v_stock_position p JOIN items i ON i.id = p.item_id
     WHERE p.site_id = ${siteId} AND p.item_id = ${itemId}`;

  const buckets = await sql<Row[]>`
    SELECT bucket, qty FROM stock_balances
     WHERE site_id = ${siteId} AND item_id = ${itemId} AND qty <> 0
     ORDER BY bucket`;

  const recent = await sql<Row[]>`
    SELECT e.*, u.full_name AS moved_by_name, l.code AS location_code
      FROM stock_ledger e
      LEFT JOIN app_users u         ON u.id = e.posted_by
      LEFT JOIN storage_locations l ON l.id = e.location_id
     WHERE e.site_id = ${siteId} AND e.item_id = ${itemId}
     ORDER BY e.id DESC LIMIT 50`;

  const units = await sql<Row[]>`
    SELECT a.id, a.asset_tag, a.serial_no, a.bucket, l.code AS location_code,
           a.warranty_until
      FROM asset_units a
      LEFT JOIN storage_locations l ON l.id = a.location_id
     WHERE a.site_id = ${siteId} AND a.item_id = ${itemId}
     ORDER BY a.asset_tag`;

  return { position: position ?? null, buckets, recent, units };
}

// =============================================================================
// Ledger
// =============================================================================

/**
 * The ledger, newest first.
 *
 * Location is a filter here and nowhere else (C-18): a movement records where
 * it happened, but there is no per-location balance to compare it against, and
 * the screen has to say so rather than let a filtered sum read as a total.
 */
export function ledger(
  principal: Principal,
  filters: {
    siteId?: number; itemId?: number; movement?: string; locationId?: number;
    from?: string; to?: string; limit?: number;
  } = {},
): Promise<Row[]> {
  const siteIds = visibleSites(principal);

  return sql<Row[]>`
    SELECT e.*, i.code AS item_code, i.name AS item_name, i.uom,
           s.code AS site_code, s.name AS site_name,
           l.code AS location_code, u.full_name AS moved_by_name,
           a.asset_tag,
           r.id IS NOT NULL AS is_reversed
      FROM stock_ledger e
      JOIN items i  ON i.id = e.item_id
      JOIN sites s  ON s.id = e.site_id
      LEFT JOIN storage_locations l ON l.id = e.location_id
      LEFT JOIN app_users u         ON u.id = e.posted_by
      LEFT JOIN asset_units a       ON a.id = e.asset_unit_id
      LEFT JOIN stock_ledger r      ON r.reverses_entry_id = e.id
     WHERE (${siteIds}::bigint[] IS NULL OR e.site_id = ANY(${siteIds}))
       AND (${filters.siteId ?? null}::bigint IS NULL OR e.site_id = ${filters.siteId ?? null})
       AND (${filters.itemId ?? null}::bigint IS NULL OR e.item_id = ${filters.itemId ?? null})
       AND (${filters.movement ?? null}::text IS NULL OR e.movement = ${filters.movement ?? null}::movement_type)
       AND (${filters.locationId ?? null}::bigint IS NULL OR e.location_id = ${filters.locationId ?? null})
       AND (${filters.from ?? null}::date IS NULL OR e.posted_at >= ${filters.from ?? null}::date)
       AND (${filters.to ?? null}::date IS NULL OR e.posted_at < ${filters.to ?? null}::date + 1)
     ORDER BY e.id DESC
     LIMIT ${Math.min(filters.limit ?? 200, 500)}`;
}

export async function ledgerEntry(id: number): Promise<Row> {
  const [row] = await sql<Row[]>`
    SELECT e.*, i.code AS item_code, i.name AS item_name, i.uom,
           s.name AS site_name, l.code AS location_code,
           u.full_name AS moved_by_name, a.asset_tag,
           rev.id AS reversed_by_id, rev.entry_no AS reversed_by_no,
           orig.entry_no AS reverses_entry_no
      FROM stock_ledger e
      JOIN items i ON i.id = e.item_id
      JOIN sites s ON s.id = e.site_id
      LEFT JOIN storage_locations l ON l.id = e.location_id
      LEFT JOIN app_users u         ON u.id = e.posted_by
      LEFT JOIN asset_units a       ON a.id = e.asset_unit_id
      LEFT JOIN stock_ledger rev    ON rev.reverses_entry_id = e.id
      LEFT JOIN stock_ledger orig   ON orig.id = e.reverses_entry_id
     WHERE e.id = ${id}`;

  if (!row) throw notFound('That stock ledger entry no longer exists.');
  return row;
}

// =============================================================================
// Adjust
// =============================================================================

export interface AdjustInput {
  siteId: number;
  itemId: number;
  /** What the count actually found, in the AVAILABLE bucket. */
  countedQty: string;
  reason: string;
  locationId?: number | null;
}

/**
 * Reconcile the system to a physical count.
 *
 * The caller supplies what they counted, not a delta — a delta invites the
 * wrong sign, and a re-submitted delta double-counts. The movement is derived
 * from the gap, and a count that matches posts nothing at all rather than a
 * zero-quantity entry.
 *
 * `post_stock_movement()` refuses to take the balance below zero, so a count
 * that would is refused with the available quantity named.
 */
export async function adjustToCount(
  actor: Actor,
  input: AdjustInput,
): Promise<{ adjustment: Row | null; entryId: number | null; delta: string }> {
  const reason = input.reason?.trim();
  if (!reason || reason.length < 4) {
    throw badRequest('An adjustment needs a reason — it is the only record of why the count changed.', 'reason');
  }

  return inTransaction(async tx => {
    requirePermission(actor, 'INVENTORY.ADJUST', input.siteId);

    const [item] = await tx<Row[]>`SELECT code, name, uom FROM items WHERE id = ${input.itemId}`;
    if (!item) throw notFound('That item no longer exists.');

    const counted = Number(input.countedQty);
    if (!Number.isFinite(counted) || counted < 0) {
      throw badRequest('A counted quantity cannot be negative.', 'counted_qty');
    }

    const onSystem = await availableForUpdate(tx, input.siteId, input.itemId);
    const delta = counted - onSystem;

    // A count that agrees with the system is not a discrepancy. Recording one
    // would clutter the ledger and trip stock_adj_differs besides.
    if (Math.abs(delta) < 0.0005) {
      return { adjustment: null, entryId: null, delta: '0' };
    }

    // The adjustment record comes first: it is what the movement points at, and
    // its id is what makes the idempotency key unique per count (C-27).
    const adjNo = await nextDocumentNoForSite(tx, 'ADJ', input.siteId);

    const [adjustment] = await tx<Row[]>`
      INSERT INTO stock_adjustments (adj_no, site_id, item_id, location_id,
                                     qty_system, qty_counted, reason, counted_by)
      VALUES (${adjNo}, ${input.siteId}, ${input.itemId}, ${input.locationId ?? null},
              ${onSystem.toFixed(3)}::numeric, ${counted.toFixed(3)}::numeric,
              ${reason}, ${actor.principal.userId})
      RETURNING *`;

    // The ledger has no signed quantity: a movement is always positive and its
    // direction is the pair of buckets. A count that found MORE brings stock in
    // from outside; a count that found LESS sends it out.
    const entryId = await postMovement(tx, {
      siteId: input.siteId,
      itemId: input.itemId,
      movement: 'ADJUSTMENT',
      from: delta > 0 ? null : 'AVAILABLE',
      to: delta > 0 ? 'AVAILABLE' : null,
      qty: Math.abs(delta).toFixed(3),
      sourceType: 'ADJUSTMENT',
      sourceId: Number(adjustment.id),
      userId: actor.principal.userId,
      locationId: input.locationId ?? null,
      remarks: `${adjNo}: ${reason}`,
    });

    await audit(tx, {
      entityType: ENTITY, entityId: entryId, action: 'OVERRIDE',
      before: { available: onSystem },
      after: { available: counted, item: item.code, adj_no: adjNo },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Stock take on ${item.code}: ${onSystem} → ${counted} ${item.uom}. ${reason}`,
    });

    return { adjustment, entryId, delta: delta.toFixed(3) };
  });
}

/** Stock takes that found a discrepancy, newest first. */
export function listAdjustments(
  principal: Principal,
  filters: { siteId?: number; itemId?: number } = {},
): Promise<Row[]> {
  const siteIds = visibleSites(principal);

  return sql<Row[]>`
    SELECT a.*, i.code AS item_code, i.name AS item_name, i.uom,
           s.name AS site_name, l.code AS location_code,
           u.full_name AS counted_by_name,
           e.id AS stock_entry_id, e.entry_no
      FROM stock_adjustments a
      JOIN items i ON i.id = a.item_id
      JOIN sites s ON s.id = a.site_id
      LEFT JOIN storage_locations l ON l.id = a.location_id
      JOIN app_users u ON u.id = a.counted_by
      -- The ledger points here rather than the other way round, so the entry
      -- is found through the source index (C-27).
      LEFT JOIN stock_ledger e ON e.source_type = 'ADJUSTMENT' AND e.source_id = a.id
     WHERE (${siteIds}::bigint[] IS NULL OR a.site_id = ANY(${siteIds}))
       AND (${filters.siteId ?? null}::bigint IS NULL OR a.site_id = ${filters.siteId ?? null})
       AND (${filters.itemId ?? null}::bigint IS NULL OR a.item_id = ${filters.itemId ?? null})
     ORDER BY a.created_at DESC
     LIMIT 200`;
}

// =============================================================================
// Reverse
// =============================================================================

/**
 * Mirror a posted movement (§29 — never edit, always reverse).
 *
 * The mirror is built from the original inside the transaction, so it is exact
 * even if the caller misremembers what they are reversing. A second attempt is
 * refused: `reverses_entry_id` already points at it.
 */
export async function reverseMovement(actor: Actor, entryId: number, remarks: string): Promise<number> {
  const text = remarks?.trim();
  if (!text || text.length < 4) {
    throw badRequest('A reversal needs a reason. The original entry stays visible beside it.', 'remarks');
  }

  return inTransaction(async tx => {
    const [original] = await tx<Row[]>`
      SELECT e.*, i.code AS item_code FROM stock_ledger e
        JOIN items i ON i.id = e.item_id
       WHERE e.id = ${entryId}`;
    if (!original) throw notFound('That stock ledger entry no longer exists.');

    requirePermission(actor, 'INVENTORY.REVERSE', Number(original.site_id));

    if (original.movement === 'REVERSAL') {
      throw conflict('That entry is itself a reversal. Reverse the original instead.');
    }

    const newId = await reverseEntry(tx, { entryId, userId: actor.principal.userId, remarks: text });

    await audit(tx, {
      entityType: ENTITY, entityId: newId, action: 'OVERRIDE',
      before: { reversed_entry: entryId, movement: original.movement, qty: original.qty },
      after: { reversal_entry: newId },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Reversed ${original.item_code} ${original.movement} of ${original.qty}. ${text}`,
    });

    return newId;
  });
}

// =============================================================================
// Group-wide figures (C-21 — these read balances, not the cross join)
// =============================================================================

export async function groupTotals(principal: Principal): Promise<Row[]> {
  const siteIds = visibleSites(principal);

  return sql<Row[]>`
    SELECT s.id AS site_id, s.code AS site_code, s.name AS site_name,
           coalesce(sum(b.qty) FILTER (WHERE b.bucket = 'AVAILABLE'), 0)    AS available,
           coalesce(sum(b.qty) FILTER (WHERE b.bucket = 'RESERVED'), 0)     AS reserved,
           coalesce(sum(b.qty) FILTER (WHERE b.bucket = 'IN_TRANSIT'), 0)   AS in_transit,
           coalesce(sum(b.qty) FILTER (WHERE b.bucket = 'DAMAGED_HOLD'), 0) AS damaged_hold,
           count(DISTINCT b.item_id) FILTER (WHERE b.qty <> 0)              AS item_count
      FROM sites s
      LEFT JOIN stock_balances b ON b.site_id = s.id
     WHERE s.status = 'ACTIVE'
       AND (${siteIds}::bigint[] IS NULL OR s.id = ANY(${siteIds}))
     GROUP BY s.id, s.code, s.name
     ORDER BY s.name`;
}
