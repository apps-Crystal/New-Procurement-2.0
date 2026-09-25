/**
 * Purchase order (brief §11).
 *
 * PO_DRAFT → PO_CREATED → PO_PARTIALLY_RECEIVED → PO_RECEIVED → PO_CLOSED
 *                       ↘ PO_SHORT_CLOSED
 *
 * Constraints the schema holds and this module works within:
 *
 * `purchase_orders.pr_id` is NOT NULL **UNIQUE** — exactly one PO per PR
 * (conflict register C-17). Splitting a requirement across two vendors means
 * splitting the MR into two PRs; there is no second PO.
 *
 * `check_po_vendor()` is a trigger refusing any vendor that is not
 * VENDOR_APPROVED, on insert and on any change of vendor.
 *
 * `po_issue_needs_tally` refuses any status past PO_DRAFT without
 * `tally_po_ref`. The prototype's "Checks before issue" list ends on exactly
 * this item.
 *
 * Received quantity is never stored. `v_po_line_receipt` sums accepted
 * quantities from GRNs that are APPROVED or CLOSED — a flagged or draft GRN
 * contributes nothing, which is the v1.0 rule carried forward.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/notify';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { normaliseText } from '@/lib/validate';
import { awardCleared } from '@/lib/services/quotations';
import { assertVendorOrderable } from '@/lib/services/vendors';
import type { Actor, Row } from '@/lib/services/masters';

const ENTITY = 'PO';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with purchase orders.');
  }
}

async function loadPo(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM purchase_orders WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM purchase_orders WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That purchase order no longer exists.');
  return rows[0];
}

// =============================================================================
// Create
// =============================================================================

export interface PoInput {
  prId: number;
  expectedDelivery: string;
  freightTerms?: string | null;
  installationTerms?: string | null;
  /** Per-line overrides. A rate differing from the award needs a remark. */
  lineOverrides?: { prLineId: number; rate: string; remark: string }[];
}

/**
 * Draft a PO from the awarded quotation.
 *
 * Quantities come from the PR and rates from the awarded quote. A buyer may
 * override a rate, but `po_lines.rate_deviation_remark` exists precisely so a
 * departure from the awarded price is explained rather than silent.
 */
