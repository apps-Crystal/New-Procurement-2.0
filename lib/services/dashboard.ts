/**
 * Dashboard metrics (brief §24).
 *
 * Every figure on the dashboard comes from a query in this file. Nothing is
 * computed in the component, nothing is a constant, and nothing is an estimate.
 * That is the phase gate, and it is enforced two ways:
 *
 *   - each metric carries the NAME of the query that produced it, so a tile can
 *     be traced to its source without reading the code;
 *   - an architecture test refuses a numeric literal used as a metric value
 *     anywhere in the dashboard components.
 *
 * One query per group rather than one per tile. Twenty-four round trips to draw
 * a home page is a home page nobody keeps open, and every group's metrics come
 * off the same few tables anyway.
 *
 * Site scoping runs through every query: a Site Manager at Dhulagarh sees
 * Dhulagarh's numbers, and a group-wide role sees the group's. A dashboard that
 * quietly showed more than the screens behind it would be worse than no
 * dashboard — every tile is a link, and a link to something you cannot open is
 * a bug you find by clicking.
 */
import { sql } from '@/lib/db';
import type { Principal } from '@/lib/auth/permissions';
import type { Row } from '@/lib/services/masters';

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export interface Metric {
  /** Stable identifier, so a tile can be referred to in a bug report. */
  key: string;
  label: string;
  /** Always a string: money and quantities are never JS floats (§31). */
  value: string;
  /** How to read it. */
  hint: string;
  tone?: Tone;
  /** Where to go and do something about it. */
  href?: string;
  /** The query this came from — the §24 traceability requirement, literally. */
  query: string;
  /** Rendered as money rather than a count. */
  money?: boolean;
}

export interface MetricGroup {
  key: string;
  label: string;
  metrics: Metric[];
}

/** Sites the caller may see, or null for a group-wide role. */
function scope(principal: Principal): number[] | null {
  return principal.groupWide ? null : principal.sites.map(s => s.siteId);
}

const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const count = (v: unknown) => String(Number(v ?? 0));

// =============================================================================
// 1. Procurement
// =============================================================================

export async function procurementMetrics(principal: Principal): Promise<MetricGroup> {
  const sites = scope(principal);

  const [r] = await sql<Row[]>`
    SELECT
      (SELECT count(*) FROM material_requests m
        WHERE m.status = 'MR_DECLARED'
          AND (${sites}::bigint[] IS NULL OR m.site_id = ANY(${sites})))          AS mr_awaiting,
      (SELECT count(*) FROM material_requests m
        WHERE m.status IN ('MR_STOCK_PARTIAL', 'MR_STOCK_UNAVAILABLE')
          AND (${sites}::bigint[] IS NULL OR m.site_id = ANY(${sites})))          AS mr_to_declare,
      (SELECT count(*) FROM purchase_requests p
        WHERE p.status = 'PR_SUBMITTED'
          AND (${sites}::bigint[] IS NULL OR p.site_id = ANY(${sites})))          AS pr_awaiting,
      (SELECT coalesce(sum(t.total_incl_gst), 0) FROM purchase_requests p
         JOIN v_pr_totals t ON t.pr_id = p.id
        WHERE p.status IN ('PR_SUBMITTED', 'PR_APPROVED')
          AND (${sites}::bigint[] IS NULL OR p.site_id = ANY(${sites})))          AS pr_value,
      (SELECT count(*) FROM purchase_requests p
        WHERE p.status = 'PR_APPROVED'
          AND (${sites}::bigint[] IS NULL OR p.site_id = ANY(${sites})))          AS awaiting_quotes,
      (SELECT count(*) FROM purchase_orders po
        WHERE po.status = 'PO_DRAFT'
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS po_unissued`;

  const q = 'procurementMetrics';

  return {
    key: 'procurement',
    label: 'Procurement',
    metrics: [
      {
        key: 'mr_awaiting', label: 'Requests to approve', value: count(r.mr_awaiting),
        hint: 'Declared and waiting on a site manager', query: q, href: '/mr?status=MR_DECLARED',
        tone: Number(r.mr_awaiting) > 0 ? 'warn' : undefined,
      },
      {
        key: 'mr_to_declare', label: 'Stock-checked, undeclared', value: count(r.mr_to_declare),
        hint: 'Need a business impact declaration before they move', query: q, href: '/mr',
      },
      {
        key: 'pr_awaiting', label: 'Purchase requests in approval', value: count(r.pr_awaiting),
        hint: 'Somewhere in their approval chain', query: q, href: '/pr?status=PR_SUBMITTED',
        tone: Number(r.pr_awaiting) > 0 ? 'warn' : undefined,
      },
      {
        key: 'pr_value', label: 'Value in flight', value: money(r.pr_value), money: true,
        hint: 'Submitted and approved requests, from v_pr_totals', query: q, href: '/pr',
      },
      {
        key: 'awaiting_quotes', label: 'Awaiting quotation', value: count(r.awaiting_quotes),
        hint: 'Approved, no order raised yet', query: q, href: '/quotations',
        tone: Number(r.awaiting_quotes) > 0 ? 'info' : undefined,
      },
      {
        key: 'po_unissued', label: 'Orders not issued', value: count(r.po_unissued),
        hint: 'Drafted, awaiting a Tally reference', query: q, href: '/po?status=PO_DRAFT',
        tone: Number(r.po_unissued) > 0 ? 'warn' : undefined,
      },
    ],
  };
}

