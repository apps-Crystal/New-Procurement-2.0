/**
 * Quotations, comparison and award (brief §10).
 *
 * PR_APPROVED → collect quotations → compare on landed cost → award → PO
 *
 * The comparison is the point of this module, and the rule is unambiguous:
 * **`v_quotation_landed_cost` is authoritative.** It computes
 * `sum(round(qty × rate × (1 + gst/100), 2)) + freight` — per-line rounding at
 * each line's own GST rate — and supplies `rank_no` via a window function.
 *
 * The prototype computed `round(subtotal × 0.18)`, a flat rate on a summed
 * subtotal, and sorted in JavaScript. Those disagree by rounding always, and
 * materially whenever any line is not 18% (conflict register C-04). Nothing
 * here re-derives either number: the view is read and displayed.
 *
 * Two escape hatches the schema provides, both requiring a written reason:
 *   `awards_waiver` — fewer than the minimum quotations
 *   `awards_nonlow` — awarding to someone other than L1
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { normaliseText } from '@/lib/validate';
import { openApprovalChain } from '@/lib/services/approvals';
import { assertVendorOrderable } from '@/lib/services/vendors';
import type { Actor, Row } from '@/lib/services/masters';

/** The schema defaults `quote_awards.min_required` to 3. */
export const DEFAULT_MIN_QUOTES = 3;

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with quotations.');
  }
}

async function loadPrForQuoting(tx: Tx, prId: number): Promise<Row> {
  const [pr] = await tx<Row[]>`SELECT * FROM purchase_requests WHERE id = ${prId} FOR UPDATE`;
  if (!pr) throw notFound('That purchase request no longer exists.');

  if (pr.status !== 'PR_APPROVED') {
    throw conflict(
      `Quotations can only be collected against an approved purchase request. ${pr.pr_no} is ${pr.status}.`,
    );
  }
  return pr;
}

// =============================================================================
// Quotations
// =============================================================================

export interface QuotationInput {
  prId: number;
  vendorId: number;
  vendorQuoteRef: string;
  quoteDate: string;
  validUntil: string;
  freightAmount?: string;
  paymentTerms?: string | null;
  warrantyMonths?: number | null;
  lines: { prLineId: number; unitRate: string; gstRate: string; leadTimeDays?: number | null; make?: string | null }[];
}

/**
 * Record a vendor's quotation.
 *
 * `quotations (pr_id, vendor_id)` is unique — one quotation per vendor per PR.
 * A revised quote replaces the existing one rather than accumulating, which
 * keeps the comparison honest.
 */
export async function recordQuotation(actor: Actor, input: QuotationInput): Promise<Row> {
  return inTransaction(async tx => {
    const pr = await loadPrForQuoting(tx, input.prId);
    const siteId = Number(pr.site_id);
    requirePermission(actor, 'QUOTATION.MANAGE', siteId);

    // Only a vendor who could actually be ordered from is worth quoting.
    await assertVendorOrderable(input.vendorId);

    if (new Date(input.validUntil) < new Date(input.quoteDate)) {
      throw badRequest('The validity date cannot be before the quotation date.', 'valid_until');
    }

    const prLines = await tx<Row[]>`SELECT id FROM pr_lines WHERE pr_id = ${input.prId} ORDER BY line_no`;
    const quoted = new Set(input.lines.map(l => l.prLineId));
    const missing = prLines.filter(l => !quoted.has(Number(l.id)));

    if (missing.length > 0) {
      throw badRequest(
        `A quotation must price every line — ${missing.length} of ${prLines.length} is unpriced.`,
        'lines',
      );
    }

    // A revision replaces the previous quote from this vendor.
    const [existing] = await tx<Row[]>`
      SELECT * FROM quotations WHERE pr_id = ${input.prId} AND vendor_id = ${input.vendorId} FOR UPDATE`;

    if (existing) {
      if (existing.status === 'QUOTE_AWARDED') {
        throw conflict('This quotation has already been awarded and cannot be revised.');
      }
      await tx`DELETE FROM quotation_lines WHERE quotation_id = ${existing.id as number}`;
      await tx`DELETE FROM quotations WHERE id = ${existing.id as number}`;
    }

    const [quotation] = await tx<Row[]>`
      INSERT INTO quotations (pr_id, vendor_id, vendor_quote_ref, quote_date, valid_until,
                              freight_amount, payment_terms, warranty_months, status, entered_by)
      VALUES (${input.prId}, ${input.vendorId}, ${normaliseText(input.vendorQuoteRef)},
              ${input.quoteDate}::date, ${input.validUntil}::date,
              ${input.freightAmount ?? '0'}::numeric, ${input.paymentTerms?.trim() || null},
              ${input.warrantyMonths ?? null}, 'QUOTE_RECEIVED', ${actor.principal.userId})
      RETURNING *`;

    for (const line of input.lines) {
      await tx`
        INSERT INTO quotation_lines (quotation_id, pr_line_id, unit_rate, gst_rate, lead_time_days, make)
        VALUES (${quotation.id as number}, ${line.prLineId}, ${line.unitRate}::numeric,
                ${line.gstRate}::numeric, ${line.leadTimeDays ?? null}, ${line.make?.trim() || null})`;
    }

    await audit(tx, {
      entityType: 'QUOTATION', entityId: Number(quotation.id), action: existing ? 'UPDATE' : 'CREATE',
      after: { pr_no: pr.pr_no, vendor_id: input.vendorId, ref: input.vendorQuoteRef },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: existing ? 'Revised quotation replaces the previous one' : undefined,
    });

    return quotation;
  });
}