export async function createPo(actor: Actor, input: PoInput): Promise<Row> {
  return inTransaction(async tx => {
    const [pr] = await tx<Row[]>`SELECT * FROM purchase_requests WHERE id = ${input.prId} FOR UPDATE`;
    if (!pr) throw notFound('That purchase request no longer exists.');

    const siteId = Number(pr.site_id);
    requirePermission(actor, 'PO.CREATE', siteId);

    if (pr.status !== 'PR_APPROVED') {
      throw conflict(`${pr.pr_no} is ${pr.status} — a purchase order needs an approved request.`);
    }

    const [existing] = await tx<Row[]>`SELECT po_no FROM purchase_orders WHERE pr_id = ${input.prId}`;
    if (existing) {
      throw conflict(
        `${pr.pr_no} already has purchase order ${existing.po_no}. Only one is allowed per request.`,
      );
    }

    const { award, cleared, reason } = await awardCleared(input.prId);
    if (!award) throw badRequest('Award a quotation before raising the purchase order.');
    if (!cleared) throw conflict(reason ?? 'The award is not cleared for a purchase order.');

    const [quotation] = await tx<Row[]>`
      SELECT q.*, v.legal_name FROM quotations q JOIN vendors v ON v.id = q.vendor_id
       WHERE q.id = ${award.quotation_id as number}`;

    // check_po_vendor() would refuse this, but a named vendor reads better.
    await assertVendorOrderable(Number(quotation.vendor_id));

    const poNo = await nextDocumentNoForSite(tx, ENTITY, siteId);

    const [po] = await tx<Row[]>`
      INSERT INTO purchase_orders (po_no, pr_id, award_id, vendor_id, site_id, expected_delivery,
                                   freight_terms, installation_terms, freight_amount, status, buyer_id)
      VALUES (${poNo}, ${input.prId}, ${award.id as number}, ${quotation.vendor_id as number}, ${siteId},
              ${input.expectedDelivery}::date, ${input.freightTerms?.trim() || null},
              ${input.installationTerms?.trim() || null}, ${quotation.freight_amount as string}::numeric,
              'PO_DRAFT', ${actor.principal.userId})
      RETURNING *`;

    const overrides = new Map((input.lineOverrides ?? []).map(o => [o.prLineId, o]));

    const lines = await tx<Row[]>`
      SELECT pl.id AS pr_line_id, pl.line_no, pl.item_id, pl.qty,
             ql.unit_rate AS awarded_rate, ql.gst_rate
        FROM pr_lines pl
        JOIN quotation_lines ql ON ql.pr_line_id = pl.id AND ql.quotation_id = ${award.quotation_id as number}
       WHERE pl.pr_id = ${input.prId}
       ORDER BY pl.line_no`;

    for (const line of lines) {
      const override = overrides.get(Number(line.pr_line_id));
      const rate = override?.rate ?? String(line.awarded_rate);

      if (override && !override.remark?.trim()) {
        throw badRequest(
          'A rate that differs from the awarded quotation needs a remark explaining why.',
          'rate_deviation_remark',
        );
      }

      await tx`
        INSERT INTO po_lines (po_id, line_no, pr_line_id, item_id, qty_ordered, rate, gst_rate,
                              rate_deviation_remark)
        VALUES (${po.id as number}, ${line.line_no as number}, ${line.pr_line_id as number},
                ${line.item_id as number}, ${line.qty as string}::numeric, ${rate}::numeric,
                ${line.gst_rate as string}::numeric, ${override?.remark?.trim() || null})`;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: Number(po.id), action: 'CREATE',
      after: { po_no: poNo, pr_no: pr.pr_no, vendor: quotation.legal_name, lines: lines.length },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return po;
  });
}

// =============================================================================
// Issue
// =============================================================================

export interface IssueChecks {
  label: string;
  passed: boolean;
  detail?: string;
}

/**
 * The prototype's "Checks before issue" panel, computed rather than hardcoded.
 *
 * Every item is a real query. The last one is the Tally reference, which is
 * also a database constraint — the others are checks the schema cannot express
 * but a buyer should see before committing.
 */
export async function issueChecks(poId: number): Promise<IssueChecks[]> {
  const [po] = await sql<Row[]>`
    SELECT po.*, v.status AS vendor_status, v.legal_name, v.pan, v.gstin, v.blocked_reason,
           a.is_lowest, a.waiver_reason, pr.pr_no
      FROM purchase_orders po
      JOIN vendors v            ON v.id = po.vendor_id
      JOIN purchase_requests pr ON pr.id = po.pr_id
      LEFT JOIN quote_awards a  ON a.id = po.award_id
     WHERE po.id = ${poId}`;
  if (!po) throw notFound('That purchase order no longer exists.');

  const { cleared, reason } = await awardCleared(Number(po.pr_id));

  const [qty] = await sql<{ mismatched: string }[]>`
    SELECT count(*)::text AS mismatched
      FROM po_lines pol JOIN pr_lines prl ON prl.id = pol.pr_line_id
     WHERE pol.po_id = ${poId} AND pol.qty_ordered <> prl.qty`;

  const [deviations] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM po_lines WHERE po_id = ${poId} AND rate_deviation_remark IS NOT NULL`;

  return [
    {
      label: 'Vendor approved, active and not blocked',
      passed: po.vendor_status === 'VENDOR_APPROVED',
      detail: po.vendor_status === 'VENDOR_APPROVED' ? undefined : `${po.legal_name} is ${po.vendor_status}`,
    },
    {
      label: 'PAN and GSTIN recorded in the vendor master',
      passed: !!po.pan && !!po.gstin,
      detail: po.gstin ? undefined : 'No GSTIN — this vendor is unregistered',
    },
    {
      label: 'Quantities match the approved purchase request',
      passed: Number(qty.mismatched) === 0,
      detail: Number(qty.mismatched) === 0 ? undefined : `${qty.mismatched} line(s) differ`,
    },
    {
      label: 'Rates match the awarded quotation',
      passed: Number(deviations.n) === 0,
      detail: Number(deviations.n) === 0 ? undefined : `${deviations.n} line(s) overridden with a remark`,
    },
    {
      label: 'Award cleared for ordering',
      passed: cleared,
      detail: reason ?? undefined,
    },
    {
      label: 'Tally PO reference entered',
      passed: !!po.tally_po_ref,
      detail: po.tally_po_ref ? String(po.tally_po_ref) : 'Required before the order can be issued',
    },
  ];
}

/**
 * Issue the PO to the vendor.
 *
 * `po_issue_needs_tally` makes the reference mandatory past PO_DRAFT, and
 * `purchase_orders.tally_po_ref` is UNIQUE, so the same reference cannot be
 * attached to two orders.
 */
export async function issuePo(actor: Actor, poId: number, tallyPoRef: string): Promise<Row> {
  return inTransaction(async tx => {
    const po = await loadPo(tx, poId, true);
    const siteId = Number(po.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(po.status), to: 'PO_CREATED', principal: actor.principal, siteId },
      tx,
    );

    const ref = normaliseText(tallyPoRef ?? '');
    if (!ref) {
      throw badRequest('The Tally PO reference is required before this order can be issued.', 'tally_po_ref');
    }

    const { cleared, reason } = await awardCleared(Number(po.pr_id));
    if (!cleared) throw conflict(reason ?? 'The award is not cleared for issue.');

    await assertVendorOrderable(Number(po.vendor_id));

    const [updated] = await tx<Row[]>`
      UPDATE purchase_orders
         SET status = 'PO_CREATED', tally_po_ref = ${ref}, issued_at = now()
       WHERE id = ${poId}
      RETURNING *`;

    // The PR has done its job once the order exists.
    const [pr] = await tx<Row[]>`
      UPDATE purchase_requests SET status = 'PO_POSTED'
       WHERE id = ${po.pr_id as number} RETURNING id, pr_no, status`;

    await audit(tx, {
      entityType: ENTITY, entityId: poId, action: 'TRANSITION',
      fromStatus: String(po.status), toStatus: 'PO_CREATED',
      after: { tally_po_ref: ref },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Issued against Tally reference ${ref}`,
    });
    await enqueue(tx, {
      eventKey: 'PO_ISSUED', entityType: 'PO', entityId: poId,
      payload: { reference: String(po.po_no), tally_ref: ref },
    });

    // The purchase request moved too, and its own history has to say so —
    // otherwise it ends at PR_APPROVED with nothing explaining why it closed.
    await audit(tx, {
      entityType: 'PR', entityId: Number(po.pr_id), action: 'TRANSITION',
      fromStatus: 'PR_APPROVED', toStatus: 'PO_POSTED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Order ${po.po_no} issued against this request`,
    });

    void pr;

    return updated;
  });
}

