/**
 * Goods receipt note (brief §14) — where stock finally exists.
 *
 * GRN_DRAFT → GRN_APPROVED → GRN_CLOSED
 *           ↘ GRN_FLAGGED ↗ (unflag back to draft)
 *           ↘ GRN_REJECTED
 *
 * Everything before this point — the gate count, the QC verdict — is paperwork
 * about goods in the receiving bay. Approval is the moment they become
 * inventory, and it is the only moment: the approval posts every line through
 * `post_stock_movement()`, and nothing in this module writes a balance.
 *
 * What the schema enforces:
 *
 *   grn_v2_needs_qc          CHECK   — a non-legacy GRN has a gate inward and a QC
 *   grn_lines_concession     CHECK   — concession quantity fits inside accepted
 *   grns_segregation         TRIGGER — the approver is neither receiver nor inspector
 *   v_po_line_receipt        VIEW    — only APPROVED and CLOSED GRNs count
 *
 * What this module decides:
 *
 *   C-09  An over-receipt cannot be approved. If accepting would drive
 *         `v_po_line_receipt.qty_outstanding` negative, the GRN goes to
 *         GRN_FLAGGED with a reason naming the excess, and only a Site Manager
 *         releases it after the PO is amended. The schema has no upper bound on
 *         accepted quantity, so without this the order quietly over-delivers.
 *
 * Approval is replay-safe. `post_stock_movement()` is idempotent on
 * `source_type:source_id:movement:site_id`, and the source is the GRN line — so
 * a retry after a dropped connection posts nothing twice.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition, lockAndReadStatus } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { receiveFromGrn } from '@/lib/services/stock';
import { mintUnits } from '@/lib/services/assets';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'GRN';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with goods receipts.');
  }
}

async function loadGrn(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM grns WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM grns WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That goods receipt no longer exists.');
  return rows[0];
}

// =============================================================================
// Draft
// =============================================================================

export interface GrnInput {
  qcId: number;
  /** Where each line is being put away. Optional — a site may not use locations. */
  locations?: { poLineId: number; locationId: number }[];
}

/**
 * Draft a GRN from a completed inspection.
 *
 * Quantities are not accepted from the caller. Each line takes the QC verdict's
 * accepted quantity, plus any concession a Site Manager granted on held stock —
 * which is what `grn_lines.qty_accepted` means by the schema's own comment,
 * "includes concession qty". The concession is also recorded separately so it
 * stays visible rather than merging into a number nobody can decompose.
 */