export async function withdrawQuotation(actor: Actor, quotationId: number, reason: string): Promise<Row> {
  return inTransaction(async tx => {
    const [q] = await tx<Row[]>`
      SELECT q.*, p.site_id, p.pr_no FROM quotations q
        JOIN purchase_requests p ON p.id = q.pr_id
       WHERE q.id = ${quotationId} FOR UPDATE OF q`;
    if (!q) throw notFound('That quotation no longer exists.');

    requirePermission(actor, 'QUOTATION.MANAGE', Number(q.site_id));

    if (q.status === 'QUOTE_AWARDED') {
      throw conflict('An awarded quotation cannot be withdrawn.');
    }

    const [updated] = await tx<Row[]>`
      UPDATE quotations SET status = 'QUOTE_WITHDRAWN' WHERE id = ${quotationId} RETURNING *`;

    await audit(tx, {
      entityType: 'QUOTATION', entityId: quotationId, action: 'TRANSITION',
      fromStatus: String(q.status), toStatus: 'QUOTE_WITHDRAWN',
      userId: actor.principal.userId, ip: actor.ip, remarks: normaliseText(reason),
    });

    return updated;
  });
}

// =============================================================================
// Comparison
// =============================================================================

export interface ComparisonQuote {
  quotationId: number;
  vendorId: number;
  vendorName: string;
  vendorQuoteRef: string;
  quoteDate: string;
  validUntil: string;
  expired: boolean;
  taxable: string;
  gst: string;
  freight: string;
  landedCost: string;
  /** From the view's window function — never a client-side sort. */
  rank: number;
  varianceToL1: string;
  paymentTerms: string | null;
  warrantyMonths: number | null;
  lines: { prLineId: number; itemCode: string; itemName: string; qty: string; unitRate: string; gstRate: string; lineTotal: string; leadTimeDays: number | null; make: string | null }[];
  scorecard: { rejectionPct: string | null; returns12m: number; qtyDelivered: string } | null;
}

export interface Comparison {
  pr: Row;
  quotes: ComparisonQuote[];
  minRequired: number;
  /** True when fewer quotations were received than the minimum — needs a waiver. */
  needsWaiver: boolean;
  awarded: Row | null;
}

/**
 * The comparison statement.
 *
 * Every figure comes from `v_quotation_landed_cost`. The vendor scorecard comes
 * from `v_vendor_scorecard`, which derives rejection rate and return count from
 * actual QC and RTV history rather than the prototype's hardcoded table.
 */
