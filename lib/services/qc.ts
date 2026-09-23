/**
 * QA/QC inspection (brief §13).
 *
 * QC_PENDING → QC_IN_PROGRESS → QC_COMPLETED → (re-inspection) → QC_IN_PROGRESS
 *
 * The verdict per line is a three-way split: accepted, conditional hold, and
 * rejected. The schema keeps it honest:
 *
 *   qc_lines_sum     CHECK — accepted + hold + rejected = delivered
 *   qc_lines_reason  CHECK — a hold or a rejection carries a reason code
 *   qc_inspections_segregation  TRIGGER — the inspector is not the receiver
 *
 * Three decisions this module makes that the schema cannot:
 *
 *   C-10  `qty_delivered` is copied from `gate_inward_lines.qty_counted` and is
 *         never accepted from the client. The schema constrains the internal sum
 *         but nothing ties it to the gate count, so an inspector could otherwise
 *         inspect a quantity nobody delivered.
 *
 *   C-11  On a cold-chain breach, a line cannot simply be accepted. Everything
 *         goes to hold, and a Site Manager decides concession or rejection. A
 *         line may only carry `qty_accepted > 0` on a breach if a hold decision
 *         already exists for it — which is how a re-inspection after rework is
 *         able to pass.
 *
 *   C-02  A re-inspection is a NEW row chained by `is_reinspection_of`, not an
 *         edit of the original. The supplied schema made that unreachable; the
 *         amendment replaced the column UNIQUE with a partial unique index, so
 *         one original and unlimited re-inspections now coexist. The original
 *         verdict survives, which §29 requires.
 *
 * Hold quantity is NOT folded into acceptance here. `qc_lines` keeps the split
 * as inspected; the concession is a separate `qc_hold_decisions` row, and the
 * GRN is where the two combine — which is why `grn_lines.qty_accepted` carries
 * the schema comment "includes concession qty".
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { coldChainBand } from '@/lib/services/gate-inward';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'GATE_INWARD'; // QC drives the gate inward's status machine

/** SLA from the brief: four hours for cold chain, forty-eight for ambient. */
const SLA_HOURS_COLD = 4;
const SLA_HOURS_AMBIENT = 48;

/**
 * Reason code on a line that has not been inspected yet.
 *
 * A new line parks the whole counted quantity in `qty_hold`, because
 * `qc_lines_sum` has to balance from the first insert and nothing has been
 * accepted yet. But `qc_lines_reason` then demands a reason code, so this
 * sentinel stands in until a real verdict replaces it.
 *
 * It also marks "not yet looked at" apart from "held pending a decision" —
 * without that distinction every fresh inspection would flood the Site
 * Manager's hold queue with lines nobody has examined.
 */
const NOT_YET_INSPECTED = 'PENDING_INSPECTION';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with inspections.');
  }
}

async function loadInspection(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM qc_inspections WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM qc_inspections WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That inspection no longer exists.');
  return rows[0];
}

// =============================================================================
// Start
// =============================================================================

/**
 * Open an inspection against a gate inward.
 *
 * One line per gate-inward line, each stamped with the item class's CURRENT
 * checklist version. Stamping the version rather than pointing at "the current
 * one" is what lets a verdict be re-read years later against the checklist that
 * was actually applied.
 */