// =============================================================================
// 2. Receiving
// =============================================================================

export async function receivingMetrics(principal: Principal): Promise<MetricGroup> {
  const sites = scope(principal);

  const [r] = await sql<Row[]>`
    SELECT
      (SELECT count(*) FROM purchase_orders po
         JOIN v_po_line_receipt v ON v.po_id = po.id
        WHERE po.status IN ('PO_CREATED', 'PO_PARTIALLY_RECEIVED') AND v.qty_outstanding > 0
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS expected,
      (SELECT count(*) FROM gate_inwards g
        WHERE g.status = 'QC_PENDING'
          AND (${sites}::bigint[] IS NULL OR g.site_id = ANY(${sites})))          AS awaiting_qc,
      (SELECT count(*) FROM qc_inspections q
         JOIN gate_inwards g ON g.id = q.gate_inward_id
        WHERE q.completed_at IS NULL AND q.sla_due_at < now()
          AND (${sites}::bigint[] IS NULL OR g.site_id = ANY(${sites})))          AS qc_overdue,
      (SELECT count(*) FROM qc_lines l
         JOIN qc_inspections q ON q.id = l.qc_id
         JOIN gate_inwards g   ON g.id = q.gate_inward_id
        WHERE l.qty_hold > 0 AND l.reason_code IS DISTINCT FROM 'PENDING_INSPECTION'
          AND NOT EXISTS (SELECT 1 FROM qc_hold_decisions d WHERE d.qc_line_id = l.id)
          AND (${sites}::bigint[] IS NULL OR g.site_id = ANY(${sites})))          AS holds,
      (SELECT count(*) FROM grns gr
        WHERE gr.status IN ('GRN_DRAFT', 'GRN_FLAGGED')
          AND (${sites}::bigint[] IS NULL OR gr.site_id = ANY(${sites})))         AS grn_open,
      (SELECT count(*) FROM shortfall_cases c
         JOIN gate_inward_lines gl ON gl.id = c.gate_inward_line_id
         JOIN gate_inwards g       ON g.id = gl.gate_inward_id
        WHERE c.decision = 'PENDING'
          AND (${sites}::bigint[] IS NULL OR g.site_id = ANY(${sites})))          AS shortfalls`;

  const q = 'receivingMetrics';

  return {
    key: 'receiving',
    label: 'Receiving',
    metrics: [
      {
        key: 'expected', label: 'Deliveries expected', value: count(r.expected),
        hint: 'Issued orders with something still outstanding', query: q, href: '/po',
      },
      {
        key: 'awaiting_qc', label: 'Waiting for inspection', value: count(r.awaiting_qc),
        hint: 'Counted at the gate, handed to QC', query: q, href: '/gate-inward?status=QC_PENDING',
        tone: Number(r.awaiting_qc) > 0 ? 'warn' : undefined,
      },
      {
        key: 'qc_overdue', label: 'Inspections past SLA', value: count(r.qc_overdue),
        hint: '4 hours cold chain, 48 ambient', query: q, href: '/qc',
        tone: Number(r.qc_overdue) > 0 ? 'bad' : 'ok',
      },
      {
        key: 'holds', label: 'Conditional holds', value: count(r.holds),
        hint: 'Waiting on a site manager to decide', query: q, href: '/qc',
        tone: Number(r.holds) > 0 ? 'warn' : undefined,
      },
      {
        key: 'grn_open', label: 'Receipts to approve', value: count(r.grn_open),
        hint: 'No stock posted until they are', query: q, href: '/grn?status=GRN_DRAFT',
        tone: Number(r.grn_open) > 0 ? 'warn' : undefined,
      },
      {
        key: 'shortfalls', label: 'Shortfalls undecided', value: count(r.shortfalls),
        hint: 'Short against the challan, no decision yet', query: q, href: '/shortfalls',
        tone: Number(r.shortfalls) > 0 ? 'warn' : undefined,
      },
    ],
  };
}