export async function buildComparison(prId: number): Promise<Comparison> {
  const [pr] = await sql<Row[]>`
    SELECT p.*, s.code AS site_code, s.name AS site_name
      FROM purchase_requests p JOIN sites s ON s.id = p.site_id
     WHERE p.id = ${prId}`;
  if (!pr) throw notFound('That purchase request no longer exists.');

  const landed = await sql<Row[]>`
    SELECT c.*, q.vendor_quote_ref, q.quote_date, q.valid_until, q.payment_terms, q.warranty_months,
           v.legal_name AS vendor_name
      FROM v_quotation_landed_cost c
      JOIN quotations q ON q.id = c.quotation_id
      JOIN vendors v    ON v.id = c.vendor_id
     WHERE c.pr_id = ${prId} AND q.status <> 'QUOTE_WITHDRAWN'
     ORDER BY c.rank_no`;

  const lowest = landed.find(l => Number(l.rank_no) === 1);

  const quotes: ComparisonQuote[] = [];

  for (const l of landed) {
    const lines = await sql<Row[]>`
      SELECT ql.*, pl.qty, i.code AS item_code, i.name AS item_name,
             round(pl.qty * ql.unit_rate * (1 + ql.gst_rate / 100), 2) AS line_total
        FROM quotation_lines ql
        JOIN pr_lines pl ON pl.id = ql.pr_line_id
        JOIN items i     ON i.id = pl.item_id
       WHERE ql.quotation_id = ${l.quotation_id as number}
       ORDER BY pl.line_no`;

    const [score] = await sql<Row[]>`
      SELECT rejection_pct, returns_12m, qty_delivered FROM v_vendor_scorecard WHERE vendor_id = ${l.vendor_id as number}`;

    quotes.push({
      quotationId: Number(l.quotation_id),
      vendorId: Number(l.vendor_id),
      vendorName: String(l.vendor_name),
      vendorQuoteRef: String(l.vendor_quote_ref),
      quoteDate: String(l.quote_date),
      validUntil: String(l.valid_until),
      expired: new Date(String(l.valid_until)) < new Date(new Date().toDateString()),
      taxable: String(l.taxable),
      gst: String(l.gst),
      freight: String(l.freight_amount),
      landedCost: String(l.landed_cost),
      rank: Number(l.rank_no),
      varianceToL1: lowest ? (Number(l.landed_cost) - Number(lowest.landed_cost)).toFixed(2) : '0.00',
      paymentTerms: (l.payment_terms as string) ?? null,
      warrantyMonths: l.warranty_months === null ? null : Number(l.warranty_months),
      lines: lines.map(ln => ({
        prLineId: Number(ln.pr_line_id),
        itemCode: String(ln.item_code),
        itemName: String(ln.item_name),
        qty: String(ln.qty),
        unitRate: String(ln.unit_rate),
        gstRate: String(ln.gst_rate),
        lineTotal: String(ln.line_total),
        leadTimeDays: ln.lead_time_days === null ? null : Number(ln.lead_time_days),
        make: (ln.make as string) ?? null,
      })),
      scorecard: score
        ? {
            rejectionPct: (score.rejection_pct as string) ?? null,
            returns12m: Number(score.returns_12m ?? 0),
            qtyDelivered: String(score.qty_delivered ?? '0'),
          }
        : null,
    });
  }

  const [awarded] = await sql<Row[]>`
    SELECT a.*, v.legal_name AS vendor_name, u.full_name AS awarded_by_name
      FROM quote_awards a
      JOIN quotations q ON q.id = a.quotation_id
      JOIN vendors v    ON v.id = q.vendor_id
      JOIN app_users u  ON u.id = a.awarded_by
     WHERE a.pr_id = ${prId}`;

  return {
    pr,
    quotes,
    minRequired: DEFAULT_MIN_QUOTES,
    needsWaiver: quotes.length < DEFAULT_MIN_QUOTES,
    awarded: awarded ?? null,
  };
}

// =============================================================================
// Award
// =============================================================================

export interface AwardInput {
  prId: number;
  quotationId: number;
  /** Required when fewer than the minimum quotations were received. */
  waiverReason?: string | null;
  /** Required when the chosen quote is not the lowest. */
  reasonCode?: string | null;
  justification?: string | null;
}

/**
 * Award a quotation.
 *
 * `quote_awards.pr_id` is UNIQUE — one award per PR, matching the one-PO-per-PR
 * rule (conflict register C-17). Whether the choice is the lowest is decided
 * from the view's own rank, not from anything the caller asserts.
 *
 * A non-lowest award, or one made on too few quotations, opens its own approval
 * chain before a PO can be raised.
 */