export async function startInspection(actor: Actor, giId: number): Promise<{ qc: Row; lines: Row[] }> {
  return inTransaction(async tx => {
    const [gi] = await tx<Row[]>`SELECT * FROM gate_inwards WHERE id = ${giId} FOR UPDATE`;
    if (!gi) throw notFound('That gate inward no longer exists.');

    const siteId = Number(gi.site_id);
    requirePermission(actor, 'QC.START', siteId);

    await assertTransition(
      { entityType: ENTITY, from: String(gi.status), to: 'QC_IN_PROGRESS', principal: actor.principal, siteId },
      tx,
    );

    // The trigger enforces this, but its message names no one. Ours does.
    if (Number(gi.received_by) === actor.principal.userId) {
      throw forbidden(
        'You logged this delivery in at the gate, so somebody else has to inspect it.',
      );
    }

    const giLines = await tx<Row[]>`
      SELECT l.*, pl.item_id, i.item_class_id, i.code AS item_code, c.is_cold_chain
        FROM gate_inward_lines l
        JOIN po_lines pl    ON pl.id = l.po_line_id
        JOIN items i        ON i.id = pl.item_id
        JOIN item_classes c ON c.id = i.item_class_id
       WHERE l.gate_inward_id = ${giId} ORDER BY l.id`;

    if (giLines.length === 0) {
      throw conflict('That gate inward has no lines to inspect.');
    }

    const anyCold = giLines.some(l => l.is_cold_chain === true);
    const slaHours = anyCold ? SLA_HOURS_COLD : SLA_HOURS_AMBIENT;

    const qcNo = await nextDocumentNoForSite(tx, 'QC', siteId);

    const [qc] = await tx<Row[]>`
      INSERT INTO qc_inspections (qc_no, gate_inward_id, inspector_id, sla_due_at)
      VALUES (${qcNo}, ${giId}, ${actor.principal.userId},
              now() + ${`${slaHours} hours`}::interval)
      RETURNING *`;

    const created = await createLinesFor(tx, Number(qc.id), giLines);

    await tx`UPDATE gate_inwards SET status = 'QC_IN_PROGRESS', updated_at = now() WHERE id = ${giId}`;

    await audit(tx, {
      entityType: ENTITY, entityId: giId, action: 'TRANSITION',
      fromStatus: String(gi.status), toStatus: 'QC_IN_PROGRESS',
      after: { qc_no: qcNo, lines: created.length, sla_hours: slaHours },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Inspection ${qcNo} opened — ${slaHours} hour SLA`,
    });

    return { qc, lines: created };
  });
}

/**
 * One QC line per gate-inward line.
 *
 * `qty_delivered` comes from `qty_counted` and from nowhere else (C-10). The
 * whole counted quantity starts in `qty_hold`, not in `qty_accepted`: nothing
 * has been inspected yet, so nothing has been accepted yet, and the schema's sum
 * constraint has to balance from the first insert.
 */
async function createLinesFor(tx: Tx, qcId: number, giLines: Row[]): Promise<Row[]> {
  const out: Row[] = [];

  for (const line of giLines) {
    const [checklist] = await tx<Row[]>`
      SELECT id, version FROM qc_checklists
       WHERE item_class_id = ${line.item_class_id as number} AND is_current`;

    if (!checklist) {
      throw conflict(
        `No current QC checklist exists for ${line.item_code}'s item class. Add one before inspecting it.`,
      );
    }

    const [created] = await tx<Row[]>`
      INSERT INTO qc_lines (qc_id, gate_inward_line_id, checklist_id,
                            qty_delivered, qty_accepted, qty_hold, qty_rejected, reason_code)
      VALUES (${qcId}, ${line.id as number}, ${checklist.id as number},
              ${line.qty_counted as string}::numeric, 0, ${line.qty_counted as string}::numeric, 0,
              ${NOT_YET_INSPECTED})
      RETURNING *`;

    out.push(created);
  }

  return out;
}

// =============================================================================
// Record a verdict
// =============================================================================

export interface QcLineVerdict {
  qcLineId: number;
  qtyAccepted: string;
  qtyHold: string;
  qtyRejected: string;
  reasonCode?: string | null;
  remarks?: string | null;
  checks?: { pointId: number; result: 'PASS' | 'FAIL' | 'NA'; note?: string | null }[];
}

/**
 * Record what the inspector found on one line.
 *
 * The sum rule and the reason rule are CHECK constraints, so they are stated
 * here only to name the line in the message — the database is what refuses.
 */
export async function recordVerdict(actor: Actor, qcId: number, verdict: QcLineVerdict): Promise<Row> {
  return inTransaction(async tx => {
    const qc = await loadInspection(tx, qcId, true);

    const [gi] = await tx<Row[]>`SELECT * FROM gate_inwards WHERE id = ${qc.gate_inward_id as number}`;
    const siteId = Number(gi.site_id);
    requirePermission(actor, 'QC.EDIT', siteId);

    if (qc.completed_at !== null) {
      throw conflict('This inspection is complete. Open a re-inspection to change a verdict.');
    }

    const [line] = await tx<Row[]>`
      SELECT q.*, i.code AS item_code
        FROM qc_lines q
        JOIN gate_inward_lines l ON l.id = q.gate_inward_line_id
        JOIN po_lines pl         ON pl.id = l.po_line_id
        JOIN items i             ON i.id = pl.item_id
       WHERE q.id = ${verdict.qcLineId} AND q.qc_id = ${qcId}
       FOR UPDATE OF q`;

    if (!line) throw notFound('That inspection line is not part of this inspection.');

    const accepted = Number(verdict.qtyAccepted);
    const hold = Number(verdict.qtyHold);
    const rejected = Number(verdict.qtyRejected);
    const delivered = Number(line.qty_delivered);

    // The CHECK would catch it; naming the item and the gap is more use.
    if (Math.abs(accepted + hold + rejected - delivered) > 0.0005) {
      throw badRequest(
        `${line.item_code}: accepted, held and rejected must add up to the ${delivered} delivered — these add up to ${accepted + hold + rejected}.`,
        'qty_accepted',
      );
    }

    if ((hold > 0 || rejected > 0) && !verdict.reasonCode?.trim()) {
      throw badRequest(
        `${line.item_code}: anything held or rejected needs a reason code.`,
        'reason_code',
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE qc_lines
         SET qty_accepted = ${verdict.qtyAccepted}::numeric,
             qty_hold     = ${verdict.qtyHold}::numeric,
             qty_rejected = ${verdict.qtyRejected}::numeric,
             reason_code  = ${verdict.reasonCode?.trim() || null},
             remarks      = ${verdict.remarks?.trim() || null}
       WHERE id = ${verdict.qcLineId}
      RETURNING *`;

    // Checklist results are replaced wholesale — a partial update would leave
    // points from a previous pass standing next to this one's.
    if (verdict.checks) {
      await tx`DELETE FROM qc_line_checks WHERE qc_line_id = ${verdict.qcLineId}`;
      for (const check of verdict.checks) {
        await tx`
          INSERT INTO qc_line_checks (qc_line_id, point_id, result, note)
          VALUES (${verdict.qcLineId}, ${check.pointId}, ${check.result}::checklist_result,
                  ${check.note?.trim() || null})`;
      }
    }

    await audit(tx, {
      entityType: 'QC_LINE', entityId: verdict.qcLineId, action: 'UPDATE',
      before: {
        accepted: line.qty_accepted, hold: line.qty_hold, rejected: line.qty_rejected,
      },
      after: { accepted, hold, rejected, reason: verdict.reasonCode ?? null },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `${line.item_code}: ${accepted} accepted, ${hold} held, ${rejected} rejected`,
    });

    return updated;
  });
}

// =============================================================================
// Complete
// =============================================================================

/**
 * Close the inspection.
 *
 * Two gates beyond the per-line rules, both from conflict C-11:
 *
 *   A cold-chain breach cannot be accepted away. Where `temp_in_tolerance` is
 *   false, no line may carry an accepted quantity unless a Site Manager has
 *   already granted a concession for it.
 *
 *   Where the cargo's class requires a data logger, the logger file must be
 *   attached to the gate inward before a verdict can be submitted. A reefer
 *   reading is one moment; the logger is the journey.
 */
export async function completeInspection(actor: Actor, qcId: number): Promise<Row> {
  return inTransaction(async tx => {
    const qc = await loadInspection(tx, qcId, true);

    const [gi] = await tx<Row[]>`
      SELECT * FROM gate_inwards WHERE id = ${qc.gate_inward_id as number} FOR UPDATE`;
    const siteId = Number(gi.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(gi.status), to: 'QC_COMPLETED', principal: actor.principal, siteId },
      tx,
    );

    if (qc.completed_at !== null) {
      throw conflict('This inspection is already complete.');
    }

    const lines = await tx<Row[]>`
      SELECT q.*, i.code AS item_code, l.po_line_id,
             EXISTS (SELECT 1 FROM qc_hold_decisions d WHERE d.qc_line_id = q.id) AS has_decision
        FROM qc_lines q
        JOIN gate_inward_lines l ON l.id = q.gate_inward_line_id
        JOIN po_lines pl         ON pl.id = l.po_line_id
        JOIN items i             ON i.id = pl.item_id
       WHERE q.qc_id = ${qcId} ORDER BY q.id`;

    const uninspected = lines.filter(l => l.reason_code === NOT_YET_INSPECTED);
    if (uninspected.length > 0) {
      throw badRequest(
        `${uninspected.map(l => l.item_code).join(', ')} ${uninspected.length === 1 ? 'has' : 'have'} not been inspected yet.`,
      );
    }

    // C-11, first gate: a breach cannot be accepted away.
    if (gi.temp_in_tolerance === false) {
      const accepted = lines.filter(l => Number(l.qty_accepted) > 0 && l.has_decision !== true);
      if (accepted.length > 0) {
        throw conflict(
          `The reefer ran at ${gi.reefer_actual_c} °C, outside the band for this cargo. ${accepted
            .map(l => l.item_code)
            .join(', ')} cannot be accepted on this inspection — hold the quantity and let a site manager decide it.`,
        );
      }
    }

    // C-11, second gate: a data-logger class needs its logger attached.
    const band = await coldChainBand(tx, lines.map(l => Number(l.po_line_id)));
    if (band.requiresDataLogger) {
      const [logger] = await tx<Row[]>`
        SELECT id FROM documents
         WHERE entity_type = 'GATE_INWARD' AND entity_id = ${gi.id as number} AND doc_type = 'DATA_LOGGER'`;
      if (!logger) {
        throw conflict(
          `${band.classes.join(', ')} requires a data logger file. Attach it to the gate inward before completing the inspection.`,
        );
      }
    }

    const [updated] = await tx<Row[]>`
      UPDATE qc_inspections SET completed_at = now() WHERE id = ${qcId} RETURNING *`;

    await tx`UPDATE gate_inwards SET status = 'QC_COMPLETED', updated_at = now() WHERE id = ${gi.id as number}`;

    const totals = lines.reduce<{ accepted: number; hold: number; rejected: number }>(
      (acc, l) => ({
        accepted: acc.accepted + Number(l.qty_accepted),
        hold: acc.hold + Number(l.qty_hold),
        rejected: acc.rejected + Number(l.qty_rejected),
      }),
      { accepted: 0, hold: 0, rejected: 0 },
    );

    await audit(tx, {
      entityType: ENTITY, entityId: Number(gi.id), action: 'TRANSITION',
      fromStatus: String(gi.status), toStatus: 'QC_COMPLETED',
      after: { qc_no: qc.qc_no, ...totals },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `${totals.accepted} accepted, ${totals.hold} held, ${totals.rejected} rejected`,
    });

    return updated;
  });
}

// =============================================================================
// Conditional hold decisions
// =============================================================================

/**
 * A Site Manager decides what happens to held stock.
 *
 * CONCESSION  take it anyway, at the buyer's risk — the quantity joins the GRN
 *             as `qty_concession`, visible rather than merged into acceptance
 * REJECT      it goes back to the vendor as a purchase return
 *
 * `qc_hold_decisions.qc_line_id` is UNIQUE, so a held line is decided once. The
 * decision is not the inspector's to make, which is why the permission is
 * `QC.HOLD_DECIDE` and belongs to CG_SMGR alone.
 */
export async function decideHold(
  actor: Actor,
  qcLineId: number,
  decision: 'CONCESSION' | 'REJECT',
  qty: string,
  reason: string,
): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) {
    throw badRequest('A hold decision needs a reason — it is the record of who accepted the risk.', 'reason');
  }

  return inTransaction(async tx => {
    const [line] = await tx<Row[]>`
      SELECT q.*, g.site_id, g.id AS gate_inward_id, i.code AS item_code, qi.inspector_id
        FROM qc_lines q
        JOIN qc_inspections qi   ON qi.id = q.qc_id
        JOIN gate_inward_lines l ON l.id = q.gate_inward_line_id
        JOIN gate_inwards g      ON g.id = l.gate_inward_id
        JOIN po_lines pl         ON pl.id = l.po_line_id
        JOIN items i             ON i.id = pl.item_id
       WHERE q.id = ${qcLineId}
       FOR UPDATE OF q`;

    if (!line) throw notFound('That inspection line no longer exists.');

    const siteId = Number(line.site_id);
    requirePermission(actor, 'QC.HOLD_DECIDE', siteId);

    // The inspector found the problem; someone else carries the decision.
    if (Number(line.inspector_id) === actor.principal.userId) {
      throw forbidden('You inspected this line, so the hold decision is somebody else’s to make.');
    }

    if (String(line.reason_code) === NOT_YET_INSPECTED) {
      throw conflict(`${line.item_code} has not been inspected yet — there is no verdict to decide on.`);
    }

    if (Number(line.qty_hold) <= 0) {
      throw conflict(`${line.item_code} has nothing on hold to decide.`);
    }

    if (Number(qty) <= 0 || Number(qty) > Number(line.qty_hold)) {
      throw badRequest(
        `${line.item_code} has ${line.qty_hold} on hold — the decision cannot cover ${qty}.`,
        'qty',
      );
    }

    const [existing] = await tx<Row[]>`
      SELECT id FROM qc_hold_decisions WHERE qc_line_id = ${qcLineId}`;
    if (existing) {
      throw conflict(`${line.item_code}'s hold has already been decided.`);
    }

    const [created] = await tx<Row[]>`
      INSERT INTO qc_hold_decisions (qc_line_id, decision, qty, reason, decided_by)
      VALUES (${qcLineId}, ${decision}::hold_decision, ${qty}::numeric, ${text}, ${actor.principal.userId})
      RETURNING *`;

    await audit(tx, {
      entityType: 'QC_LINE', entityId: qcLineId,
      // A concession takes material that failed inspection, which is precisely
      // what OVERRIDE is for under §29 — it should stand out in the trail.
      // Rejecting held stock is the ordinary outcome, so it does not.
      action: decision === 'CONCESSION' ? 'OVERRIDE' : 'UPDATE',
      after: { decision, qty, reason: text },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `${line.item_code}: ${decision.toLowerCase()} on ${qty} held`,
    });

    return created;
  });
}

// =============================================================================
// Re-inspection (conflict C-02)
// =============================================================================

/**
 * Open a re-inspection chained off a completed one.
 *
 * A new `qc_inspections` row, not an edit: the original verdict is evidence and
 * survives. The partial unique index added by amendment C-02 permits exactly
 * this — one inspection with `is_reinspection_of IS NULL` per gate inward, and
 * any number chained behind it.
 */
export async function reinspect(actor: Actor, qcId: number): Promise<{ qc: Row; lines: Row[] }> {
  return inTransaction(async tx => {
    const original = await loadInspection(tx, qcId, true);

    const [gi] = await tx<Row[]>`
      SELECT * FROM gate_inwards WHERE id = ${original.gate_inward_id as number} FOR UPDATE`;
    const siteId = Number(gi.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(gi.status), to: 'QC_IN_PROGRESS', principal: actor.principal, siteId },
      tx,
    );

    if (original.completed_at === null) {
      throw conflict('That inspection is still open — finish it before re-inspecting.');
    }

    if (Number(gi.received_by) === actor.principal.userId) {
      throw forbidden('You logged this delivery in at the gate, so somebody else has to inspect it.');
    }

    // A re-inspection covers the same gate-inward lines, so the counted
    // quantities carry over unchanged — what is being re-judged is quality.
    const giLines = await tx<Row[]>`
      SELECT l.*, pl.item_id, i.item_class_id, i.code AS item_code, c.is_cold_chain
        FROM gate_inward_lines l
        JOIN po_lines pl    ON pl.id = l.po_line_id
        JOIN items i        ON i.id = pl.item_id
        JOIN item_classes c ON c.id = i.item_class_id
       WHERE l.gate_inward_id = ${gi.id as number} ORDER BY l.id`;

    const anyCold = giLines.some(l => l.is_cold_chain === true);
    const qcNo = await nextDocumentNoForSite(tx, 'QC', siteId);

    const [qc] = await tx<Row[]>`
      INSERT INTO qc_inspections (qc_no, gate_inward_id, inspector_id, sla_due_at, is_reinspection_of)
      VALUES (${qcNo}, ${gi.id as number}, ${actor.principal.userId},
              now() + ${`${anyCold ? SLA_HOURS_COLD : SLA_HOURS_AMBIENT} hours`}::interval,
              ${qcId})
      RETURNING *`;

    // The earlier inspection's lines stay exactly as they were. That is only
    // possible because migration 0004 rescoped `qc_lines`' uniqueness to
    // (qc_id, gate_inward_line_id) — see conflict C-26. Under the supplied
    // schema this insert collided with the original verdict, and the only way
    // through would have been to destroy it.
    const created = await createLinesFor(tx, Number(qc.id), giLines);

    await tx`UPDATE gate_inwards SET status = 'QC_IN_PROGRESS', updated_at = now() WHERE id = ${gi.id as number}`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(gi.id), action: 'TRANSITION',
      fromStatus: String(gi.status), toStatus: 'QC_IN_PROGRESS',
      after: { qc_no: qcNo, reinspection_of: original.qc_no },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Re-inspection ${qcNo}, following ${original.qc_no}`,
    });

    return { qc, lines: created };
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listInspections(
  principal: Principal,
  filters: { open?: boolean; overdue?: boolean } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT q.*, g.gi_no, g.site_id, g.status AS gi_status, g.challan_no, g.arrived_at,
           g.temp_in_tolerance, g.reefer_actual_c,
           s.code AS site_code, s.name AS site_name, po.po_no,
           v.legal_name AS vendor_name, u.full_name AS inspector_name,
           orig.qc_no AS reinspection_of_no,
           (SELECT count(*) FROM qc_lines l WHERE l.qc_id = q.id)                    AS line_count,
           (SELECT coalesce(sum(l.qty_hold), 0) FROM qc_lines l WHERE l.qc_id = q.id) AS qty_hold,
           q.sla_due_at < now() AND q.completed_at IS NULL                            AS overdue
      FROM qc_inspections q
      JOIN gate_inwards g      ON g.id = q.gate_inward_id
      JOIN sites s             ON s.id = g.site_id
      JOIN purchase_orders po  ON po.id = g.po_id
      JOIN vendors v           ON v.id = po.vendor_id
      JOIN app_users u         ON u.id = q.inspector_id
      LEFT JOIN qc_inspections orig ON orig.id = q.is_reinspection_of
     WHERE (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND (${filters.open ?? null}::boolean IS NULL OR (q.completed_at IS NULL) = ${filters.open ?? null})
       AND (${filters.overdue ?? null}::boolean IS NULL
            OR (q.sla_due_at < now() AND q.completed_at IS NULL) = ${filters.overdue ?? null})
     ORDER BY q.sla_due_at`;
}

export async function getInspection(id: number): Promise<{ qc: Row; lines: Row[]; points: Row[] }> {
  const [qc] = await sql<Row[]>`
    SELECT q.*, g.gi_no, g.id AS gate_inward_id, g.site_id, g.status AS gi_status,
           g.challan_no, g.vehicle_no, g.arrived_at, g.temp_in_tolerance,
           g.reefer_set_point_c, g.reefer_actual_c, g.received_by,
           s.name AS site_name, po.po_no, po.id AS po_id, v.legal_name AS vendor_name,
           u.full_name AS inspector_name, orig.qc_no AS reinspection_of_no,
           q.sla_due_at < now() AND q.completed_at IS NULL AS overdue
      FROM qc_inspections q
      JOIN gate_inwards g     ON g.id = q.gate_inward_id
      JOIN sites s            ON s.id = g.site_id
      JOIN purchase_orders po ON po.id = g.po_id
      JOIN vendors v          ON v.id = po.vendor_id
      JOIN app_users u        ON u.id = q.inspector_id
      LEFT JOIN qc_inspections orig ON orig.id = q.is_reinspection_of
     WHERE q.id = ${id}`;

  if (!qc) throw notFound('That inspection no longer exists.');

  const lines = await sql<Row[]>`
    SELECT q.*, i.code AS item_code, i.name AS item_name, i.uom,
           cl.version AS checklist_version, cl.id AS checklist_id,
           c.code AS item_class_code, c.is_cold_chain,
           d.decision AS hold_decision, d.qty AS hold_decision_qty,
           d.reason AS hold_decision_reason, du.full_name AS hold_decided_by_name
      FROM qc_lines q
      JOIN qc_checklists cl        ON cl.id = q.checklist_id
      LEFT JOIN gate_inward_lines l ON l.id = q.gate_inward_line_id
      LEFT JOIN po_lines pl        ON pl.id = l.po_line_id
      LEFT JOIN items i            ON i.id = pl.item_id
      LEFT JOIN item_classes c     ON c.id = i.item_class_id
      LEFT JOIN qc_hold_decisions d ON d.qc_line_id = q.id
      LEFT JOIN app_users du       ON du.id = d.decided_by
     WHERE q.qc_id = ${id} ORDER BY q.id`;

  // Checklist points for every version stamped on this inspection's lines, so
  // a mixed-class consignment renders each line against its own checklist.
  const checklistIds = [...new Set(lines.map(l => Number(l.checklist_id)))];
  const points = checklistIds.length
    ? await sql<Row[]>`
        SELECT p.*, c.version, c.item_class_id
          FROM qc_checklist_points p
          JOIN qc_checklists c ON c.id = p.checklist_id
         WHERE p.checklist_id = ANY(${checklistIds})
         ORDER BY p.checklist_id, p.point_no`
    : [];

  return { qc, lines, points };
}

/** Held lines awaiting a Site Manager's decision. */
export function pendingHolds(principal: Principal): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT q.id AS qc_line_id, q.qty_hold, q.reason_code, q.remarks,
           qi.id AS qc_id, qi.qc_no, qi.inspector_id, qi.completed_at,
           g.gi_no, g.site_id, s.name AS site_name,
           i.code AS item_code, i.name AS item_name, i.uom,
           po.po_no, v.legal_name AS vendor_name
      FROM qc_lines q
      JOIN qc_inspections qi   ON qi.id = q.qc_id
      JOIN gate_inward_lines l ON l.id = q.gate_inward_line_id
      JOIN gate_inwards g      ON g.id = l.gate_inward_id
      JOIN sites s             ON s.id = g.site_id
      JOIN po_lines pl         ON pl.id = l.po_line_id
      JOIN purchase_orders po  ON po.id = pl.po_id
      JOIN vendors v           ON v.id = po.vendor_id
      JOIN items i             ON i.id = pl.item_id
     WHERE q.qty_hold > 0
       -- A line still carrying the sentinel has not been inspected, so it is
       -- not a hold awaiting anybody's judgement.
       AND q.reason_code IS DISTINCT FROM ${NOT_YET_INSPECTED}
       AND NOT EXISTS (SELECT 1 FROM qc_hold_decisions d WHERE d.qc_line_id = q.id)
       AND (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
     ORDER BY qi.sla_due_at`;
}
