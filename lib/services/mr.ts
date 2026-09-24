/**
 * Material request — the head of the procurement chain (brief §4).
 *
 * MR_DRAFT → stock check → one of three outcomes:
 *
 *   fully available    → transfer, MR_FULFILLED_INTERNAL, no purchase
 *   partially          → transfer for what exists, declare + purchase the rest
 *   not available      → declare → approve → PR
 *
 * Two things the schema settles and this module obeys:
 *
 * `mr_lines.qty_purchase` is GENERATED ALWAYS AS (qty_requested - qty_transfer).
 * It cannot be written. The prototype let the frontend compute transfer and
 * purchase independently; here you set `qty_transfer` and the purchase balance
 * follows. Brief §4 is explicit that the frontend must not persist a
 * contradictory pair.
 *
 * The budget code lives on the DECLARATION, not the MR header — conflict
 * register C-05. `material_requests` has no budget_code_id column at all. An MR
 * met entirely by transfer never needs one.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { normaliseText } from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';

const ENTITY = 'MR';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with material requests.');
  }
}

async function loadMr(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM material_requests WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM material_requests WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That material request no longer exists.');
  return rows[0];
}

/** Statuses after which the lines are settled and must not move. */
const LINES_FROZEN = new Set([
  'MR_DECLARED', 'MR_APPROVED', 'MR_REJECTED',
  'MR_CONVERTED_TO_PR', 'MR_FULFILLED_INTERNAL', 'MR_CANCELLED',
]);

// =============================================================================
// Create and edit
// =============================================================================

export interface MrLineInput {
  itemId: number;
  qtyRequested: string;
}

export interface MrInput {
  siteId: number;
  category: string;
  requiredBy: string;
  urgency: string;
  lines: MrLineInput[];
}