export async function shortClosePo(actor: Actor, poId: number, reason: string): Promise<Row> {
  return inTransaction(async tx => {
    const po = await loadPo(tx, poId, true);
    const siteId = Number(po.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(po.status), to: 'PO_SHORT_CLOSED', principal: actor.principal, siteId },
      tx,
    );

    const text = normaliseText(reason ?? '');
    if (!text) throw badRequest('Short-closing a purchase order requires a reason.', 'short_close_reason');

    const [updated] = await tx<Row[]>`
      UPDATE purchase_orders SET status = 'PO_SHORT_CLOSED', short_close_reason = ${text}
       WHERE id = ${poId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: poId, action: 'TRANSITION',
      fromStatus: String(po.status), toStatus: 'PO_SHORT_CLOSED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

export async function cancelPo(actor: Actor, poId: number, reason: string): Promise<Row> {
  return inTransaction(async tx => {
    const po = await loadPo(tx, poId, true);
    const siteId = Number(po.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(po.status), to: 'PO_CANCELLED', principal: actor.principal, siteId },
      tx,
    );

    const text = normaliseText(reason ?? '');
    if (!text) throw badRequest('Cancelling a purchase order requires a reason.', 'reason');

    const [updated] = await tx<Row[]>`
      UPDATE purchase_orders SET status = 'PO_CANCELLED', cancelled_reason = ${text}
       WHERE id = ${poId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: poId, action: 'TRANSITION',
      fromStatus: String(po.status), toStatus: 'PO_CANCELLED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listPos(principal: Principal, filters: { status?: string; vendorId?: number } = {}): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT po.*, s.code AS site_code, s.name AS site_name, v.legal_name AS vendor_name, v.vendor_code,
           pr.pr_no, u.full_name AS buyer_name,
           (SELECT count(*) FROM po_lines l WHERE l.po_id = po.id)                       AS line_count,
           (SELECT coalesce(sum(round(l.qty_ordered * l.rate * (1 + l.gst_rate / 100), 2)), 0)
              FROM po_lines l WHERE l.po_id = po.id) + po.freight_amount                 AS total_incl_gst,
           (SELECT coalesce(sum(r.qty_outstanding), 0) FROM v_po_line_receipt r
             WHERE r.po_id = po.id)                                                      AS qty_outstanding
      FROM purchase_orders po
      JOIN sites s              ON s.id = po.site_id
      JOIN vendors v            ON v.id = po.vendor_id
      JOIN purchase_requests pr ON pr.id = po.pr_id
      JOIN app_users u          ON u.id = po.buyer_id
     WHERE (${siteIds}::bigint[] IS NULL OR po.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR po.status = ${filters.status ?? null}::po_status)
       AND (${filters.vendorId ?? null}::bigint IS NULL OR po.vendor_id = ${filters.vendorId ?? null})
     ORDER BY po.created_at DESC`;
}

export async function getPo(id: number): Promise<{ po: Row; lines: Row[]; checks: IssueChecks[] }> {
  const [po] = await sql<Row[]>`
    SELECT po.*, s.code AS site_code, s.name AS site_name, s.address AS site_address, s.gstin AS site_gstin,
           v.legal_name AS vendor_name, v.vendor_code, v.pan AS vendor_pan, v.gstin AS vendor_gstin,
           v.address AS vendor_address, pr.pr_no, m.mr_no, b.code AS budget_code,
           u.full_name AS buyer_name, q.vendor_quote_ref, q.payment_terms, q.warranty_months
      FROM purchase_orders po
      JOIN sites s               ON s.id = po.site_id
      JOIN vendors v             ON v.id = po.vendor_id
      JOIN purchase_requests pr  ON pr.id = po.pr_id
      JOIN material_requests m   ON m.id = pr.mr_id
      JOIN budget_codes b        ON b.id = pr.budget_code_id
      JOIN app_users u           ON u.id = po.buyer_id
      LEFT JOIN quote_awards a   ON a.id = po.award_id
      LEFT JOIN quotations q     ON q.id = a.quotation_id
     WHERE po.id = ${id}`;

  if (!po) throw notFound('That purchase order no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom,
           round(l.qty_ordered * l.rate, 2)                              AS line_taxable,
           round(l.qty_ordered * l.rate * l.gst_rate / 100, 2)           AS line_gst,
           round(l.qty_ordered * l.rate * (1 + l.gst_rate / 100), 2)     AS line_total,
           r.qty_received, r.qty_outstanding
      FROM po_lines l
      JOIN items i                ON i.id = l.item_id
      LEFT JOIN v_po_line_receipt r ON r.po_line_id = l.id
     WHERE l.po_id = ${id} ORDER BY l.line_no`;

  return { po, lines, checks: await issueChecks(id) };
}

/** Open POs with outstanding quantity — what the gate inward screen lists. */
export function expectedDeliveries(principal: Principal, siteId?: number): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT po.*, v.legal_name AS vendor_name, s.code AS site_code,
           (SELECT coalesce(sum(r.qty_outstanding), 0) FROM v_po_line_receipt r WHERE r.po_id = po.id) AS qty_outstanding,
           (po.expected_delivery < current_date) AS overdue
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      JOIN sites s   ON s.id = po.site_id
     WHERE po.status IN ('PO_CREATED', 'PO_PARTIALLY_RECEIVED')
       AND (${siteIds}::bigint[] IS NULL OR po.site_id = ANY(${siteIds}))
       AND (${siteId ?? null}::bigint IS NULL OR po.site_id = ${siteId ?? null})
       AND EXISTS (SELECT 1 FROM v_po_line_receipt r WHERE r.po_id = po.id AND r.qty_outstanding > 0)
     ORDER BY po.expected_delivery`;
}