export async function createGrn(actor: Actor, input: GrnInput): Promise<Row> {
  return inTransaction(async tx => {
    const [qc] = await tx<Row[]>`
      SELECT q.*, g.id AS gate_inward_id, g.site_id, g.po_id, g.gi_no, g.status AS gi_status
        FROM qc_inspections q
        JOIN gate_inwards g ON g.id = q.gate_inward_id
       WHERE q.id = ${input.qcId}
       FOR UPDATE OF q`;

    if (!qc) throw notFound('That inspection no longer exists.');

    const siteId = Number(qc.site_id);
    requirePermission(actor, 'GRN.CREATE', siteId);

    if (qc.completed_at === null) {
      throw conflict('That inspection is not finished yet, so there is nothing to receive.');
    }

    // grns.qc_id is UNIQUE, so this is belt and braces — but the message is
    // better than a constraint name, and it names the existing GRN.
    const [existing] = await tx<Row[]>`SELECT grn_no FROM grns WHERE qc_id = ${input.qcId}`;
    if (existing) {
      throw conflict(`Inspection ${qc.qc_no} has already been received as ${existing.grn_no}.`);
    }

    const lines = await tx<Row[]>`
      SELECT q.id AS qc_line_id, q.qty_accepted, q.qty_hold, l.po_line_id,
             pl.rate, pl.item_id, i.code AS item_code,
             d.decision AS hold_decision,
             coalesce(d.qty, 0) AS hold_qty
        FROM qc_lines q
        JOIN gate_inward_lines l  ON l.id = q.gate_inward_line_id
        JOIN po_lines pl          ON pl.id = l.po_line_id
        JOIN items i              ON i.id = pl.item_id
        LEFT JOIN qc_hold_decisions d ON d.qc_line_id = q.id
       WHERE q.qc_id = ${input.qcId} ORDER BY q.id`;

    // A concession is the only way held stock reaches a GRN. A REJECT decision,
    // or an undecided hold, contributes nothing.
    const receivable = lines
      .map(l => {
        const concession = l.hold_decision === 'CONCESSION' ? Number(l.hold_qty) : 0;
        return {
          qcLineId: Number(l.qc_line_id),
          poLineId: Number(l.po_line_id),
          rate: String(l.rate),
          itemCode: String(l.item_code),
          concession,
          total: Number(l.qty_accepted) + concession,
        };
      })
      .filter(l => l.total > 0);

    if (receivable.length === 0) {
      throw conflict(
        `Nothing on inspection ${qc.qc_no} was accepted, so there is no goods receipt to raise. Raise a purchase return instead.`,
      );
    }

    const undecided = lines.filter(l => Number(l.qty_hold) > 0 && !l.hold_decision);
    if (undecided.length > 0) {
      throw conflict(
        `${undecided.map(l => l.item_code).join(', ')} still has stock on conditional hold. A site manager decides that before the receipt is raised.`,
      );
    }

    const grnNo = await nextDocumentNoForSite(tx, 'GRN', siteId);

    const [grn] = await tx<Row[]>`
      INSERT INTO grns (grn_no, po_id, gate_inward_id, qc_id, site_id, status)
      VALUES (${grnNo}, ${qc.po_id as number}, ${qc.gate_inward_id as number}, ${input.qcId}, ${siteId}, 'GRN_DRAFT')
      RETURNING *`;

    for (const line of receivable) {
      const location = input.locations?.find(l => l.poLineId === line.poLineId);
      await tx`
        INSERT INTO grn_lines (grn_id, po_line_id, qc_line_id, qty_accepted, qty_concession, unit_rate, location_id)
        VALUES (${grn.id as number}, ${line.poLineId}, ${line.qcLineId},
                ${String(line.total)}::numeric, ${String(line.concession)}::numeric,
                ${line.rate}::numeric, ${location?.locationId ?? null})`;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: Number(grn.id), action: 'CREATE',
      after: {
        grn_no: grnNo, qc: qc.qc_no, gate_inward: qc.gi_no,
        lines: receivable.length,
        concession: receivable.reduce((s, l) => s + l.concession, 0),
      },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return grn;
  });
}

// =============================================================================
// Over-receipt (conflict C-09)
// =============================================================================

export interface OverReceipt {
  poLineId: number;
  itemCode: string;
  qtyOrdered: string;
  qtyAlreadyReceived: string;
  qtyOnThisGrn: string;
  excess: string;
}

/**
 * Lines whose acceptance would take the order past what was ordered.
 *
 * `v_po_line_receipt` counts only APPROVED and CLOSED GRNs, so this GRN's own
 * lines are not in `qty_received` yet — which is exactly what makes the check
 * possible before approving rather than after.
 */
export async function overReceipts(tx: Tx, grnId: number): Promise<OverReceipt[]> {
  const rows = await tx<Row[]>`
    SELECT gl.po_line_id, gl.qty_accepted, i.code AS item_code,
           r.qty_ordered, r.qty_received
      FROM grn_lines gl
      JOIN po_lines pl          ON pl.id = gl.po_line_id
      JOIN items i              ON i.id = pl.item_id
      JOIN v_po_line_receipt r  ON r.po_line_id = gl.po_line_id
     WHERE gl.grn_id = ${grnId}`;

  return rows
    .map(r => {
      const excess = Number(r.qty_received) + Number(r.qty_accepted) - Number(r.qty_ordered);
      return {
        poLineId: Number(r.po_line_id),
        itemCode: String(r.item_code),
        qtyOrdered: String(r.qty_ordered),
        qtyAlreadyReceived: String(r.qty_received),
        qtyOnThisGrn: String(r.qty_accepted),
        excess: excess.toFixed(3),
      };
    })
    .filter(r => Number(r.excess) > 0.0005);
}

// =============================================================================
// Approve — the only place stock is created
// =============================================================================

/**
 * Approve the receipt and post the stock.
 *
 * The segregation trigger refuses an approver who was the receiver or the
 * inspector; that is checked here too, so the refusal names the person's role
 * rather than arriving as a database exception.
 *
 * An over-receipt is refused (C-09) with the excess named. The caller's remedy
 * is to flag the GRN, amend the PO, then unflag — not to quietly accept more
 * than was ordered.
 */
export async function approveGrn(actor: Actor, grnId: number): Promise<{ grn: Row; entries: number[] }> {
  return inTransaction(async tx => {
    const grn = await loadGrn(tx, grnId, true);
    const siteId = Number(grn.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(grn.status), to: 'GRN_APPROVED', principal: actor.principal, siteId },
      tx,
    );

    const [gi] = await tx<Row[]>`SELECT received_by FROM gate_inwards WHERE id = ${grn.gate_inward_id as number}`;
    const [qc] = await tx<Row[]>`SELECT inspector_id FROM qc_inspections WHERE id = ${grn.qc_id as number}`;

    if (gi && Number(gi.received_by) === actor.principal.userId) {
      throw forbidden('You received this delivery at the gate, so you cannot also approve the receipt.');
    }
    if (qc && Number(qc.inspector_id) === actor.principal.userId) {
      throw forbidden('You inspected this delivery, so you cannot also approve the receipt.');
    }

    // C-09: refuse rather than over-deliver.
    const excess = await overReceipts(tx, grnId);
    if (excess.length > 0) {
      const detail = excess
        .map(e => `${e.itemCode} by ${e.excess} (ordered ${e.qtyOrdered}, already received ${e.qtyAlreadyReceived})`)
        .join('; ');
      throw conflict(
        `Approving this would receive more than was ordered — ${detail}. Flag the receipt and amend the purchase order first.`,
      );
    }

    const lines = await tx<Row[]>`
      SELECT gl.*, pl.item_id, i.code AS item_code
        FROM grn_lines gl
        JOIN po_lines pl ON pl.id = gl.po_line_id
        JOIN items i     ON i.id = pl.item_id
       WHERE gl.grn_id = ${grnId} ORDER BY gl.id`;

    const entries: number[] = [];

    for (const line of lines) {
      const entryId = await receiveFromGrn(tx, {
        siteId,
        itemId: Number(line.item_id),
        qty: String(line.qty_accepted),
        grnLineId: Number(line.id),
        userId: actor.principal.userId,
        unitValue: String(line.unit_rate),
        locationId: line.location_id === null ? null : Number(line.location_id),
      });

      // The ledger entry is stamped back onto the line, so a balance can always
      // be traced to the receipt that created it.
      await tx`UPDATE grn_lines SET stock_entry_id = ${entryId} WHERE id = ${line.id as number}`;
      entries.push(entryId);

      // A serialised item also enters the asset register, one row per unit, in
      // this same transaction. Non-serialised items mint nothing and this
      // returns empty.
      await mintUnits(
        tx,
        {
          grnLineId: Number(line.id),
          itemId: Number(line.item_id),
          siteId,
          qty: Number(line.qty_accepted),
          locationId: line.location_id === null ? null : Number(line.location_id),
        },
        actor.principal.userId,
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE grns
         SET status = 'GRN_APPROVED', approved_by = ${actor.principal.userId},
             approved_at = now(), updated_at = now()
       WHERE id = ${grnId}
      RETURNING *`;

    await advancePoStatus(tx, Number(grn.po_id));

    await audit(tx, {
      entityType: ENTITY, entityId: grnId, action: 'TRANSITION',
      fromStatus: String(grn.status), toStatus: 'GRN_APPROVED',
      after: { entries, lines: lines.length },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Stock posted — ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
    });

    return { grn: updated, entries };
  });
}

/**
 * Move the PO on once receipts land.
 *
 * Derived from `v_po_line_receipt` rather than counted here: fully received
 * means every line's outstanding quantity is zero, and the view is the only
 * thing that knows that.
 */
async function advancePoStatus(tx: Tx, poId: number): Promise<void> {
  const [row] = await tx<{ outstanding: string; received: string }[]>`
    SELECT coalesce(sum(qty_outstanding), 0)::text AS outstanding,
           coalesce(sum(qty_received), 0)::text    AS received
      FROM v_po_line_receipt WHERE po_id = ${poId}`;

  const [po] = await tx<Row[]>`SELECT status FROM purchase_orders WHERE id = ${poId} FOR UPDATE`;
  if (!po) return;

  const current = String(po.status);
  if (!['PO_CREATED', 'PO_PARTIALLY_RECEIVED'].includes(current)) return;

  const next = Number(row.outstanding) <= 0.0005
    ? 'PO_RECEIVED'
    : Number(row.received) > 0
      ? 'PO_PARTIALLY_RECEIVED'
      : current;

  if (next !== current) {
    await tx`UPDATE purchase_orders SET status = ${next}::po_status, updated_at = now() WHERE id = ${poId}`;
  }
}

// =============================================================================
// Flag, unflag, reject, close
// =============================================================================

/** Park a receipt that cannot be approved as it stands. */
export async function flagGrn(actor: Actor, grnId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) {
    throw badRequest('Flagging a receipt needs a reason — it is what the next person acts on.', 'flag_reason');
  }

  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'grns', grnId);
    if (!current) throw notFound('That goods receipt no longer exists.');

    await assertTransition(
      { entityType: ENTITY, from: current.status, to: 'GRN_FLAGGED', principal: actor.principal, siteId: current.siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE grns SET status = 'GRN_FLAGGED', flag_reason = ${text}, updated_at = now()
       WHERE id = ${grnId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: grnId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'GRN_FLAGGED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

/** Release a flagged receipt back to draft, once whatever it named is settled. */
export async function unflagGrn(actor: Actor, grnId: number, remarks?: string): Promise<Row> {
  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'grns', grnId);
    if (!current) throw notFound('That goods receipt no longer exists.');

    await assertTransition(
      { entityType: ENTITY, from: current.status, to: 'GRN_DRAFT', principal: actor.principal, siteId: current.siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE grns SET status = 'GRN_DRAFT', flag_reason = NULL, updated_at = now()
       WHERE id = ${grnId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: grnId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'GRN_DRAFT',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: remarks?.trim() || 'Flag cleared',
    });

    return updated;
  });
}

/** Refuse the receipt outright. No stock was posted, so none is reversed. */
export async function rejectGrn(actor: Actor, grnId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) {
    throw badRequest('Rejecting a receipt needs a reason.', 'rejection_reason');
  }

  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'grns', grnId);
    if (!current) throw notFound('That goods receipt no longer exists.');

    await assertTransition(
      { entityType: ENTITY, from: current.status, to: 'GRN_REJECTED', principal: actor.principal, siteId: current.siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE grns SET status = 'GRN_REJECTED', rejection_reason = ${text}, updated_at = now()
       WHERE id = ${grnId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: grnId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'GRN_REJECTED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

/** Close a receipt once its invoice is settled. Stock is already posted. */
export async function closeGrn(actor: Actor, grnId: number): Promise<Row> {
  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'grns', grnId);
    if (!current) throw notFound('That goods receipt no longer exists.');

    await assertTransition(
      { entityType: ENTITY, from: current.status, to: 'GRN_CLOSED', principal: actor.principal, siteId: current.siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE grns SET status = 'GRN_CLOSED', updated_at = now() WHERE id = ${grnId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: grnId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'GRN_CLOSED',
      userId: actor.principal.userId, ip: actor.ip,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listGrns(
  principal: Principal,
  filters: { status?: string; poId?: number } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT g.*, s.code AS site_code, s.name AS site_name, po.po_no,
           v.legal_name AS vendor_name, gi.gi_no, gi.challan_no, q.qc_no,
           u.full_name AS approved_by_name,
           (SELECT count(*) FROM grn_lines l WHERE l.grn_id = g.id)                        AS line_count,
           (SELECT coalesce(sum(l.qty_accepted), 0) FROM grn_lines l WHERE l.grn_id = g.id) AS qty_accepted,
           (SELECT coalesce(sum(l.qty_concession), 0) FROM grn_lines l WHERE l.grn_id = g.id) AS qty_concession,
           (SELECT coalesce(sum(round(l.qty_accepted * l.unit_rate, 2)), 0)
              FROM grn_lines l WHERE l.grn_id = g.id)                                       AS value
      FROM grns g
      JOIN sites s             ON s.id = g.site_id
      JOIN purchase_orders po  ON po.id = g.po_id
      JOIN vendors v           ON v.id = po.vendor_id
      LEFT JOIN gate_inwards gi ON gi.id = g.gate_inward_id
      LEFT JOIN qc_inspections q ON q.id = g.qc_id
      LEFT JOIN app_users u    ON u.id = g.approved_by
     WHERE (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR g.status = ${filters.status ?? null}::grn_status)
       AND (${filters.poId ?? null}::bigint IS NULL OR g.po_id = ${filters.poId ?? null})
     ORDER BY g.created_at DESC`;
}

export async function getGrn(id: number): Promise<{ grn: Row; lines: Row[]; excess: OverReceipt[] }> {
  const [grn] = await sql<Row[]>`
    SELECT g.*, s.code AS site_code, s.name AS site_name, po.po_no, po.id AS po_id,
           v.legal_name AS vendor_name, gi.gi_no, gi.id AS gate_inward_id, gi.challan_no,
           gi.vehicle_no, gi.received_by, ru.full_name AS received_by_name,
           q.qc_no, q.id AS qc_id, q.inspector_id, iu.full_name AS inspector_name,
           u.full_name AS approved_by_name
      FROM grns g
      JOIN sites s              ON s.id = g.site_id
      JOIN purchase_orders po   ON po.id = g.po_id
      JOIN vendors v            ON v.id = po.vendor_id
      LEFT JOIN gate_inwards gi ON gi.id = g.gate_inward_id
      LEFT JOIN app_users ru    ON ru.id = gi.received_by
      LEFT JOIN qc_inspections q ON q.id = g.qc_id
      LEFT JOIN app_users iu    ON iu.id = q.inspector_id
      LEFT JOIN app_users u     ON u.id = g.approved_by
     WHERE g.id = ${id}`;

  if (!grn) throw notFound('That goods receipt no longer exists.');

  const lines = await sql<Row[]>`
    SELECT gl.*, i.code AS item_code, i.name AS item_name, i.uom,
           pl.qty_ordered, loc.code AS location_code,
           round(gl.qty_accepted * gl.unit_rate, 2) AS line_value,
           r.qty_received, r.qty_outstanding
      FROM grn_lines gl
      JOIN po_lines pl              ON pl.id = gl.po_line_id
      JOIN items i                  ON i.id = pl.item_id
      LEFT JOIN storage_locations loc ON loc.id = gl.location_id
      LEFT JOIN v_po_line_receipt r ON r.po_line_id = gl.po_line_id
     WHERE gl.grn_id = ${id} ORDER BY gl.id`;

  const excess = await inTransaction(tx => overReceipts(tx, id));

  return { grn, lines, excess };
}
