/**
 * Vendor invoices and the three-way match (brief §21).
 *
 * INV_RECEIVED → INV_MATCHED → INV_RELEASED → INV_PAID
 *              ↘ INV_DISPUTED   ↘ INV_PARTIALLY_HELD ↗
 *
 * The three-way match is purchase order, goods receipt, invoice. The schema
 * gives the first two: `po_lines.rate` is what was agreed and
 * `v_po_line_receipt.qty_received` is what actually arrived and was approved.
 * The invoice is the third, and the only one a vendor controls.
 *
 * What the schema enforces:
 *
 *   vendor_invoices_no_uq  UNIQUE INDEX on (vendor_id, upper(btrim(invoice_no)))
 *                          — the same invoice cannot be booked twice
 *   vi_tax_mode            CHECK — IGST or CGST+SGST, never both
 *   total                  GENERATED — the total cannot disagree with its parts
 *
 * What this module decides: which GST mode is correct. `vi_tax_mode` stops both
 * being used at once but has no opinion on which one applies. That depends on
 * whether the supply crossed a state line, which is a comparison between the
 * place of supply and the receiving site's own state — so it is derived here
 * and a mismatch is refused, rather than left to whoever types the numbers.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition, lockAndReadStatus } from '@/lib/transitions';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { postLedger } from '@/lib/services/ledger-accounts';
import { normaliseText, validateStateCode } from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'INVOICE';

/** Tolerance on a money comparison, in rupees. Below this, two figures agree. */
const PAISA = 0.01;

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with invoices.');
  }
}

async function loadInvoice(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM vendor_invoices WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM vendor_invoices WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That invoice no longer exists.');
  return rows[0];
}

// =============================================================================
// Record
// =============================================================================

export interface InvoiceInput {
  poId: number;
  invoiceNo: string;
  invoiceDate: string;
  placeOfSupply: string;
  taxableValue: string;
  cgst?: string;
  sgst?: string;
  igst?: string;
  billControlRef?: string | null;
}

/**
 * Book an invoice against a purchase order.
 *
 * The vendor comes from the order rather than the body: an invoice billed to
 * one order by a different vendor is not a data-entry slip to be recorded, it
 * is a document that should not be booked at all.
 */
