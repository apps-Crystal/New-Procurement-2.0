/**
 * Shortfall cases (brief §16).
 *
 * PENDING → AWAIT_BALANCE   the vendor still owes it; the PO stays open
 *         → SHORT_CLOSE     write the balance off the order and close it
 *
 * A shortfall is a gate fact: the challan claimed one quantity and the count
 * found another. It is raised when the consignment is handed to QC, before
 * anybody looks at quality, because whether the goods are *good* is a separate
 * question from whether they are *all there*.
 *
 * `gate_inward_lines.qty_short` is a generated column —
 * `greatest(qty_per_challan - qty_counted, 0)` — so a case can never claim a
 * shortfall that the count does not support. This module reads it; it never
 * computes its own.
 *
 * `shortfall_cases.gate_inward_line_id` is UNIQUE, so one line raises at most
 * one case however many times the handover is retried.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { badRequest, notFound } from '@/lib/errors';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'SHORTFALL';

/**
 * Raise a case for every short line on a gate inward.
 *
 * Runs inside the caller's transaction — it is part of handing over to QC, not
 * a separate action someone could forget. Idempotent by the unique index: a
 * re-run inserts nothing and returns what already exists.
 */
export async function raiseShortfalls(tx: Tx, giId: number, actor: Actor): Promise<Row[]> {
  const [gi] = await tx<Row[]>`SELECT id, site_id, gi_no FROM gate_inwards WHERE id = ${giId}`;
  if (!gi) throw notFound('That gate inward no longer exists.');

  const short = await tx<Row[]>`
    SELECT l.id, l.po_line_id, l.qty_short, i.code AS item_code
      FROM gate_inward_lines l
      JOIN po_lines pl ON pl.id = l.po_line_id
      JOIN items i     ON i.id = pl.item_id
     WHERE l.gate_inward_id = ${giId}
       AND l.qty_short > 0
       AND NOT EXISTS (SELECT 1 FROM shortfall_cases c WHERE c.gate_inward_line_id = l.id)
     ORDER BY l.id`;

  const raised: Row[] = [];

  for (const line of short) {
    const shtNo = await nextDocumentNoForSite(tx, 'SHT', Number(gi.site_id));

    const [created] = await tx<Row[]>`
      INSERT INTO shortfall_cases (sht_no, gate_inward_line_id, po_line_id, qty_short, decision)
      VALUES (${shtNo}, ${line.id as number}, ${line.po_line_id as number}, ${line.qty_short as string}::numeric, 'PENDING')
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(created.id), action: 'CREATE',
      after: { sht_no: shtNo, item: line.item_code, qty_short: line.qty_short, gate_inward: gi.gi_no },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Short by ${line.qty_short} against the challan`,
    });

    raised.push(created);
  }

  return raised;
}

// =============================================================================
// Decide
// =============================================================================

export type ShortfallDecision = 'AWAIT_BALANCE' | 'SHORT_CLOSE';

/**
 * Decide what happens to the missing quantity.
 *
 * AWAIT_BALANCE leaves the order open, so `v_po_line_receipt.qty_outstanding`
 * keeps showing the gap and the delivery stays on the expected list.
 * SHORT_CLOSE accepts that it will never arrive.
 *
 * Neither writes stock: nothing arrived, so there is nothing to post. What
 * changes is what the buyer is still waiting for.
 */
export async function decideShortfall(
  actor: Actor,
  caseId: number,
  decision: ShortfallDecision,
  remarks?: string,
): Promise<Row> {
  return inTransaction(async tx => {
    const [current] = await tx<Row[]>`
      SELECT c.*, g.site_id, g.gi_no
        FROM shortfall_cases c
        JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
        JOIN gate_inwards g      ON g.id = l.gate_inward_id
       WHERE c.id = ${caseId}
       FOR UPDATE OF c`;

    if (!current) throw notFound('That shortfall case no longer exists.');

    const siteId = Number(current.site_id);

    await assertTransition(
      {
        entityType: ENTITY, from: String(current.decision), to: decision,
        principal: actor.principal, siteId,
      },
      tx,
    );

    const text = remarks?.trim() || null;
    if (decision === 'SHORT_CLOSE' && !text) {
      throw badRequest(
        'Short-closing writes the balance off the order, so it needs a reason.',
        'remarks',
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE shortfall_cases
         SET decision = ${decision}::shortfall_decision,
             decided_by = ${actor.principal.userId},
             decided_at = now(),
             closed_at = ${decision === 'SHORT_CLOSE' ? sql`now()` : null}
       WHERE id = ${caseId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: caseId, action: 'TRANSITION',
      fromStatus: String(current.decision), toStatus: decision,
      userId: actor.principal.userId, ip: actor.ip,
      remarks: text ?? (decision === 'AWAIT_BALANCE' ? 'Vendor still owes the balance' : null),
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listShortfalls(
  principal: Principal,
  filters: { decision?: string; poId?: number } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT c.*, g.gi_no, g.site_id, g.challan_no, g.arrived_at,
           s.code AS site_code, s.name AS site_name,
           po.po_no, po.id AS po_id, v.legal_name AS vendor_name,
           i.code AS item_code, i.name AS item_name, i.uom,
           l.qty_per_challan, l.qty_counted,
           u.full_name AS decided_by_name
      FROM shortfall_cases c
      JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
      JOIN gate_inwards g      ON g.id = l.gate_inward_id
      JOIN sites s             ON s.id = g.site_id
      JOIN po_lines pl         ON pl.id = c.po_line_id
      JOIN purchase_orders po  ON po.id = pl.po_id
      JOIN vendors v           ON v.id = po.vendor_id
      JOIN items i             ON i.id = pl.item_id
      LEFT JOIN app_users u    ON u.id = c.decided_by
     WHERE (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND (${filters.decision ?? null}::text IS NULL
            OR c.decision = ${filters.decision ?? null}::shortfall_decision)
       AND (${filters.poId ?? null}::bigint IS NULL OR po.id = ${filters.poId ?? null})
     ORDER BY c.created_at DESC`;
}

export async function getShortfall(id: number): Promise<Row> {
  const [row] = await sql<Row[]>`
    SELECT c.*, g.gi_no, g.challan_no, po.po_no, i.code AS item_code, i.name AS item_name, i.uom,
           l.qty_per_challan, l.qty_counted, u.full_name AS decided_by_name
      FROM shortfall_cases c
      JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
      JOIN gate_inwards g      ON g.id = l.gate_inward_id
      JOIN po_lines pl         ON pl.id = c.po_line_id
      JOIN purchase_orders po  ON po.id = pl.po_id
      JOIN items i             ON i.id = pl.item_id
      LEFT JOIN app_users u    ON u.id = c.decided_by
     WHERE c.id = ${id}`;

  if (!row) throw notFound('That shortfall case no longer exists.');
  return row;
}
