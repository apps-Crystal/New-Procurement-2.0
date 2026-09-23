/**
 * Asset register (brief §17) — serialised stock, one row per physical unit.
 *
 * An item marked `is_serialised` is counted twice by the schema on purpose: as
 * a quantity in `stock_balances`, and as individual units in `asset_units`. The
 * quantity is what the warehouse reasons about; the units are what carry a
 * serial number, a warranty date and a location.
 *
 * Keeping the two in step is conflict C-19. That is handled inside
 * `postMovement` rather than here, so it cannot be skipped — see the note on
 * `syncSerialisedUnits`. What this module owns is the other half: minting the
 * units when stock first arrives, and reporting drift if it ever appears
 * anyway.
 *
 * On asset tags: `asset_units.asset_tag` is UNIQUE but has no document series,
 * so it is not minted by `next_document_no()`. A tag is not a document — it is
 * the label stuck on the machine. It follows the same shape as the vendor code
 * (§30's rule is about document numbers), guarded by the unique index so a
 * concurrent mint collides rather than duplicating.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'ASSET_UNIT';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with the asset register.');
  }
}

// =============================================================================
// Minting
// =============================================================================

/**
 * Next tags in an item's series at a site: `<ITEM>-<SITE>-0001`.
 *
 * Read inside the caller's transaction and guarded by `asset_units_asset_tag_key`
 * — a concurrent mint racing to the same number hits the unique index and gets a
 * retryable conflict rather than a duplicate tag on two machines.
 */
async function nextTags(tx: Tx, itemCode: string, siteCode: string, count: number): Promise<string[]> {
  const prefix = `${itemCode}-${siteCode}-`;

  const [row] = await tx<{ next: string }[]>`
    SELECT coalesce(max(substring(asset_tag from ${`^${prefix}(\\d+)$`})::int), 0) + 1 AS next
      FROM asset_units WHERE asset_tag LIKE ${`${prefix}%`}`;

  const start = Number(row.next);
  return Array.from({ length: count }, (_, i) => `${prefix}${String(start + i).padStart(4, '0')}`);
}

export interface MintInput {
  grnLineId: number;
  itemId: number;
  siteId: number;
  qty: number;
  locationId?: number | null;
  /** Serial numbers, in order, where the receiver captured them. */
  serialNos?: (string | null)[];
}

/**
 * Create one asset unit per received unit of a serialised item.
 *
 * Called from GRN approval, inside the same transaction that posts the stock —
 * so the register and the balance are created together or not at all. Whole
 * units only: half a machine is not a thing, and a fractional quantity on a
 * serialised item is a data error worth surfacing rather than rounding away.
 *
 * Warranty runs from receipt, using the item's `warranty_months`.
 */
export async function mintUnits(tx: Tx, input: MintInput, userId: number): Promise<Row[]> {
  const [item] = await tx<Row[]>`
    SELECT i.id, i.code, i.is_serialised, i.warranty_months, s.code AS site_code
      FROM items i CROSS JOIN sites s
     WHERE i.id = ${input.itemId} AND s.id = ${input.siteId}`;

  if (!item) throw notFound('That item or site no longer exists.');
  if (item.is_serialised !== true) return [];

  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw badRequest(
      `${item.code} is serialised, so it is received in whole units — ${input.qty} is not one.`,
      'qty',
    );
  }

  const tags = await nextTags(tx, String(item.code), String(item.site_code), input.qty);
  const months = item.warranty_months === null ? null : Number(item.warranty_months);
  const out: Row[] = [];

  for (let i = 0; i < input.qty; i++) {
    const [unit] = await tx<Row[]>`
      INSERT INTO asset_units (asset_tag, item_id, serial_no, site_id, location_id, bucket,
                               source_grn_line_id, warranty_until)
      VALUES (${tags[i]}, ${input.itemId}, ${input.serialNos?.[i]?.trim() || null},
              ${input.siteId}, ${input.locationId ?? null}, 'AVAILABLE',
              ${input.grnLineId},
              ${months === null ? null : sql`(current_date + ${`${months} months`}::interval)::date`})
      RETURNING *`;
    out.push(unit);
  }

  await audit(tx, {
    entityType: ENTITY, entityId: input.grnLineId, action: 'CREATE',
    after: { tags, item: item.code, site: item.site_code },
    userId, ip: null,
    remarks: `${input.qty} ${input.qty === 1 ? 'unit' : 'units'} added to the asset register`,
  });

  return out;
}