// =============================================================================
// 3. Inventory
// =============================================================================

export async function inventoryMetrics(principal: Principal): Promise<MetricGroup> {
  const sites = scope(principal);

  const [r] = await sql<Row[]>`
    SELECT
      -- Balances directly, never v_stock_position: that view cross-joins sites
      -- to items and is only ever read one site at a time (conflict C-21).
      (SELECT count(DISTINCT (b.site_id, b.item_id)) FROM stock_balances b
        WHERE b.bucket = 'AVAILABLE' AND b.qty > 0
          AND (${sites}::bigint[] IS NULL OR b.site_id = ANY(${sites})))          AS items_held,
      (SELECT count(*) FROM item_site_settings iss
         LEFT JOIN stock_balances b
           ON b.site_id = iss.site_id AND b.item_id = iss.item_id AND b.bucket = 'AVAILABLE'
        WHERE iss.reorder_level > 0 AND coalesce(b.qty, 0) < iss.reorder_level
          AND (${sites}::bigint[] IS NULL OR iss.site_id = ANY(${sites})))        AS below_reorder,
      (SELECT coalesce(sum(b.qty), 0) FROM stock_balances b
        WHERE b.bucket = 'IN_TRANSIT'
          AND (${sites}::bigint[] IS NULL OR b.site_id = ANY(${sites})))          AS in_transit,
      (SELECT coalesce(sum(d.estimated_value), 0) FROM damage_reports d
        WHERE d.status NOT IN ('DMG_CLOSED', 'DMG_WRITTEN_OFF')
          AND (${sites}::bigint[] IS NULL OR d.site_id = ANY(${sites})))          AS damaged_value,
      (SELECT count(*) FROM stock_transfers t
        WHERE t.status IN ('TRF_REQUESTED', 'TRF_APPROVED', 'TRF_DISPATCHED')
          AND (${sites}::bigint[] IS NULL
               OR t.from_site_id = ANY(${sites}) OR t.to_site_id = ANY(${sites}))) AS transfers_open,
      (SELECT count(*) FROM asset_units a
        WHERE a.bucket <> 'WRITTEN_OFF'
          AND (${sites}::bigint[] IS NULL OR a.site_id = ANY(${sites})))          AS assets`;

  const q = 'inventoryMetrics';

  return {
    key: 'inventory',
    label: 'Inventory',
    metrics: [
      {
        key: 'items_held', label: 'Items in stock', value: count(r.items_held),
        hint: 'Distinct item and site pairs holding something', query: q, href: '/inventory',
      },
      {
        key: 'below_reorder', label: 'Below reorder level', value: count(r.below_reorder),
        hint: 'Should be on a material request', query: q, href: '/inventory',
        tone: Number(r.below_reorder) > 0 ? 'bad' : 'ok',
      },
      {
        key: 'in_transit', label: 'In transit', value: count(r.in_transit),
        hint: 'Dispatched between sites, not yet received', query: q, href: '/transfers',
        tone: Number(r.in_transit) > 0 ? 'info' : undefined,
      },
      {
        key: 'damaged_value', label: 'Quarantined value', value: money(r.damaged_value), money: true,
        hint: 'Damage reported and not yet settled', query: q, href: '/damage',
        tone: Number(r.damaged_value) > 0 ? 'warn' : undefined,
      },
      {
        key: 'transfers_open', label: 'Transfers open', value: count(r.transfers_open),
        hint: 'Requested, approved or in transit', query: q, href: '/transfers',
      },
      {
        key: 'assets', label: 'Serialised units', value: count(r.assets),
        hint: 'On the asset register, excluding written off', query: q, href: '/inventory/assets',
      },
    ],
  };
}

