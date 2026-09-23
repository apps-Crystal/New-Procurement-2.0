/**
 * Purchase request (brief §7).
 *
 * PR_DRAFT → PR_SUBMITTED → approval chain → PR_APPROVED → PO_POSTED → PR_CLOSED
 *
 * Three constraints the schema enforces that shape this module entirely:
 *
 * `purchase_requests.mr_id` is NOT NULL — a PR cannot exist without an MR. The
 * prototype says as much on its own screen ("A PR cannot exist without one").
 *
 * `check_pr_line_qty()` refuses any line whose quantity differs from
 * `mr_lines.qty_purchase`. There is no way to buy more, or less, than the
 * material request declared was needed after transfers.
 *
 * `pr_edit_lock()` refuses edits to the commercial fields once `locked_at` is
 * set. Brief §7 is explicit that this must not be client-side only — it is a
 * trigger, and the service simply does not try.
 *
 * Totals are never stored. `v_pr_totals` computes them per line at each line's
 * own GST rate, plus separately-taxed delivery. Conflict register C-04: the
 * prototype's flat 18% on a summed subtotal disagrees with the view, and the
 * view wins.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { normaliseText } from '@/lib/validate';
import { openApprovalChain, chainState, decide } from '@/lib/services/approvals';
import type { Actor, Row } from '@/lib/services/masters';

const ENTITY = 'PR';

/** The six payment buckets the schema declares, in the prototype's order. */
export const PAYMENT_TERMS = [
  'pay_advance_pct',
  'pay_before_delivery_pct',
  'pay_running_pct',
  'pay_post_delivery_pct',
  'pay_post_completion_pct',
  'pay_retention_pct',
] as const;

export type PaymentTerms = Record<(typeof PAYMENT_TERMS)[number], string>;

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with purchase requests.');
  }
}

async function loadPr(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM purchase_requests WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM purchase_requests WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That purchase request no longer exists.');
  return rows[0];
}

// =============================================================================
// Create
// =============================================================================

export interface PrInput {
  mrId: number;
  procurementType: 'MATERIAL' | 'SERVICE';
  purpose: string;
  expectedDelivery: string;
  suggestedVendorId?: number | null;
  deliveryLocationId?: number | null;
  deliveryChargeable?: boolean;
  deliveryChargeAmount?: string | null;
  deliveryChargeGstRate?: string | null;
  paymentTerms: PaymentTerms;
  paymentTermsOverride?: string | null;
  /** Estimated rate and GST per MR line. Quantity is not a choice. */
  lines: { mrLineId: number; estRate: string; gstRate: string }[];
}

/**
 * Raise a PR from an approved, declared MR.
 *
 * Quantities are copied from `mr_lines.qty_purchase` and never accepted from
 * the caller — the trigger would reject a mismatch anyway, and taking them as
 * input would only create a chance to disagree.
 */