// =============================================================================
// Edit
// =============================================================================

export interface AssetPatch {
  serialNo?: string | null;
  locationId?: number | null;
  warrantyUntil?: string | null;
}

/**
 * Correct a unit's details.
 *
 * Deliberately narrow. The bucket is not editable here — it belongs to the
 * ledger, and letting it be typed would recreate exactly the drift C-19 is
 * about. Nor is the site: a unit moves between sites by transfer, which posts
 * stock, not by having its site_id rewritten.
 */
export async function updateAsset(actor: Actor, id: number, patch: AssetPatch): Promise<Row> {
  return inTransaction(async tx => {
    const [current] = await tx<Row[]>`SELECT * FROM asset_units WHERE id = ${id} FOR UPDATE`;
    if (!current) throw notFound('That asset unit no longer exists.');

    requirePermission(actor, 'ASSET.EDIT', Number(current.site_id));

    if (patch.locationId) {
      const [loc] = await tx<Row[]>`
        SELECT id FROM storage_locations WHERE id = ${patch.locationId} AND site_id = ${current.site_id as number}`;
      if (!loc) {
        throw badRequest('That storage location belongs to a different site.', 'location_id');
      }
    }

    const [updated] = await tx<Row[]>`
      UPDATE asset_units
         SET serial_no      = ${patch.serialNo !== undefined ? patch.serialNo?.trim() || null : (current.serial_no as string | null)},
             location_id    = ${patch.locationId !== undefined ? patch.locationId : (current.location_id as number | null)},
             warranty_until = ${patch.warrantyUntil !== undefined ? patch.warrantyUntil : (current.warranty_until as string | null)},
             updated_at     = now()
       WHERE id = ${id}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: id, action: 'UPDATE',
      before: { serial_no: current.serial_no, location_id: current.location_id, warranty_until: current.warranty_until },
      after: { serial_no: updated.serial_no, location_id: updated.location_id, warranty_until: updated.warranty_until },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listAssets(
  principal: Principal,
  filters: { siteId?: number; itemId?: number; bucket?: string; search?: string } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;

  return sql<Row[]>`
    SELECT a.*, i.code AS item_code, i.name AS item_name, i.uom,
           s.code AS site_code, s.name AS site_name,
           l.code AS location_code, l.description AS location_description,
           g.grn_no, po.po_no, v.legal_name AS vendor_name,
           a.warranty_until IS NOT NULL AND a.warranty_until >= current_date AS in_warranty
      FROM asset_units a
      JOIN items i  ON i.id = a.item_id
      JOIN sites s  ON s.id = a.site_id
      LEFT JOIN storage_locations l ON l.id = a.location_id
      LEFT JOIN grn_lines gl        ON gl.id = a.source_grn_line_id
      LEFT JOIN grns g              ON g.id = gl.grn_id
      LEFT JOIN purchase_orders po  ON po.id = g.po_id
      LEFT JOIN vendors v           ON v.id = po.vendor_id
     WHERE (${siteIds}::bigint[] IS NULL OR a.site_id = ANY(${siteIds}))
       AND (${filters.siteId ?? null}::bigint IS NULL OR a.site_id = ${filters.siteId ?? null})
       AND (${filters.itemId ?? null}::bigint IS NULL OR a.item_id = ${filters.itemId ?? null})
       AND (${filters.bucket ?? null}::text IS NULL OR a.bucket = ${filters.bucket ?? null}::stock_bucket)
       AND (${search}::text IS NULL
            OR a.asset_tag ILIKE ${search} OR a.serial_no ILIKE ${search}
            OR i.code ILIKE ${search} OR i.name ILIKE ${search})
     ORDER BY a.asset_tag`;
}

export async function getAsset(id: number): Promise<{ asset: Row; history: Row[] }> {
  const [asset] = await sql<Row[]>`
    SELECT a.*, i.code AS item_code, i.name AS item_name, i.uom, i.warranty_months,
           s.code AS site_code, s.name AS site_name,
           l.code AS location_code, l.description AS location_description,
           g.grn_no, g.id AS grn_id, po.po_no, v.legal_name AS vendor_name,
           a.warranty_until IS NOT NULL AND a.warranty_until >= current_date AS in_warranty
      FROM asset_units a
      JOIN items i  ON i.id = a.item_id
      JOIN sites s  ON s.id = a.site_id
      LEFT JOIN storage_locations l ON l.id = a.location_id
      LEFT JOIN grn_lines gl        ON gl.id = a.source_grn_line_id
      LEFT JOIN grns g              ON g.id = gl.grn_id
      LEFT JOIN purchase_orders po  ON po.id = g.po_id
      LEFT JOIN vendors v           ON v.id = po.vendor_id
     WHERE a.id = ${id}`;

  if (!asset) throw notFound('That asset unit no longer exists.');

  // Movements that named this unit. A movement that took it anonymously from a
  // bucket does not appear — the ledger records the quantity, not the unit.
  const history = await sql<Row[]>`
    SELECT e.*, u.full_name AS moved_by_name
      FROM stock_ledger e
      LEFT JOIN app_users u ON u.id = e.posted_by
     WHERE e.asset_unit_id = ${id}
     ORDER BY e.id DESC`;

  return { asset, history };
}

// =============================================================================
// Drift (conflict C-19)
// =============================================================================

export interface Drift {
  siteId: number;
  siteName: string;
  itemId: number;
  itemCode: string;
  bucket: string;
  balanceQty: string;
  unitCount: number;
}

/**
 * Where the unit count and the aggregate disagree.
 *
 * C-19 says report drift rather than silently repair it, and that is right:
 * a repair picks a winner, and which of the two is correct is a warehouse
 * question, not a database one. Running clean is the assertion worth making —
 * this exists so it can be asserted.
 *
 * WRITTEN_OFF is excluded, and that is not a loophole. `stock_bucket` has no
 * value meaning "issued out", so a serialised unit that leaves on an issue has
 * nowhere to go but WRITTEN_OFF — while the ISSUE movement takes its quantity
 * out of the site entirely rather than into a WRITTEN_OFF balance. The two
 * populations in that bucket are therefore not comparable: units written off
 * after damage are balance-backed, units issued out are not.
 *
 * Every bucket where the two genuinely must agree is still compared, which is
 * every bucket stock can be in while the site still holds it.
 */
export async function assetDrift(siteId?: number): Promise<Drift[]> {
  const rows = await sql<Row[]>`
    WITH units AS (
      SELECT a.site_id, a.item_id, a.bucket, count(*)::int AS unit_count
        FROM asset_units a
       WHERE a.bucket <> 'WRITTEN_OFF'
         AND (${siteId ?? null}::bigint IS NULL OR a.site_id = ${siteId ?? null})
       GROUP BY a.site_id, a.item_id, a.bucket
    ),
    balances AS (
      SELECT b.site_id, b.item_id, b.bucket, b.qty
        FROM stock_balances b
        JOIN items i ON i.id = b.item_id AND i.is_serialised
       WHERE b.qty <> 0
         AND b.bucket <> 'WRITTEN_OFF'
         AND (${siteId ?? null}::bigint IS NULL OR b.site_id = ${siteId ?? null})
    )
    SELECT coalesce(u.site_id, b.site_id)  AS site_id,
           coalesce(u.item_id, b.item_id)  AS item_id,
           coalesce(u.bucket, b.bucket)    AS bucket,
           coalesce(b.qty, 0)              AS balance_qty,
           coalesce(u.unit_count, 0)       AS unit_count,
           s.name AS site_name, i.code AS item_code
      FROM units u
      FULL OUTER JOIN balances b
        ON b.site_id = u.site_id AND b.item_id = u.item_id AND b.bucket = u.bucket
      JOIN sites s ON s.id = coalesce(u.site_id, b.site_id)
      JOIN items i ON i.id = coalesce(u.item_id, b.item_id)
     WHERE coalesce(b.qty, 0) <> coalesce(u.unit_count, 0)
     ORDER BY s.name, i.code, coalesce(u.bucket, b.bucket)`;

  return rows.map(r => ({
    siteId: Number(r.site_id),
    siteName: String(r.site_name),
    itemId: Number(r.item_id),
    itemCode: String(r.item_code),
    bucket: String(r.bucket),
    balanceQty: String(r.balance_qty),
    unitCount: Number(r.unit_count),
  }));
}