// =============================================================================
// 4. Returns
// =============================================================================

export async function returnsMetrics(principal: Principal): Promise<MetricGroup> {
  const sites = scope(principal);

  const [r] = await sql<Row[]>`
    SELECT
      (SELECT count(*) FROM damage_reports d
        WHERE d.status = 'DMG_REPORTED'
          AND (${sites}::bigint[] IS NULL OR d.site_id = ANY(${sites})))          AS awaiting_inspection,
      (SELECT count(*) FROM damage_reports d
        WHERE d.status = 'DMG_DECISION_PENDING_APPROVAL'
          AND (${sites}::bigint[] IS NULL OR d.site_id = ANY(${sites})))          AS awaiting_decision,
      (SELECT count(*) FROM purchase_returns rt
        WHERE rt.status = 'RTV_DRAFT'
          AND (${sites}::bigint[] IS NULL OR rt.site_id = ANY(${sites})))         AS rtv_draft,
      (SELECT count(*) FROM purchase_returns rt
        WHERE rt.status IN ('RTV_DISPATCHED', 'RTV_ACKNOWLEDGED')
          AND (${sites}::bigint[] IS NULL OR rt.site_id = ANY(${sites})))         AS rtv_with_vendor,
      (SELECT coalesce(sum(round(l.qty * l.unit_rate * (1 + l.gst_rate / 100), 2)), 0)
         FROM purchase_return_lines l
         JOIN purchase_returns rt ON rt.id = l.rtv_id
        WHERE rt.status NOT IN ('RTV_CANCELLED', 'RTV_CLOSED')
          AND (${sites}::bigint[] IS NULL OR rt.site_id = ANY(${sites})))         AS rtv_value,
      (SELECT count(*) FROM damage_reports d
        WHERE d.status = 'DMG_UNDER_REPAIR'
          AND (${sites}::bigint[] IS NULL OR d.site_id = ANY(${sites})))          AS under_repair`;

  const q = 'returnsMetrics';

  return {
    key: 'returns',
    label: 'Damage and returns',
    metrics: [
      {
        key: 'awaiting_inspection', label: 'Damage to inspect', value: count(r.awaiting_inspection),
        hint: 'Needs a site manager and a QC inspector', query: q, href: '/damage?status=DMG_REPORTED',
        tone: Number(r.awaiting_inspection) > 0 ? 'warn' : undefined,
      },
      {
        key: 'awaiting_decision', label: 'Decisions to approve', value: count(r.awaiting_decision),
        hint: 'Repair, warranty claim or write-off', query: q, href: '/damage',
        tone: Number(r.awaiting_decision) > 0 ? 'warn' : undefined,
      },
      {
        key: 'under_repair', label: 'Under repair', value: count(r.under_repair),
        hint: 'Out of stock until it comes back', query: q, href: '/damage',
      },
      {
        key: 'rtv_draft', label: 'Returns to approve', value: count(r.rtv_draft),
        hint: 'No gate pass until they are', query: q, href: '/returns?status=RTV_DRAFT',
        tone: Number(r.rtv_draft) > 0 ? 'warn' : undefined,
      },
      {
        key: 'rtv_with_vendor', label: 'With the vendor', value: count(r.rtv_with_vendor),
        hint: 'Dispatched or acknowledged, not yet settled', query: q, href: '/returns',
      },
      {
        key: 'rtv_value', label: 'Value out on return', value: money(r.rtv_value), money: true,
        hint: 'Open returns, including tax', query: q, href: '/returns',
      },
    ],
  };
}