export async function createMr(actor: Actor, input: MrInput): Promise<Row> {
  requirePermission(actor, 'MR.CREATE', input.siteId);

  if (input.lines.length === 0) {
    throw badRequest('A material request needs at least one line.', 'lines');
  }

  return inTransaction(async tx => {
    const mrNo = await nextDocumentNoForSite(tx, ENTITY, input.siteId);

    const [mr] = await tx<Row[]>`
      INSERT INTO material_requests (mr_no, site_id, category, required_by, urgency, status, requester_id)
      VALUES (${mrNo}, ${input.siteId}, ${input.category}::category_code, ${input.requiredBy}::date,
              ${input.urgency}::urgency_code, 'MR_DRAFT', ${actor.principal.userId})
      RETURNING *`;

    await insertLines(tx, Number(mr.id), input.lines);

    await audit(tx, {
      entityType: ENTITY, entityId: Number(mr.id), action: 'CREATE',
      after: { mr_no: mrNo, site_id: input.siteId, lines: input.lines.length },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return mr;
  });
}

async function insertLines(tx: Tx, mrId: number, lines: MrLineInput[]) {
  const seen = new Set<number>();

  for (const [i, line] of lines.entries()) {
    if (seen.has(line.itemId)) {
      throw badRequest('The same item appears on more than one line. Combine them into one.', 'lines');
    }
    seen.add(line.itemId);

    if (Number(line.qtyRequested) <= 0) {
      throw badRequest('Every line needs a quantity greater than zero.', 'qty_requested');
    }

    await tx`
      INSERT INTO mr_lines (mr_id, line_no, item_id, qty_requested, qty_transfer)
      VALUES (${mrId}, ${i + 1}, ${line.itemId}, ${line.qtyRequested}::numeric, 0)`;
  }
}

export async function replaceLines(actor: Actor, mrId: number, lines: MrLineInput[]): Promise<Row[]> {
  return inTransaction(async tx => {
    const mr = await loadMr(tx, mrId, true);
    requirePermission(actor, 'MR.EDIT', Number(mr.site_id));

    if (LINES_FROZEN.has(String(mr.status))) {
      throw conflict(`This material request is ${mr.status} — its lines can no longer be changed.`);
    }

    // A line already claimed by a transfer cannot vanish underneath it.
    const [{ count }] = await tx<{ count: string }[]>`
      SELECT count(*)::text FROM stock_transfer_lines l
        JOIN mr_lines ml ON ml.id = l.mr_line_id
       WHERE ml.mr_id = ${mrId}`;
    if (Number(count) > 0) {
      throw conflict('A transfer has already been raised from this request, so its lines are fixed.');
    }

    await tx`DELETE FROM mr_lines WHERE mr_id = ${mrId}`;
    await insertLines(tx, mrId, lines);

    // Quantities changed, so any stock check is stale.
    await tx`
      UPDATE material_requests
         SET status = 'MR_DRAFT', stock_checked_at = NULL
       WHERE id = ${mrId}`;

    await audit(tx, {
      entityType: ENTITY, entityId: mrId, action: 'UPDATE',
      after: { lines: lines.length }, userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Lines replaced; stock check reset',
    });

    return tx<Row[]>`SELECT * FROM mr_lines WHERE mr_id = ${mrId} ORDER BY line_no`;
  });
}

// =============================================================================
// Stock check
// =============================================================================

export interface SurplusAtSite {
  site_id: number;
  site: string;
  surplus_qty: string;
}

export interface StockCheckLine {
  mrLineId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  uom: string;
  qtyRequested: string;
  availableHere: string;
  surplusElsewhere: SurplusAtSite[];
  totalSurplus: string;
  /** What the group could cover by transfer, capped at the quantity requested. */
  coverable: string;
}

/**
 * Check group-wide stock and record the snapshot.
 *
 * Uses `v_group_surplus`, which counts only what each holding site has ABOVE
 * its own reorder level — a site is never stripped below the point where it
 * would itself need to reorder. The snapshot is written to
 * `mr_lines.stock_check` so the decision can be audited later, and
 * `stock_checked_at` is stamped: the schema notes it should be re-run if older
 * than 72 hours before a PR.
 */
export async function runStockCheck(actor: Actor, mrId: number): Promise<{ mr: Row; lines: StockCheckLine[] }> {
  return inTransaction(async tx => {
    const mr = await loadMr(tx, mrId, true);
    const siteId = Number(mr.site_id);
    requirePermission(actor, 'MR.STOCK_CHECK', siteId);

    if (LINES_FROZEN.has(String(mr.status))) {
      throw conflict(`This material request is ${mr.status} — the stock check cannot be re-run.`);
    }

    const lines = await tx<Row[]>`
      SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom
        FROM mr_lines l JOIN items i ON i.id = l.item_id
       WHERE l.mr_id = ${mrId} ORDER BY l.line_no`;

    const out: StockCheckLine[] = [];

    for (const line of lines) {
      const itemId = Number(line.item_id);

      const [here] = await tx<{ available: string }[]>`
        SELECT coalesce(qty, 0)::text AS available FROM stock_balances
         WHERE site_id = ${siteId} AND item_id = ${itemId} AND bucket = 'AVAILABLE'`;

      const elsewhere = await tx<{ site_id: string; site: string; surplus: string }[]>`
        SELECT site_id, site, surplus FROM v_group_surplus
         WHERE item_id = ${itemId} AND site_id <> ${siteId} AND surplus > 0
         ORDER BY surplus DESC`;

      const surplusElsewhere = elsewhere.map(e => ({
        site_id: Number(e.site_id),
        site: e.site,
        surplus_qty: e.surplus,
      }));

      const totalSurplus = elsewhere.reduce((sum, e) => sum + Number(e.surplus), 0);
      const requested = Number(line.qty_requested);
      const coverable = Math.min(totalSurplus, requested);

      // The snapshot is the evidence for the decision, so it records what was
      // seen, not what was chosen.
      await tx`
        UPDATE mr_lines
           SET stock_check = ${tx.json({
             checked_at: new Date().toISOString(),
             available_here: here?.available ?? '0',
             surplus: surplusElsewhere,
           } as never)}
         WHERE id = ${line.id as number}`;

      out.push({
        mrLineId: Number(line.id),
        itemId,
        itemCode: String(line.item_code),
        itemName: String(line.item_name),
        uom: String(line.uom),
        qtyRequested: String(line.qty_requested),
        availableHere: here?.available ?? '0',
        surplusElsewhere,
        totalSurplus: totalSurplus.toFixed(3),
        coverable: coverable.toFixed(3),
      });
    }

    // The outcome is the weakest line: if anything must be bought, the request
    // as a whole is partial or unavailable.
    const anyCoverable = out.some(l => Number(l.coverable) > 0);
    const allCovered = out.every(l => Number(l.coverable) >= Number(l.qtyRequested));
    const outcome = allCovered ? 'MR_STOCK_AVAILABLE' : anyCoverable ? 'MR_STOCK_PARTIAL' : 'MR_STOCK_UNAVAILABLE';

    const from = String(mr.status);
    if (from !== 'MR_STOCK_CHECK') {
      await assertTransition({ entityType: ENTITY, from, to: 'MR_STOCK_CHECK', principal: actor.principal, siteId }, tx);
      await tx`UPDATE material_requests SET status = 'MR_STOCK_CHECK' WHERE id = ${mrId}`;
    }
    await assertTransition(
      { entityType: ENTITY, from: 'MR_STOCK_CHECK', to: outcome, principal: actor.principal, siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE material_requests
         SET status = ${outcome}::mr_status, stock_checked_at = now()
       WHERE id = ${mrId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: mrId, action: 'TRANSITION',
      fromStatus: from, toStatus: outcome,
      after: { lines: out.map(l => ({ item: l.itemCode, requested: l.qtyRequested, coverable: l.coverable })) },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Group-wide stock check',
    });

    return { mr: updated, lines: out };
  });
}

/**
 * Set how much of each line will be met by transfer.
 *
 * `qty_purchase` is a generated column, so writing `qty_transfer` is the only
 * lever — the purchase balance falls out of it and can never contradict it.
 * `mr_lines_transfer_le` rejects a transfer larger than the request.
 */
export async function setTransferQuantities(
  actor: Actor,
  mrId: number,
  allocations: { mrLineId: number; qtyTransfer: string }[],
): Promise<Row[]> {
  return inTransaction(async tx => {
    const mr = await loadMr(tx, mrId, true);
    const siteId = Number(mr.site_id);
    requirePermission(actor, 'MR.EDIT', siteId);

    if (LINES_FROZEN.has(String(mr.status))) {
      throw conflict(`This material request is ${mr.status} — transfer quantities can no longer be changed.`);
    }
    if (!mr.stock_checked_at) {
      throw badRequest('Run the stock check before deciding what to transfer.');
    }

    for (const a of allocations) {
      const [line] = await tx<Row[]>`
        SELECT l.*, i.code AS item_code FROM mr_lines l JOIN items i ON i.id = l.item_id
         WHERE l.id = ${a.mrLineId} AND l.mr_id = ${mrId} FOR UPDATE`;
      if (!line) throw notFound('That request line no longer exists.');

      // Never promise a transfer the group cannot actually cover.
      const snapshot = line.stock_check as { surplus?: { surplus_qty: string }[] } | null;
      const available = (snapshot?.surplus ?? []).reduce((s, x) => s + Number(x.surplus_qty), 0);

      if (Number(a.qtyTransfer) > available) {
        throw badRequest(
          `Only ${available} of ${line.item_code} is surplus across the group, so ${a.qtyTransfer} cannot be transferred.`,
          'qty_transfer',
        );
      }

      await tx`UPDATE mr_lines SET qty_transfer = ${a.qtyTransfer}::numeric WHERE id = ${a.mrLineId}`;
    }

    const lines = await tx<Row[]>`SELECT * FROM mr_lines WHERE mr_id = ${mrId} ORDER BY line_no`;

    await audit(tx, {
      entityType: ENTITY, entityId: mrId, action: 'UPDATE',
      after: lines.map(l => ({ line: l.line_no, transfer: l.qty_transfer, purchase: l.qty_purchase })),
      userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Transfer allocation set',
    });

    return lines;
  });
}

// =============================================================================
// Declaration
// =============================================================================

export interface DeclarationInput {
  businessImpact: string;
  budgetCodeId: number;
  estimatedValue: string;
  allocations: { siteId: number; costHead: string; pct: string }[];
  declarationTextVersion?: string;
  acceptedIp?: string | null;
}

/**
 * Declare a genuine need before procurement (brief §6).
 *
 * `mr_allocations_total` is a DEFERRABLE INITIALLY DEFERRED constraint trigger,
 * so every allocation row must be inserted inside one transaction — checking
 * after the first row would always fail at less than 100%.
 *
 * The declaration carries the budget code (C-05), and `business_impact` is
 * CHECK-constrained to 40–500 characters: long enough to be a reason, short
 * enough that nobody pastes an email into it.
 */
export async function declare(actor: Actor, mrId: number, input: DeclarationInput): Promise<Row> {
  return inTransaction(async tx => {
    const mr = await loadMr(tx, mrId, true);
    const siteId = Number(mr.site_id);
    requirePermission(actor, 'MR.DECLARE', siteId);

    const from = String(mr.status);
    await assertTransition({ entityType: ENTITY, from, to: 'MR_DECLARED', principal: actor.principal, siteId }, tx);

    // Declaring is only meaningful when something is actually being bought.
    const [{ purchase }] = await tx<{ purchase: string }[]>`
      SELECT coalesce(sum(qty_purchase), 0)::text AS purchase FROM mr_lines WHERE mr_id = ${mrId}`;
    if (Number(purchase) <= 0) {
      throw badRequest(
        'Every line is covered by transfer, so there is nothing to declare. Raise the transfer instead.',
      );
    }

    const impact = normaliseText(input.businessImpact);
    if (impact.length < 40 || impact.length > 500) {
      throw badRequest(
        `The business impact must be between 40 and 500 characters — this one is ${impact.length}.`,
        'business_impact',
      );
    }

    const total = input.allocations.reduce((s, a) => s + Number(a.pct), 0);
    if (Math.abs(total - 100) > 0.001) {
      throw badRequest(`Site allocation must total exactly 100% — this one totals ${total}%.`, 'allocations');
    }

    // A new declaration supersedes the last; `mr_declarations (mr_id, version)`
    // is unique, and the history is kept rather than overwritten.
    const [{ next }] = await tx<{ next: number }[]>`
      SELECT coalesce(max(version), 0) + 1 AS next FROM mr_declarations WHERE mr_id = ${mrId}`;

    const [locked] = await tx<{ locked: boolean }[]>`
      SELECT locked FROM mr_declarations WHERE mr_id = ${mrId} AND locked ORDER BY version DESC LIMIT 1`;
    if (locked) {
      throw conflict('This declaration is locked because a purchase request already exists against it.');
    }

    const [declaration] = await tx<Row[]>`
      INSERT INTO mr_declarations (mr_id, version, business_impact, budget_code_id, estimated_value,
                                   declaration_text_version, accepted_by, accepted_ip)
      VALUES (${mrId}, ${next}, ${impact}, ${input.budgetCodeId}, ${input.estimatedValue}::numeric,
              ${input.declarationTextVersion ?? 'v2.0'}, ${actor.principal.userId},
              ${input.acceptedIp ?? actor.ip ?? null}::inet)
      RETURNING *`;

    for (const a of input.allocations) {
      await tx`
        INSERT INTO mr_allocations (declaration_id, site_id, cost_head, pct)
        VALUES (${declaration.id as number}, ${a.siteId}, ${normaliseText(a.costHead)}, ${a.pct}::numeric)`;
    }

    const [updated] = await tx<Row[]>`
      UPDATE material_requests SET status = 'MR_DECLARED' WHERE id = ${mrId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: mrId, action: 'TRANSITION',
      fromStatus: from, toStatus: 'MR_DECLARED',
      after: { version: next, budget_code_id: input.budgetCodeId, estimated_value: input.estimatedValue },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Declaration v${next} accepted`,
    });

    void updated;
    return declaration;
  });
}

// =============================================================================
// Approval
// =============================================================================

/**
 * Approve or reject a declared MR.
 *
 * `mr_self_approval` is a CHECK constraint, so the database refuses a
 * self-approval outright. The check here exists to say so in a sentence rather
 * than as a constraint violation.
 */
export async function decideMr(
  actor: Actor,
  mrId: number,
  approve: boolean,
  reason?: string,
): Promise<Row> {
  return inTransaction(async tx => {
    const mr = await loadMr(tx, mrId, true);
    const siteId = Number(mr.site_id);
    const to = approve ? 'MR_APPROVED' : 'MR_REJECTED';

    await assertTransition(
      { entityType: ENTITY, from: String(mr.status), to, principal: actor.principal, siteId },
      tx,
    );

    if (Number(mr.requester_id) === actor.principal.userId) {
      throw forbidden('You raised this material request, so you cannot approve it.');
    }

    const text = reason?.trim() || null;
    if (!approve && !text) {
      throw badRequest('Rejecting a material request requires a reason.', 'rejection_reason');
    }

    const [updated] = await tx<Row[]>`
      UPDATE material_requests
         SET status = ${to}::mr_status,
             approved_by = ${approve ? actor.principal.userId : null},
             approved_at = ${approve ? new Date().toISOString() : null}::timestamptz,
             rejection_reason = ${text}
       WHERE id = ${mrId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: mrId, action: 'TRANSITION',
      fromStatus: String(mr.status), toStatus: to,
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

export async function cancelMr(actor: Actor, mrId: number, reason: string): Promise<Row> {
  return inTransaction(async tx => {
    const mr = await loadMr(tx, mrId, true);
    const siteId = Number(mr.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(mr.status), to: 'MR_CANCELLED', principal: actor.principal, siteId },
      tx,
    );

    const text = normaliseText(reason ?? '');
    if (!text) throw badRequest('Cancelling requires a reason.', 'reason');

    const [updated] = await tx<Row[]>`
      UPDATE material_requests SET status = 'MR_CANCELLED', rejection_reason = ${text}
       WHERE id = ${mrId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: mrId, action: 'TRANSITION',
      fromStatus: String(mr.status), toStatus: 'MR_CANCELLED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export async function listMrs(
  principal: Principal,
  filters: { status?: string; siteId?: number; mine?: boolean } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT m.*, s.code AS site_code, s.name AS site_name, u.full_name AS requester_name,
           (SELECT count(*) FROM mr_lines l WHERE l.mr_id = m.id)                       AS line_count,
           (SELECT coalesce(sum(l.qty_purchase), 0) FROM mr_lines l WHERE l.mr_id = m.id) AS qty_to_purchase,
           (SELECT coalesce(sum(l.qty_transfer), 0) FROM mr_lines l WHERE l.mr_id = m.id) AS qty_to_transfer
      FROM material_requests m
      JOIN sites s     ON s.id = m.site_id
      JOIN app_users u ON u.id = m.requester_id
     WHERE (${siteIds}::bigint[] IS NULL OR m.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR m.status = ${filters.status ?? null}::mr_status)
       AND (${filters.siteId ?? null}::bigint IS NULL OR m.site_id = ${filters.siteId ?? null})
       AND (${filters.mine ? principal.userId : null}::bigint IS NULL OR m.requester_id = ${filters.mine ? principal.userId : null})
     ORDER BY m.created_at DESC`;
}

export async function getMr(id: number): Promise<{ mr: Row; lines: Row[]; declaration: Row | null; allocations: Row[] }> {
  const [mr] = await sql<Row[]>`
    SELECT m.*, s.code AS site_code, s.name AS site_name, u.full_name AS requester_name
      FROM material_requests m
      JOIN sites s ON s.id = m.site_id
      JOIN app_users u ON u.id = m.requester_id
     WHERE m.id = ${id}`;
  if (!mr) throw notFound('That material request no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom, i.default_gst_rate
      FROM mr_lines l JOIN items i ON i.id = l.item_id
     WHERE l.mr_id = ${id} ORDER BY l.line_no`;

  const [declaration] = await sql<Row[]>`
    SELECT d.*, b.code AS budget_code, u.full_name AS accepted_by_name
      FROM mr_declarations d
      JOIN budget_codes b ON b.id = d.budget_code_id
      JOIN app_users u    ON u.id = d.accepted_by
     WHERE d.mr_id = ${id} ORDER BY d.version DESC LIMIT 1`;

  const allocations = declaration
    ? await sql<Row[]>`
        SELECT a.*, s.code AS site_code, s.name AS site_name
          FROM mr_allocations a JOIN sites s ON s.id = a.site_id
         WHERE a.declaration_id = ${declaration.id as number} ORDER BY a.id`
    : [];

  return { mr, lines, declaration: declaration ?? null, allocations };
}

/** Declared, approved MRs with a purchase balance — what a PR can be raised from. */
export function mrsReadyForPr(principal: Principal): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT m.*, s.code AS site_code, s.name AS site_name,
           d.budget_code_id, d.estimated_value, b.code AS budget_code,
           (SELECT coalesce(sum(l.qty_purchase), 0) FROM mr_lines l WHERE l.mr_id = m.id) AS qty_to_purchase,
           (SELECT count(*) FROM mr_lines l WHERE l.mr_id = m.id AND l.qty_purchase > 0)  AS purchase_lines
      FROM material_requests m
      JOIN sites s ON s.id = m.site_id
      JOIN LATERAL (
        SELECT * FROM mr_declarations dd WHERE dd.mr_id = m.id ORDER BY dd.version DESC LIMIT 1
      ) d ON true
      JOIN budget_codes b ON b.id = d.budget_code_id
     WHERE m.status = 'MR_APPROVED'
       AND (${siteIds}::bigint[] IS NULL OR m.site_id = ANY(${siteIds}))
       AND NOT EXISTS (SELECT 1 FROM purchase_requests p WHERE p.mr_id = m.id)
       AND EXISTS (SELECT 1 FROM mr_lines l WHERE l.mr_id = m.id AND l.qty_purchase > 0)
     ORDER BY m.required_by`;
}