export async function recordInvoice(actor: Actor, input: InvoiceInput): Promise<Row> {
  const invoiceNo = normaliseText(input.invoiceNo);
  const placeOfSupply = validateStateCode(input.placeOfSupply, 'place_of_supply');

  if (!invoiceNo) throw badRequest('The vendor’s invoice number is required.', 'invoice_no');

  const taxable = Number(input.taxableValue);
  const cgst = Number(input.cgst ?? 0);
  const sgst = Number(input.sgst ?? 0);
  const igst = Number(input.igst ?? 0);

  if (!Number.isFinite(taxable) || taxable <= 0) {
    throw badRequest('The taxable value must be more than zero.', 'taxable_value');
  }

  return inTransaction(async tx => {
    const [po] = await tx<Row[]>`
      SELECT po.*, s.state_code AS site_state, s.name AS site_name, v.legal_name AS vendor_name
        FROM purchase_orders po
        JOIN sites s   ON s.id = po.site_id
        JOIN vendors v ON v.id = po.vendor_id
       WHERE po.id = ${input.poId}`;
    if (!po) throw notFound('That purchase order no longer exists.');

    requirePermission(actor, 'INVOICE.CREATE', Number(po.site_id));

    // The unique index would catch this, but naming the existing invoice saves
    // Accounts hunting for why a number they are holding was refused.
    const [dup] = await tx<Row[]>`
      SELECT id, invoice_no, invoice_date, total FROM vendor_invoices
       WHERE vendor_id = ${po.vendor_id as number}
         AND upper(btrim(invoice_no)) = ${invoiceNo.toUpperCase()}`;
    if (dup) {
      throw conflict(
        `${po.vendor_name} invoice ${dup.invoice_no} dated ${String(dup.invoice_date)} is already booked for ₹${dup.total}. The same invoice cannot be booked twice.`,
      );
    }

    // C-? — the GST mode is derived, not accepted. An intra-state supply is
    // CGST plus SGST; anything crossing a state line is IGST. Getting this
    // wrong misstates the input tax credit, and neither the vendor nor the
    // typist is the right authority on it.
    const interState = placeOfSupply !== String(po.site_state);

    if (interState && (cgst > 0 || sgst > 0)) {
      throw badRequest(
        `This is an inter-state supply — place of supply ${placeOfSupply}, delivered to ${po.site_name} in state ${po.site_state}. It carries IGST, not CGST and SGST.`,
        'igst',
      );
    }
    if (!interState && igst > 0) {
      throw badRequest(
        `This is an intra-state supply — both the place of supply and ${po.site_name} are in state ${po.site_state}. It carries CGST and SGST, not IGST.`,
        'cgst',
      );
    }
    if (!interState && Math.abs(cgst - sgst) > PAISA) {
      throw badRequest(
        `CGST and SGST are always equal on an intra-state supply — these are ₹${cgst} and ₹${sgst}.`,
        'sgst',
      );
    }

    const [invoice] = await tx<Row[]>`
      INSERT INTO vendor_invoices (vendor_id, po_id, invoice_no, invoice_date, place_of_supply,
                                   taxable_value, cgst, sgst, igst, bill_control_ref, status)
      VALUES (${po.vendor_id as number}, ${input.poId}, ${invoiceNo}, ${input.invoiceDate}::date,
              ${placeOfSupply}, ${taxable.toFixed(2)}::numeric, ${cgst.toFixed(2)}::numeric,
              ${sgst.toFixed(2)}::numeric, ${igst.toFixed(2)}::numeric,
              ${input.billControlRef?.trim() || null}, 'INV_RECEIVED')
      RETURNING *`;

    // An invoice raises the payable.
    await postLedger(tx, {
      vendorId: Number(po.vendor_id),
      side: 'PORTAL',
      entryDate: input.invoiceDate,
      docType: 'INVOICE',
      docRef: invoiceNo,
      amount: String(invoice.total),
      poId: input.poId,
      sourceTable: 'vendor_invoices',
      sourceId: Number(invoice.id),
    });

    await audit(tx, {
      entityType: ENTITY, entityId: Number(invoice.id), action: 'CREATE',
      after: {
        invoice_no: invoiceNo, po: po.po_no, total: invoice.total,
        mode: interState ? 'IGST' : 'CGST+SGST',
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `${interState ? 'Inter' : 'Intra'}-state supply from ${po.vendor_name}`,
    });

    return invoice;
  });
}

// =============================================================================
// Three-way match
// =============================================================================

export interface MatchLine {
  itemCode: string;
  itemName: string;
  uom: string;
  qtyOrdered: string;
  qtyReceived: string;
  rate: string;
  receivedValue: string;
}

export interface MatchResult {
  lines: MatchLine[];
  /** What the goods actually received are worth at order rates. */
  receivedTaxable: string;
  /** What the vendor billed. */
  invoiceTaxable: string;
  difference: string;
  matches: boolean;
  /** Returns and short-closes already raised against this order. */
  heldAmount: string;
  debitNotes: Row[];
}

/**
 * Compare the order, the receipts and the invoice.
 *
 * Received quantity comes from `v_po_line_receipt`, which counts only APPROVED
 * and CLOSED goods receipts — so material sitting in the receiving bay, or on
 * an unapproved GRN, is not something a vendor can be paid for.
 *
 * The held amount is what has already been debited back: returns dispatched and
 * shortfalls short-closed. It is shown beside the difference because those two
 * together are usually the whole explanation for a mismatch.
 */
export async function threeWayMatch(invoiceId: number): Promise<MatchResult> {
  const [invoice] = await sql<Row[]>`
    SELECT * FROM vendor_invoices WHERE id = ${invoiceId}`;
  if (!invoice) throw notFound('That invoice no longer exists.');

  const lines = await sql<Row[]>`
    SELECT i.code AS item_code, i.name AS item_name, i.uom,
           pl.qty_ordered, pl.rate,
           coalesce(r.qty_received, 0) AS qty_received,
           round(coalesce(r.qty_received, 0) * pl.rate, 2) AS received_value
      FROM po_lines pl
      JOIN items i ON i.id = pl.item_id
      LEFT JOIN v_po_line_receipt r ON r.po_line_id = pl.id
     WHERE pl.po_id = ${invoice.po_id as number}
     ORDER BY pl.line_no`;

  const debitNotes = await sql<Row[]>`
    SELECT d.dn_no, d.total, d.status, d.created_at
      FROM debit_notes d
     WHERE d.po_id = ${invoice.po_id as number}
       AND d.status NOT IN ('DN_CANCELLED')
     ORDER BY d.created_at`;

  const receivedTaxable = lines.reduce((s, l) => s + Number(l.received_value), 0);
  const invoiceTaxable = Number(invoice.taxable_value);
  const difference = invoiceTaxable - receivedTaxable;
  const heldAmount = debitNotes.reduce((s, d) => s + Number(d.total), 0);

  return {
    lines: lines.map(l => ({
      itemCode: String(l.item_code),
      itemName: String(l.item_name),
      uom: String(l.uom),
      qtyOrdered: String(l.qty_ordered),
      qtyReceived: String(l.qty_received),
      rate: String(l.rate),
      receivedValue: String(l.received_value),
    })),
    receivedTaxable: receivedTaxable.toFixed(2),
    invoiceTaxable: invoiceTaxable.toFixed(2),
    difference: difference.toFixed(2),
    matches: Math.abs(difference) < PAISA,
    heldAmount: heldAmount.toFixed(2),
    debitNotes,
  };
}

/**
 * Accept the match.
 *
 * A mismatch is not blocked outright — the difference is often a legitimate
 * short delivery the vendor has already been debited for. But it cannot be
 * matched silently: an invoice that bills more than was received needs either a
 * debit note covering the gap, or a dispute.
 */
export async function matchInvoice(actor: Actor, invoiceId: number, remarks?: string): Promise<Row> {
  return inTransaction(async tx => {
    const invoice = await loadInvoice(tx, invoiceId, true);
    const [po] = await tx<Row[]>`SELECT site_id, po_no FROM purchase_orders WHERE id = ${invoice.po_id as number}`;
    const siteId = Number(po.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(invoice.status), to: 'INV_MATCHED', principal: actor.principal, siteId },
      tx,
    );

    const match = await threeWayMatch(invoiceId);
    const overBilled = Number(match.difference);

    if (overBilled > PAISA && overBilled - Number(match.heldAmount) > PAISA) {
      throw conflict(
        `This invoice bills ₹${match.invoiceTaxable} but only ₹${match.receivedTaxable} was received and approved — ₹${overBilled.toFixed(2)} more than the goods. Only ₹${match.heldAmount} has been debited back. Raise a debit note for the balance, or dispute the invoice.`,
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE vendor_invoices
         SET status = 'INV_MATCHED', held_amount = ${match.heldAmount}::numeric
       WHERE id = ${invoiceId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: invoiceId, action: 'TRANSITION',
      fromStatus: String(invoice.status), toStatus: 'INV_MATCHED',
      after: {
        received: match.receivedTaxable, billed: match.invoiceTaxable,
        difference: match.difference, held: match.heldAmount,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: remarks?.trim() || `Matched against ${po.po_no}`,
    });

    return updated;
  });
}

// =============================================================================
// Hold, release, dispute, pay
// =============================================================================

/**
 * The plain status moves, which change nothing but the status.
 *
 * `held_amount` is deliberately not touched here: it is set by `holdInvoice`
 * and cleared by nothing, because releasing an invoice does not un-debit what
 * was withheld — a debit note covers that, and it stands on its own.
 */
async function transition(
  actor: Actor,
  invoiceId: number,
  to: string,
  opts: { remarks?: string; requireRemarks?: boolean } = {},
): Promise<Row> {
  const remarks = opts.remarks?.trim() || null;
  if (opts.requireRemarks && (!remarks || remarks.length < 4)) {
    throw badRequest('That needs a reason.', 'remarks');
  }

  return inTransaction(async tx => {
    const invoice = await loadInvoice(tx, invoiceId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${invoice.po_id as number}`;

    await assertTransition(
      { entityType: ENTITY, from: String(invoice.status), to, principal: actor.principal, siteId: Number(po.site_id) },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE vendor_invoices SET status = ${to}::invoice_status
       WHERE id = ${invoiceId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: invoiceId, action: 'TRANSITION',
      fromStatus: String(invoice.status), toStatus: to,
      userId: actor.principal.userId, ip: actor.ip, remarks,
    });

    return updated;
  });
}

/** Hold part of the invoice — usually what a return or a shortfall covers. */
export async function holdInvoice(actor: Actor, invoiceId: number, heldAmount: string, remarks: string): Promise<Row> {
  const held = Number(heldAmount);
  if (!Number.isFinite(held) || held <= 0) {
    throw badRequest('A held amount must be more than zero.', 'held_amount');
  }

  return inTransaction(async tx => {
    const invoice = await loadInvoice(tx, invoiceId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${invoice.po_id as number}`;

    if (held > Number(invoice.total)) {
      throw badRequest(
        `The invoice is ₹${invoice.total}; ₹${held.toFixed(2)} cannot be held against it.`,
        'held_amount',
      );
    }

    await assertTransition(
      {
        entityType: ENTITY, from: String(invoice.status), to: 'INV_PARTIALLY_HELD',
        principal: actor.principal, siteId: Number(po.site_id),
      },
      tx,
    );

    const text = remarks?.trim();
    if (!text || text.length < 4) {
      throw badRequest('Holding part of an invoice needs a reason.', 'remarks');
    }

    const [updated] = await tx<Row[]>`
      UPDATE vendor_invoices
         SET status = 'INV_PARTIALLY_HELD', held_amount = ${held.toFixed(2)}::numeric
       WHERE id = ${invoiceId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: invoiceId, action: 'TRANSITION',
      fromStatus: String(invoice.status), toStatus: 'INV_PARTIALLY_HELD',
      after: { held_amount: held.toFixed(2) },
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

export const releaseInvoice = (actor: Actor, id: number, remarks?: string) =>
  transition(actor, id, 'INV_RELEASED', { remarks });

export const disputeInvoice = (actor: Actor, id: number, remarks: string) =>
  transition(actor, id, 'INV_DISPUTED', { remarks, requireRemarks: true });

/**
 * Record payment.
 *
 * Posts the negative ledger entry that clears the payable this invoice raised.
 * Net of anything held: what is paid is the invoice less what was withheld, and
 * the ledger has to say so or the vendor balance will never reconcile.
 */
export async function payInvoice(actor: Actor, invoiceId: number, reference: string): Promise<Row> {
  const ref = normaliseText(reference);
  if (!ref) throw badRequest('Record the payment reference.', 'reference');

  return inTransaction(async tx => {
    const invoice = await loadInvoice(tx, invoiceId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${invoice.po_id as number}`;

    await assertTransition(
      { entityType: ENTITY, from: String(invoice.status), to: 'INV_PAID', principal: actor.principal, siteId: Number(po.site_id) },
      tx,
    );

    const paid = Number(invoice.total) - Number(invoice.held_amount);

    const [updated] = await tx<Row[]>`
      UPDATE vendor_invoices SET status = 'INV_PAID' WHERE id = ${invoiceId} RETURNING *`;

    await postLedger(tx, {
      vendorId: Number(invoice.vendor_id),
      side: 'PORTAL',
      entryDate: new Date().toISOString().slice(0, 10),
      docType: 'PAYMENT',
      docRef: ref,
      amount: (-paid).toFixed(2),
      poId: Number(invoice.po_id),
      sourceTable: 'vendor_invoices',
      sourceId: invoiceId,
    });

    await audit(tx, {
      entityType: ENTITY, entityId: invoiceId, action: 'TRANSITION',
      fromStatus: String(invoice.status), toStatus: 'INV_PAID',
      after: { paid: paid.toFixed(2), held: invoice.held_amount, reference: ref },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: Number(invoice.held_amount) > 0
        ? `Paid ₹${paid.toFixed(2)}; ₹${invoice.held_amount} withheld`
        : `Paid ₹${paid.toFixed(2)}`,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listInvoices(
  principal: Principal,
  filters: { status?: string; vendorId?: number; poId?: number } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT i.*, v.legal_name AS vendor_name, po.po_no, po.site_id,
           s.code AS site_code, s.name AS site_name,
           i.total - i.held_amount AS payable
      FROM vendor_invoices i
      JOIN vendors v          ON v.id = i.vendor_id
      JOIN purchase_orders po ON po.id = i.po_id
      JOIN sites s            ON s.id = po.site_id
     WHERE (${siteIds}::bigint[] IS NULL OR po.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR i.status = ${filters.status ?? null}::invoice_status)
       AND (${filters.vendorId ?? null}::bigint IS NULL OR i.vendor_id = ${filters.vendorId ?? null})
       AND (${filters.poId ?? null}::bigint IS NULL OR i.po_id = ${filters.poId ?? null})
     ORDER BY i.invoice_date DESC, i.id DESC`;
}

export async function getInvoice(id: number): Promise<{ invoice: Row; match: MatchResult }> {
  const [invoice] = await sql<Row[]>`
    SELECT i.*, v.legal_name AS vendor_name, v.gstin AS vendor_gstin, v.state_code AS vendor_state,
           po.po_no, po.id AS po_id, po.site_id, s.name AS site_name, s.state_code AS site_state,
           i.total - i.held_amount AS payable
      FROM vendor_invoices i
      JOIN vendors v          ON v.id = i.vendor_id
      JOIN purchase_orders po ON po.id = i.po_id
      JOIN sites s            ON s.id = po.site_id
     WHERE i.id = ${id}`;

  if (!invoice) throw notFound('That invoice no longer exists.');

  return { invoice, match: await threeWayMatch(id) };
}

/** Orders that have been received but not yet invoiced — the booking picker. */
export function awaitingInvoice(principal: Principal): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT po.id, po.po_no, po.site_id, s.name AS site_name, s.state_code AS site_state,
           v.legal_name AS vendor_name, v.state_code AS vendor_state,
           coalesce(sum(round(r.qty_received * pl.rate, 2)), 0) AS received_value,
           count(DISTINCT i.id) AS invoice_count
      FROM purchase_orders po
      JOIN sites s   ON s.id = po.site_id
      JOIN vendors v ON v.id = po.vendor_id
      JOIN po_lines pl ON pl.po_id = po.id
      LEFT JOIN v_po_line_receipt r ON r.po_line_id = pl.id
      LEFT JOIN vendor_invoices i   ON i.po_id = po.id
     WHERE po.status IN ('PO_PARTIALLY_RECEIVED', 'PO_RECEIVED', 'PO_SHORT_CLOSED', 'PO_CLOSED')
       AND (${siteIds}::bigint[] IS NULL OR po.site_id = ANY(${siteIds}))
     GROUP BY po.id, po.po_no, po.site_id, s.name, s.state_code, v.legal_name, v.state_code
    HAVING coalesce(sum(r.qty_received), 0) > 0
     ORDER BY po.po_no`;
}