// =============================================================================
// 5. Accounts
// =============================================================================

export async function accountsMetrics(principal: Principal): Promise<MetricGroup> {
  const sites = scope(principal);

  const [r] = await sql<Row[]>`
    SELECT
      (SELECT count(*) FROM vendor_invoices i
         JOIN purchase_orders po ON po.id = i.po_id
        WHERE i.status = 'INV_RECEIVED'
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS to_match,
      (SELECT coalesce(sum(i.total - i.held_amount), 0) FROM vendor_invoices i
         JOIN purchase_orders po ON po.id = i.po_id
        WHERE i.status <> 'INV_PAID'
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS open_payable,
      (SELECT coalesce(sum(i.held_amount), 0) FROM vendor_invoices i
         JOIN purchase_orders po ON po.id = i.po_id
        WHERE i.status <> 'INV_PAID'
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS withheld,
      (SELECT count(*) FROM vendor_invoices i
         JOIN purchase_orders po ON po.id = i.po_id
        WHERE i.status = 'INV_DISPUTED'
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS disputed,
      (SELECT count(*) FROM debit_notes d
         JOIN purchase_orders po ON po.id = d.po_id
        WHERE d.status = 'DEBIT_NOTE_PENDING'
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS dn_pending,
      -- Conflict C-14: a credit note short by more than 2% blocks reconciling
      -- until a Functional Head accepts it. This counts what is stuck.
      (SELECT count(*) FROM debit_notes d
         JOIN purchase_orders po ON po.id = d.po_id
         JOIN LATERAL (
           SELECT * FROM vendor_credit_notes c
            WHERE c.debit_note_id = d.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1
         ) cn ON true
        WHERE d.status NOT IN ('DN_RECONCILED', 'DN_CANCELLED')
          AND cn.variance_flagged AND cn.accepted_short_by IS NULL
          AND (${sites}::bigint[] IS NULL OR po.site_id = ANY(${sites})))         AS variance_blocked`;

  const q = 'accountsMetrics';

  return {
    key: 'accounts',
    label: 'Accounts',
    metrics: [
      {
        key: 'to_match', label: 'Invoices to match', value: count(r.to_match),
        hint: 'Booked, not yet checked against receipts', query: q, href: '/invoices?status=INV_RECEIVED',
        tone: Number(r.to_match) > 0 ? 'warn' : undefined,
      },
      {
        key: 'open_payable', label: 'Open payable', value: money(r.open_payable), money: true,
        hint: 'Unpaid invoices, net of what is withheld', query: q, href: '/invoices',
      },
      {
        key: 'withheld', label: 'Withheld', value: money(r.withheld), money: true,
        hint: 'Held against returns and shortfalls', query: q, href: '/invoices?status=INV_PARTIALLY_HELD',
        tone: Number(r.withheld) > 0 ? 'info' : undefined,
      },
      {
        key: 'disputed', label: 'Invoices disputed', value: count(r.disputed),
        hint: 'Still booked; the payable stands until settled', query: q, href: '/invoices?status=INV_DISPUTED',
        tone: Number(r.disputed) > 0 ? 'bad' : undefined,
      },
      {
        key: 'dn_pending', label: 'Debit notes to issue', value: count(r.dn_pending),
        hint: 'Raised but the vendor has not been told', query: q, href: '/notes?status=DEBIT_NOTE_PENDING',
        tone: Number(r.dn_pending) > 0 ? 'warn' : undefined,
      },
      {
        key: 'variance_blocked', label: 'Blocked on credit variance', value: count(r.variance_blocked),
        hint: 'Short by over 2%, needs a Functional Head', query: q, href: '/notes',
        tone: Number(r.variance_blocked) > 0 ? 'bad' : 'ok',
      },
    ],
  };
}