export async function award(actor: Actor, input: AwardInput): Promise<{ award: Row; needsApproval: boolean }> {
  return inTransaction(async tx => {
    const pr = await loadPrForQuoting(tx, input.prId);
    const siteId = Number(pr.site_id);
    requirePermission(actor, 'AWARD.CREATE', siteId);

    const [existing] = await tx<Row[]>`SELECT id FROM quote_awards WHERE pr_id = ${input.prId}`;
    if (existing) throw conflict('This purchase request has already been awarded.');

    const ranked = await tx<Row[]>`
      SELECT c.*, q.status, q.valid_until, v.legal_name
        FROM v_quotation_landed_cost c
        JOIN quotations q ON q.id = c.quotation_id
        JOIN vendors v    ON v.id = c.vendor_id
       WHERE c.pr_id = ${input.prId} AND q.status <> 'QUOTE_WITHDRAWN'
       ORDER BY c.rank_no`;

    const chosen = ranked.find(r => Number(r.quotation_id) === input.quotationId);
    if (!chosen) throw notFound('That quotation is not available to award.');

    // An expired quote is not a price anyone is bound by.
    if (new Date(String(chosen.valid_until)) < new Date(new Date().toDateString())) {
      throw badRequest(
        `That quotation expired on ${chosen.valid_until}. Ask the vendor to revalidate it before awarding.`,
        'quotation_id',
      );
    }

    await assertVendorOrderable(Number(chosen.vendor_id));

    const quotesReceived = ranked.length;
    const isLowest = Number(chosen.rank_no) === 1;
    const lowest = ranked[0];
    const variance = isLowest ? '0.00' : (Number(chosen.landed_cost) - Number(lowest.landed_cost)).toFixed(2);

    // awards_waiver
    const waiver = input.waiverReason?.trim() || null;
    if (quotesReceived < DEFAULT_MIN_QUOTES && !waiver) {
      throw badRequest(
        `Only ${quotesReceived} of the required ${DEFAULT_MIN_QUOTES} quotations were received, so a waiver reason is needed.`,
        'waiver_reason',
      );
    }

    // awards_nonlow
    const reasonCode = input.reasonCode?.trim() || null;
    const justification = input.justification?.trim() || null;
    if (!isLowest && (!reasonCode || !justification)) {
      throw badRequest(
        `${chosen.legal_name} is L${chosen.rank_no}, ₹${variance} above the lowest quote. A reason code and written justification are required.`,
        'justification',
      );
    }

    const [created] = await tx<Row[]>`
      INSERT INTO quote_awards (pr_id, quotation_id, quotes_received, min_required, waiver_reason,
                                is_lowest, variance_to_l1, reason_code, justification, awarded_by)
      VALUES (${input.prId}, ${input.quotationId}, ${quotesReceived}, ${DEFAULT_MIN_QUOTES}, ${waiver},
              ${isLowest}, ${variance}::numeric, ${reasonCode}, ${justification}, ${actor.principal.userId})
      RETURNING *`;

    await tx`UPDATE quotations SET status = 'QUOTE_AWARDED' WHERE id = ${input.quotationId}`;
    await tx`
      UPDATE quotations SET status = 'QUOTE_LOST'
       WHERE pr_id = ${input.prId} AND id <> ${input.quotationId} AND status = 'QUOTE_RECEIVED'`;

    // A departure from the lowest price, or from the minimum quote count, needs
    // signing off before the PO can issue.
    let needsApproval = false;
    if (!isLowest) {
      await openApprovalChain(tx, 'NON_LOWEST_AWARD', Number(created.id), String(chosen.landed_cost));
      needsApproval = true;
    } else if (waiver) {
      await openApprovalChain(tx, 'QUOTE_WAIVER', Number(created.id), String(chosen.landed_cost));
      needsApproval = true;
    }

    await audit(tx, {
      entityType: 'QUOTE_AWARD', entityId: Number(created.id), action: 'CREATE',
      after: {
        pr_no: pr.pr_no, vendor: chosen.legal_name, landed_cost: chosen.landed_cost,
        rank: chosen.rank_no, is_lowest: isLowest, quotes_received: quotesReceived,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: isLowest
        ? `Lowest landed cost awarded to ${chosen.legal_name}`
        : `Non-lowest award to ${chosen.legal_name}, ₹${variance} above L1 — ${reasonCode}`,
    });

    return { award: created, needsApproval };
  });
}

/** Is the award cleared for a PO — either lowest, or approved? */
export async function awardCleared(prId: number): Promise<{ award: Row | null; cleared: boolean; reason: string | null }> {
  const [a] = await sql<Row[]>`SELECT * FROM quote_awards WHERE pr_id = ${prId}`;
  if (!a) return { award: null, cleared: false, reason: 'No quotation has been awarded yet.' };

  const entityType = !a.is_lowest ? 'NON_LOWEST_AWARD' : a.waiver_reason ? 'QUOTE_WAIVER' : null;
  if (!entityType) return { award: a, cleared: true, reason: null };

  const levels = await sql<Row[]>`
    SELECT state FROM approvals WHERE entity_type = ${entityType} AND entity_id = ${a.id as number}`;

  if (levels.some(l => l.state === 'REJECTED')) {
    return { award: a, cleared: false, reason: 'The award was rejected. Award a different quotation.' };
  }
  if (levels.some(l => l.state === 'PENDING')) {
    const what = entityType === 'NON_LOWEST_AWARD' ? 'non-lowest award' : 'quotation waiver';
    return { award: a, cleared: false, reason: `The ${what} is still waiting for approval.` };
  }

  return { award: a, cleared: true, reason: null };
}

export function listQuotations(prId: number): Promise<Row[]> {
  return sql<Row[]>`
    SELECT q.*, v.legal_name AS vendor_name, v.vendor_code, u.full_name AS entered_by_name
      FROM quotations q
      JOIN vendors v   ON v.id = q.vendor_id
      JOIN app_users u ON u.id = q.entered_by
     WHERE q.pr_id = ${prId}
     ORDER BY q.created_at`;
}