export async function createPr(actor: Actor, input: PrInput): Promise<Row> {
  return inTransaction(async tx => {
    const [mr] = await tx<Row[]>`SELECT * FROM material_requests WHERE id = ${input.mrId} FOR UPDATE`;
    if (!mr) throw notFound('That material request no longer exists.');

    const siteId = Number(mr.site_id);
    requirePermission(actor, 'PR.CREATE', siteId);

    if (mr.status !== 'MR_APPROVED') {
      throw conflict(
        `A purchase request can only be raised from an approved material request. ${mr.mr_no} is ${mr.status}.`,
      );
    }

    // `purchase_orders.pr_id` and this check together give one PR per MR.
    const [existing] = await tx<Row[]>`SELECT pr_no FROM purchase_requests WHERE mr_id = ${input.mrId}`;
    if (existing) {
      throw conflict(`${mr.mr_no} has already been converted — see ${existing.pr_no}.`);
    }

    const [declaration] = await tx<Row[]>`
      SELECT * FROM mr_declarations WHERE mr_id = ${input.mrId} ORDER BY version DESC LIMIT 1`;
    if (!declaration) {
      throw badRequest('This material request has no declaration, so there is no budget code to inherit.');
    }

    assertPaymentTerms(input.paymentTerms, input.paymentTermsOverride);

    if (input.deliveryChargeable && (!input.deliveryChargeAmount || !input.deliveryChargeGstRate)) {
      throw badRequest(
        'When delivery is chargeable, both the amount and its GST rate are required.',
        'delivery_charge_amount',
      );
    }

    const purchaseLines = await tx<Row[]>`
      SELECT * FROM mr_lines WHERE mr_id = ${input.mrId} AND qty_purchase > 0 ORDER BY line_no`;

    if (purchaseLines.length === 0) {
      throw badRequest('Every line on this request is covered by transfer, so there is nothing to purchase.');
    }

    const rates = new Map(input.lines.map(l => [l.mrLineId, l]));
    const missing = purchaseLines.filter(l => !rates.has(Number(l.id)));
    if (missing.length > 0) {
      throw badRequest(`Every purchase line needs an estimated rate — ${missing.length} still has none.`, 'lines');
    }

    const prNo = await nextDocumentNoForSite(tx, ENTITY, siteId);

    const [pr] = await tx<Row[]>`
      INSERT INTO purchase_requests (
        pr_no, mr_id, site_id, category, budget_code_id, procurement_type, purpose,
        suggested_vendor_id, urgency,
        pay_advance_pct, pay_before_delivery_pct, pay_running_pct,
        pay_post_delivery_pct, pay_post_completion_pct, pay_retention_pct,
        payment_terms_override, delivery_location_id, expected_delivery,
        delivery_chargeable, delivery_charge_amount, delivery_charge_gst_rate,
        status, requester_id)
      VALUES (
        ${prNo}, ${input.mrId}, ${siteId}, ${mr.category as string}::category_code,
        ${declaration.budget_code_id as number}, ${input.procurementType}::procurement_type,
        ${normaliseText(input.purpose)}, ${input.suggestedVendorId ?? null},
        ${mr.urgency as string}::urgency_code,
        ${input.paymentTerms.pay_advance_pct}::numeric, ${input.paymentTerms.pay_before_delivery_pct}::numeric,
        ${input.paymentTerms.pay_running_pct}::numeric, ${input.paymentTerms.pay_post_delivery_pct}::numeric,
        ${input.paymentTerms.pay_post_completion_pct}::numeric, ${input.paymentTerms.pay_retention_pct}::numeric,
        ${input.paymentTermsOverride?.trim() || null}, ${input.deliveryLocationId ?? null},
        ${input.expectedDelivery}::date, ${input.deliveryChargeable ?? false},
        ${input.deliveryChargeAmount ?? null}::numeric, ${input.deliveryChargeGstRate ?? null}::numeric,
        'PR_DRAFT', ${actor.principal.userId})
      RETURNING *`;

    // Quantity comes from the MR, not the caller. check_pr_line_qty() enforces
    // it regardless; copying it here means there is nothing to get wrong.
    for (const [i, mrLine] of purchaseLines.entries()) {
      const rate = rates.get(Number(mrLine.id))!;
      await tx`
        INSERT INTO pr_lines (pr_id, line_no, mr_line_id, item_id, qty, est_rate, gst_rate)
        VALUES (${pr.id as number}, ${i + 1}, ${mrLine.id as number}, ${mrLine.item_id as number},
                ${mrLine.qty_purchase as string}::numeric, ${rate.estRate}::numeric, ${rate.gstRate}::numeric)`;
    }

    // The declaration is now referenced by a PR and must stop changing.
    await tx`UPDATE mr_declarations SET locked = true WHERE id = ${declaration.id as number}`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(pr.id), action: 'CREATE',
      after: { pr_no: prNo, mr_no: mr.mr_no, lines: purchaseLines.length },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Raised from ${mr.mr_no}; declaration locked`,
    });

    return pr;
  });
}

/** `pr_payment_terms_total` — the six buckets total 100 unless overridden. */
function assertPaymentTerms(terms: PaymentTerms, override?: string | null) {
  if (override?.trim()) return;

  const total = PAYMENT_TERMS.reduce((sum, key) => sum + Number(terms[key] ?? 0), 0);
  if (Math.abs(total - 100) > 0.001) {
    throw badRequest(
      `Payment terms must total exactly 100% — these total ${total}%. Add an override note if the terms cannot be expressed as percentages.`,
      'payment_terms',
    );
  }
}

// =============================================================================
// Edit
// =============================================================================

export async function updatePr(actor: Actor, prId: number, input: Partial<PrInput>): Promise<Row> {
  return inTransaction(async tx => {
    const pr = await loadPr(tx, prId, true);
    const siteId = Number(pr.site_id);
    requirePermission(actor, 'PR.EDIT', siteId);

    // pr_edit_lock() would refuse this. Saying so plainly is kinder than a
    // trigger message naming the constraint.
    if (pr.locked_at) {
      throw forbidden(`${pr.pr_no} was approved and can no longer be edited.`);
    }
    if (pr.status !== 'PR_DRAFT') {
      throw conflict(`${pr.pr_no} is ${pr.status} — only a draft can be edited.`);
    }

    if (input.paymentTerms) assertPaymentTerms(input.paymentTerms, input.paymentTermsOverride);

    const terms = input.paymentTerms;

    const [updated] = await tx<Row[]>`
      UPDATE purchase_requests SET
        purpose                 = ${input.purpose !== undefined ? normaliseText(input.purpose) : (pr.purpose as string)},
        procurement_type        = ${input.procurementType ?? (pr.procurement_type as string)}::procurement_type,
        expected_delivery       = ${input.expectedDelivery ?? (pr.expected_delivery as string)}::date,
        suggested_vendor_id     = ${input.suggestedVendorId !== undefined ? input.suggestedVendorId : (pr.suggested_vendor_id as number | null)},
        delivery_location_id    = ${input.deliveryLocationId !== undefined ? input.deliveryLocationId : (pr.delivery_location_id as number | null)},
        delivery_chargeable     = ${input.deliveryChargeable ?? (pr.delivery_chargeable as boolean)},
        delivery_charge_amount  = ${input.deliveryChargeAmount !== undefined ? input.deliveryChargeAmount : (pr.delivery_charge_amount as string | null)}::numeric,
        delivery_charge_gst_rate= ${input.deliveryChargeGstRate !== undefined ? input.deliveryChargeGstRate : (pr.delivery_charge_gst_rate as string | null)}::numeric,
        pay_advance_pct         = ${terms?.pay_advance_pct ?? (pr.pay_advance_pct as string)}::numeric,
        pay_before_delivery_pct = ${terms?.pay_before_delivery_pct ?? (pr.pay_before_delivery_pct as string)}::numeric,
        pay_running_pct         = ${terms?.pay_running_pct ?? (pr.pay_running_pct as string)}::numeric,
        pay_post_delivery_pct   = ${terms?.pay_post_delivery_pct ?? (pr.pay_post_delivery_pct as string)}::numeric,
        pay_post_completion_pct = ${terms?.pay_post_completion_pct ?? (pr.pay_post_completion_pct as string)}::numeric,
        pay_retention_pct       = ${terms?.pay_retention_pct ?? (pr.pay_retention_pct as string)}::numeric,
        payment_terms_override  = ${input.paymentTermsOverride !== undefined ? input.paymentTermsOverride?.trim() || null : (pr.payment_terms_override as string | null)}
      WHERE id = ${prId}
      RETURNING *`;

    if (input.lines) {
      for (const line of input.lines) {
        await tx`
          UPDATE pr_lines SET est_rate = ${line.estRate}::numeric, gst_rate = ${line.gstRate}::numeric
           WHERE pr_id = ${prId} AND mr_line_id = ${line.mrLineId}`;
      }
    }

    await audit(tx, {
      entityType: ENTITY, entityId: prId, action: 'UPDATE',
      before: pr, after: updated, userId: actor.principal.userId, ip: actor.ip,
    });

    return updated;
  });
}

// =============================================================================
// Submit and approve
// =============================================================================

/**
 * Submit for approval.
 *
 * The approval route is chosen from the PR's own total — `v_pr_totals`, not a
 * number the client sent. The prototype's `band()` did this in JavaScript;
 * here the value and the band both come from the database.
 */
export async function submitPr(actor: Actor, prId: number): Promise<{ pr: Row; levels: Row[] }> {
  return inTransaction(async tx => {
    const pr = await loadPr(tx, prId, true);
    const siteId = Number(pr.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(pr.status), to: 'PR_SUBMITTED', principal: actor.principal, siteId },
      tx,
    );

    const [totals] = await tx<{ taxable: string; gst: string; total_incl_gst: string }[]>`
      SELECT taxable::text, gst::text, total_incl_gst::text FROM v_pr_totals WHERE pr_id = ${prId}`;
    if (!totals) throw badRequest('This purchase request has no lines, so it cannot be submitted.');

    const levels = await openApprovalChain(tx, 'PR', prId, totals.total_incl_gst);

    // Record which band was used, so a later change to the matrix does not
    // silently rewrite history.
    const [band] = await tx<{ id: string }[]>`
      SELECT b.id FROM approval_bands b
        JOIN approval_band_levels l ON l.band_id = b.id
       WHERE b.entity_type = 'PR' AND l.level_no = 1 AND l.role = ${levels[0].required_role}::role_code
         AND ${totals.total_incl_gst}::numeric >= b.min_value
         AND (b.max_value IS NULL OR ${totals.total_incl_gst}::numeric < b.max_value)
       LIMIT 1`;

    const [updated] = await tx<Row[]>`
      UPDATE purchase_requests
         SET status = 'PR_SUBMITTED', approval_band_id = ${band?.id ?? null}
       WHERE id = ${prId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: prId, action: 'TRANSITION',
      fromStatus: String(pr.status), toStatus: 'PR_SUBMITTED',
      after: { total_incl_gst: totals.total_incl_gst, levels: levels.map(l => l.required_role) },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Routed to ${levels.map(l => l.required_role).join(' then ')}`,
    });

    return { pr: updated, levels: levels as unknown as Row[] };
  });
}

/**
 * Record one approval decision.
 *
 * The PR only moves when the LAST level approves; a rejection at any level ends
 * it immediately. `locked_at` is set on final approval, which arms
 * `pr_edit_lock()`.
 */
export async function decidePr(
  actor: Actor,
  prId: number,
  approve: boolean,
  remarks?: string,
): Promise<{ pr: Row; complete: boolean; rejected: boolean; levelNo: number }> {
  return inTransaction(async tx => {
    const pr = await loadPr(tx, prId, true);
    const siteId = Number(pr.site_id);

    if (pr.status !== 'PR_SUBMITTED') {
      throw conflict(`${pr.pr_no} is ${pr.status} — there is no approval waiting.`);
    }

    const result = await decide(tx, {
      entityType: 'PR',
      entityId: prId,
      siteId,
      originatorId: Number(pr.requester_id),
      principal: actor.principal,
      approve,
      remarks,
      ip: actor.ip,
    });

    let updated = pr;

    if (result.rejected) {
      await assertTransition(
        { entityType: ENTITY, from: 'PR_SUBMITTED', to: 'PR_REJECTED', principal: actor.principal, siteId },
        tx,
      );
      [updated] = await tx<Row[]>`
        UPDATE purchase_requests SET status = 'PR_REJECTED' WHERE id = ${prId} RETURNING *`;
    } else if (result.complete) {
      await assertTransition(
        { entityType: ENTITY, from: 'PR_SUBMITTED', to: 'PR_APPROVED', principal: actor.principal, siteId },
        tx,
      );
      // locked_at arms pr_edit_lock(); from here the commercial fields are fixed.
      [updated] = await tx<Row[]>`
        UPDATE purchase_requests SET status = 'PR_APPROVED', locked_at = now()
         WHERE id = ${prId} RETURNING *`;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: prId, action: 'TRANSITION',
      fromStatus: 'PR_SUBMITTED',
      toStatus: result.rejected ? 'PR_REJECTED' : result.complete ? 'PR_APPROVED' : 'PR_SUBMITTED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: result.complete
        ? 'Final approval — purchase request locked against edits'
        : result.rejected
          ? 'Rejected'
          : `Level ${result.decided.level_no} approved; awaiting the next`,
    });

    return { pr: updated, complete: result.complete, rejected: result.rejected, levelNo: result.decided.level_no };
  });
}

export async function cancelPr(actor: Actor, prId: number, reason: string): Promise<Row> {
  return inTransaction(async tx => {
    const pr = await loadPr(tx, prId, true);
    const siteId = Number(pr.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(pr.status), to: 'PR_CANCELLED', principal: actor.principal, siteId },
      tx,
    );

    const text = normaliseText(reason ?? '');
    if (!text) throw badRequest('Cancelling a purchase request requires a reason.', 'reason');

    const [updated] = await tx<Row[]>`
      UPDATE purchase_requests SET status = 'PR_CANCELLED', cancelled_reason = ${text}
       WHERE id = ${prId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: prId, action: 'TRANSITION',
      fromStatus: String(pr.status), toStatus: 'PR_CANCELLED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listPrs(principal: Principal, filters: { status?: string; mine?: boolean } = {}): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT p.*, s.code AS site_code, s.name AS site_name, u.full_name AS requester_name,
           m.mr_no, b.code AS budget_code,
           t.taxable, t.gst, t.total_incl_gst,
           (SELECT count(*) FROM pr_lines l WHERE l.pr_id = p.id) AS line_count
      FROM purchase_requests p
      JOIN sites s              ON s.id = p.site_id
      JOIN app_users u          ON u.id = p.requester_id
      JOIN material_requests m  ON m.id = p.mr_id
      JOIN budget_codes b       ON b.id = p.budget_code_id
      LEFT JOIN v_pr_totals t   ON t.pr_id = p.id
     WHERE (${siteIds}::bigint[] IS NULL OR p.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR p.status = ${filters.status ?? null}::pr_status)
       AND (${filters.mine ? principal.userId : null}::bigint IS NULL OR p.requester_id = ${filters.mine ? principal.userId : null})
     ORDER BY p.created_at DESC`;
}

export async function getPr(id: number): Promise<{
  pr: Row;
  lines: Row[];
  totals: Row | null;
  approvals: Row[];
}> {
  const [pr] = await sql<Row[]>`
    SELECT p.*, s.code AS site_code, s.name AS site_name, u.full_name AS requester_name,
           m.mr_no, m.category AS mr_category, b.code AS budget_code,
           v.legal_name AS suggested_vendor_name,
           d.business_impact, d.estimated_value
      FROM purchase_requests p
      JOIN sites s             ON s.id = p.site_id
      JOIN app_users u         ON u.id = p.requester_id
      JOIN material_requests m ON m.id = p.mr_id
      JOIN budget_codes b      ON b.id = p.budget_code_id
      LEFT JOIN vendors v      ON v.id = p.suggested_vendor_id
      LEFT JOIN LATERAL (
        SELECT * FROM mr_declarations dd WHERE dd.mr_id = m.id ORDER BY dd.version DESC LIMIT 1
      ) d ON true
     WHERE p.id = ${id}`;

  if (!pr) throw notFound('That purchase request no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom,
           round(l.qty * l.est_rate, 2)                                  AS line_taxable,
           round(l.qty * l.est_rate * l.gst_rate / 100, 2)               AS line_gst,
           round(l.qty * l.est_rate * (1 + l.gst_rate / 100), 2)         AS line_total
      FROM pr_lines l JOIN items i ON i.id = l.item_id
     WHERE l.pr_id = ${id} ORDER BY l.line_no`;

  // Authoritative totals — never recomputed in application code (§10, C-04).
  const [totals] = await sql<Row[]>`SELECT * FROM v_pr_totals WHERE pr_id = ${id}`;

  const approvals = await sql<Row[]>`
    SELECT a.*, u.full_name AS approver_name
      FROM approvals a LEFT JOIN app_users u ON u.id = a.approver_id
     WHERE a.entity_type = 'PR' AND a.entity_id = ${id}
     ORDER BY a.level_no`;

  return { pr, lines, totals: totals ?? null, approvals };
}

/** The approval chain's current state, for rendering the right actions. */
export async function prApprovalState(prId: number) {
  return inTransaction(tx => chainState(tx, 'PR', prId));
}