// =============================================================================
// 6. Vendors and quality
// =============================================================================

export async function qualityMetrics(principal: Principal): Promise<MetricGroup> {
  const sites = scope(principal);

  const [r] = await sql<Row[]>`
    SELECT
      (SELECT count(*) FROM vendors v WHERE v.status = 'VENDOR_APPROVED')         AS approved,
      (SELECT count(*) FROM vendors v WHERE v.status = 'VENDOR_PENDING')          AS pending,
      (SELECT count(*) FROM vendors v WHERE v.status = 'VENDOR_BLOCKED')          AS blocked,
      -- From v_vendor_scorecard, which derives rejection from real QC history
      -- rather than the prototype's hardcoded table.
      (SELECT round(
                100.0 * coalesce(sum(sc.qty_rejected), 0)
                      / nullif(sum(sc.qty_delivered), 0), 2)
         FROM v_vendor_scorecard sc)                                              AS rejection_pct,
      (SELECT count(*) FROM vendor_recon_runs rr
        WHERE rr.status IN ('RECON_OPEN', 'RECON_DIFFERENCE')
          AND rr.portal_balance <> rr.tally_balance)                              AS recon_out,
      (SELECT count(*) FROM qc_lines l
         JOIN qc_inspections q ON q.id = l.qc_id
         JOIN gate_inwards g   ON g.id = q.gate_inward_id
        WHERE l.qty_rejected > 0 AND q.completed_at > now() - interval '30 days'
          AND (${sites}::bigint[] IS NULL OR g.site_id = ANY(${sites})))          AS rejections_30d`;

  const q = 'qualityMetrics';

  return {
    key: 'quality',
    label: 'Vendors and quality',
    metrics: [
      {
        key: 'approved', label: 'Approved vendors', value: count(r.approved),
        hint: 'Can be ordered from', query: q, href: '/vendors?status=VENDOR_APPROVED', tone: 'ok',
      },
      {
        key: 'pending', label: 'Awaiting approval', value: count(r.pending),
        hint: 'Need a second pair of eyes', query: q, href: '/vendors?status=VENDOR_PENDING',
        tone: Number(r.pending) > 0 ? 'warn' : undefined,
      },
      {
        key: 'blocked', label: 'Blocked', value: count(r.blocked),
        hint: 'Cannot appear on an order', query: q, href: '/vendors?status=VENDOR_BLOCKED',
        tone: Number(r.blocked) > 0 ? 'bad' : undefined,
      },
      {
        key: 'rejection_pct', label: 'Group rejection rate', value: money(r.rejection_pct),
        hint: 'Rejected over delivered, from v_vendor_scorecard', query: q, href: '/vendors',
        tone: Number(r.rejection_pct ?? 0) > 5 ? 'bad' : 'ok',
      },
      {
        key: 'rejections_30d', label: 'Lines rejected, 30 days', value: count(r.rejections_30d),
        hint: 'QC verdicts with something sent back', query: q, href: '/qc',
      },
      {
        key: 'recon_out', label: 'Reconciliations out', value: count(r.recon_out),
        hint: 'Portal and Tally disagree', query: q, href: '/reconciliation',
        tone: Number(r.recon_out) > 0 ? 'bad' : 'ok',
      },
    ],
  };
}

// =============================================================================
// The whole board
// =============================================================================

/**
 * Every group, in parallel.
 *
 * Six queries, one per group. They are independent, so they go together rather
 * than in sequence — the slowest one sets the page's speed either way.
 */
export async function dashboard(principal: Principal): Promise<MetricGroup[]> {
  return Promise.all([
    procurementMetrics(principal),
    receivingMetrics(principal),
    inventoryMetrics(principal),
    returnsMetrics(principal),
    accountsMetrics(principal),
    qualityMetrics(principal),
  ]);
}
