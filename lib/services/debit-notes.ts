/**
 * Debit notes and the credit notes that answer them (brief §22).
 *
 * DEBIT_NOTE_PENDING → DEBIT_NOTE_ISSUED → CREDIT_NOTE_RECEIVED → DN_RECONCILED
 *                                        ↘ DN_ADJUSTED          ↗
 *                    ↘ DN_CANCELLED     ↙
 *
 * A debit note is the money side of something that already happened physically:
 * goods went back, or goods never came. `dn_one_source` enforces that it is
 * exactly one of those — a return or a shortfall, never both and never neither.
 *
 * What the schema enforces:
 *
 *   dn_one_source              CHECK — exactly one origin
 *   dn_tax_mode                CHECK — IGST or CGST+SGST, never both
 *   dn_reconciled_needs_tally  CHECK — reconciling needs the Tally voucher
 *   debit_notes.rtv_id UNIQUE  — one debit note per dispatch
 *   compute_cn_variance()      TRIGGER — sets variance_pct and variance_flagged
 *
 * And the one it does not, which is conflict C-14:
 *
 *   The trigger FLAGS a credit note more than 2% short of the debit note, but
 *   nothing stops the debit note reaching DN_RECONCILED while flagged.
 *   `vendor_credit_notes.accepted_short_by` is plainly the intended override
 *   and is never consulted. So reconciliation is blocked here, and clearing the
 *   block requires CG_FHEAD and is audited as an OVERRIDE.
 *
 * GST on a debit note mirrors the invoice it relates to, rather than being
 * recomputed: the credit has to reverse the tax that was actually charged, and
 * the invoice is the only record of what that was.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { postLedger } from '@/lib/services/ledger-accounts';
import { normaliseText } from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'DEBIT_NOTE';

/** `compute_cn_variance()` flags anything above this. Stated for the messages. */
const VARIANCE_LIMIT = 2;

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with debit notes.');
  }
}

async function loadDn(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM debit_notes WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM debit_notes WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That debit note no longer exists.');
  return rows[0];
}

// =============================================================================
// Raise
// =============================================================================

export interface DebitNoteInput {
  /** Exactly one of these. */
  rtvId?: number | null;
  shortfallId?: number | null;
  /** The invoice whose tax this mirrors. */
  vendorInvoiceId?: number | null;
  /** Accounts may change the value, never the quantity — and must say why. */
  valueOverride?: string | null;
  valueOverrideRemark?: string | null;
}

/**
 * Raise a debit note against a dispatched return or a short-closed shortfall.
 *
 * The value comes from the origin: a return is worth what went back at the
 * order rate, a shortfall what never arrived. Accounts may override the figure
 * — a settlement is a negotiation — but the override carries a remark, and the
 * quantity is never theirs to change because the quantity is a physical fact
 * somebody already recorded.
 */
export async function createDebitNote(actor: Actor, input: DebitNoteInput): Promise<Row> {
  if (!input.rtvId === !input.shortfallId) {
    throw badRequest(
      'A debit note is raised against either a return or a shortfall — exactly one of them.',
      'source',
    );
  }

  return inTransaction(async tx => {
    let origin: {
      siteId: number; vendorId: number; poId: number; grnId: number | null;
      taxable: number; reference: string;
    };

    if (input.rtvId) {
      const [rtv] = await tx<Row[]>`
        SELECT r.*, (SELECT coalesce(sum(round(l.qty * l.unit_rate, 2)), 0)
                       FROM purchase_return_lines l WHERE l.rtv_id = r.id) AS taxable
          FROM purchase_returns r WHERE r.id = ${input.rtvId}`;
      if (!rtv) throw notFound('That purchase return no longer exists.');

      // Debiting a vendor for goods that have not left is premature: they may
      // still refuse the return at their gate.
      if (!['RTV_DISPATCHED', 'RTV_ACKNOWLEDGED', 'RTV_CLOSED'].includes(String(rtv.status))) {
        throw conflict(
          `${rtv.rtv_no} is ${rtv.status}. A debit note follows the goods — raise it once the return has been dispatched.`,
        );
      }

      origin = {
        siteId: Number(rtv.site_id), vendorId: Number(rtv.vendor_id), poId: Number(rtv.po_id),
        grnId: null, taxable: Number(rtv.taxable), reference: String(rtv.rtv_no),
      };
    } else {
      const [sf] = await tx<Row[]>`
        SELECT c.*, g.site_id, po.vendor_id, po.id AS po_id,
               round(c.qty_short * pl.rate, 2) AS taxable
          FROM shortfall_cases c
          JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
          JOIN gate_inwards g      ON g.id = l.gate_inward_id
          JOIN po_lines pl         ON pl.id = c.po_line_id
          JOIN purchase_orders po  ON po.id = pl.po_id
         WHERE c.id = ${input.shortfallId as number}`;
      if (!sf) throw notFound('That shortfall case no longer exists.');

      // AWAIT_BALANCE means the vendor still owes the goods, so there is
      // nothing to debit yet — the balance may still turn up.
      if (String(sf.decision) !== 'SHORT_CLOSE') {
        throw conflict(
          `${sf.sht_no} is still awaiting the balance. Short-close it first — until then the vendor owes goods, not money.`,
        );
      }

      origin = {
        siteId: Number(sf.site_id), vendorId: Number(sf.vendor_id), poId: Number(sf.po_id),
        grnId: null, taxable: Number(sf.taxable), reference: String(sf.sht_no),
      };
    }

    requirePermission(actor, 'DEBIT_NOTE.ISSUE', origin.siteId);

    // UNIQUE on rtv_id / shortfall_id would catch this; the message would not.
    const [existing] = await tx<Row[]>`
      SELECT dn_no FROM debit_notes
       WHERE (${input.rtvId ?? null}::bigint IS NOT NULL AND rtv_id = ${input.rtvId ?? null})
          OR (${input.shortfallId ?? null}::bigint IS NOT NULL AND shortfall_id = ${input.shortfallId ?? null})`;
    if (existing) {
      throw conflict(`${origin.reference} has already been debited as ${existing.dn_no}.`);
    }

    let taxable = origin.taxable;
    const overrideRemark = input.valueOverrideRemark?.trim() || null;

    if (input.valueOverride?.trim()) {
      const overridden = Number(input.valueOverride);
      if (!Number.isFinite(overridden) || overridden <= 0) {
        throw badRequest('An overridden value must be more than zero.', 'value_override');
      }
      if (!overrideRemark || overrideRemark.length < 4) {
        throw badRequest(
          `Changing the value from ₹${origin.taxable.toFixed(2)} to ₹${overridden.toFixed(2)} needs a remark saying why.`,
          'value_override_remark',
        );
      }
      taxable = overridden;
    }

    // GST mirrors the invoice, proportionally. Without an invoice there is no
    // tax to reverse, so the note is raised on the taxable value alone.
    let cgst = 0, sgst = 0, igst = 0;

    if (input.vendorInvoiceId) {
      const [invoice] = await tx<Row[]>`
        SELECT * FROM vendor_invoices WHERE id = ${input.vendorInvoiceId}`;
      if (!invoice) throw notFound('That invoice no longer exists.');
      if (Number(invoice.vendor_id) !== origin.vendorId) {
        throw badRequest('That invoice belongs to a different vendor.', 'vendor_invoice_id');
      }

      const share = taxable / Number(invoice.taxable_value);
      cgst = Number(invoice.cgst) * share;
      sgst = Number(invoice.sgst) * share;
      igst = Number(invoice.igst) * share;
    }

    const dnNo = await nextDocumentNoForSite(tx, 'DN', origin.siteId);

    const [dn] = await tx<Row[]>`
      INSERT INTO debit_notes (dn_no, rtv_id, shortfall_id, vendor_id, po_id, grn_id,
                               vendor_invoice_id, taxable_value, cgst, sgst, igst,
                               value_override_remark, status)
      VALUES (${dnNo}, ${input.rtvId ?? null}, ${input.shortfallId ?? null},
              ${origin.vendorId}, ${origin.poId}, ${origin.grnId},
              ${input.vendorInvoiceId ?? null}, ${taxable.toFixed(2)}::numeric,
              ${cgst.toFixed(2)}::numeric, ${sgst.toFixed(2)}::numeric, ${igst.toFixed(2)}::numeric,
              ${overrideRemark}, 'DEBIT_NOTE_PENDING')
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(dn.id), action: 'CREATE',
      after: {
        dn_no: dnNo, against: origin.reference, taxable: taxable.toFixed(2),
        total: dn.total, override: input.valueOverride ?? null,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: overrideRemark
        ? `Value changed from ₹${origin.taxable.toFixed(2)}: ${overrideRemark}`
        : `Raised against ${origin.reference}`,
    });

    return dn;
  });
}

// =============================================================================
// Issue
// =============================================================================

/**
 * Issue the note to the vendor.
 *
 * This is where the payable actually moves: a debit note reduces what is owed,
 * so the ledger entry is negative. It is posted on issue rather than on
 * creation because a pending note is a draft — the vendor has not been told.
 */
export async function issueDebitNote(actor: Actor, dnId: number, tallyVoucherRef?: string): Promise<Row> {
  return inTransaction(async tx => {
    const dn = await loadDn(tx, dnId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${dn.po_id as number}`;

    await assertTransition(
      {
        entityType: ENTITY, from: String(dn.status), to: 'DEBIT_NOTE_ISSUED',
        principal: actor.principal, siteId: Number(po.site_id),
      },
      tx,
    );

    const ref = tallyVoucherRef?.trim() || null;

    const [updated] = await tx<Row[]>`
      UPDATE debit_notes
         SET status = 'DEBIT_NOTE_ISSUED', tally_voucher_ref = ${ref},
             issued_by = ${actor.principal.userId}, issued_at = now(), updated_at = now()
       WHERE id = ${dnId}
      RETURNING *`;

    await postLedger(tx, {
      vendorId: Number(dn.vendor_id),
      side: 'PORTAL',
      entryDate: new Date().toISOString().slice(0, 10),
      docType: 'DEBIT_NOTE',
      docRef: String(dn.dn_no),
      amount: (-Number(dn.total)).toFixed(2),
      poId: Number(dn.po_id),
      sourceTable: 'debit_notes',
      sourceId: dnId,
      tallyVoucherRef: ref,
    });

    await audit(tx, {
      entityType: ENTITY, entityId: dnId, action: 'TRANSITION',
      fromStatus: String(dn.status), toStatus: 'DEBIT_NOTE_ISSUED',
      after: { total: dn.total, tally_voucher_ref: ref },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Payable reduced by ₹${dn.total}`,
    });

    return updated;
  });
}

// =============================================================================
// Credit notes (conflict C-14)
// =============================================================================

export interface CreditNoteInput {
  cnNo: string;
  cnDate: string;
  value: string;
}

/**
 * Record the vendor's credit note.
 *
 * `compute_cn_variance()` computes the gap against the debit note and flags it
 * above 2%. The trigger is the authority on that number — it is not recomputed
 * here, and the flag is read back rather than assumed.
 */
export async function recordCreditNote(
  actor: Actor,
  dnId: number,
  input: CreditNoteInput,
): Promise<{ debitNote: Row; creditNote: Row }> {
  const cnNo = normaliseText(input.cnNo);
  if (!cnNo) throw badRequest('The vendor’s credit note number is required.', 'cn_no');

  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw badRequest('A credit note value must be more than zero.', 'value');
  }

  return inTransaction(async tx => {
    const dn = await loadDn(tx, dnId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${dn.po_id as number}`;

    await assertTransition(
      {
        entityType: ENTITY, from: String(dn.status), to: 'CREDIT_NOTE_RECEIVED',
        principal: actor.principal, siteId: Number(po.site_id),
      },
      tx,
    );

    const [dup] = await tx<Row[]>`
      SELECT cn_no FROM vendor_credit_notes
       WHERE vendor_id = ${dn.vendor_id as number} AND upper(btrim(cn_no)) = ${cnNo.toUpperCase()}`;
    if (dup) {
      throw conflict(`Credit note ${dup.cn_no} from this vendor is already recorded.`);
    }

    const [cn] = await tx<Row[]>`
      INSERT INTO vendor_credit_notes (vendor_id, debit_note_id, cn_no, cn_date, value, recorded_by)
      VALUES (${dn.vendor_id as number}, ${dnId}, ${cnNo}, ${input.cnDate}::date,
              ${value.toFixed(2)}::numeric, ${actor.principal.userId})
      RETURNING *`;

    const [updated] = await tx<Row[]>`
      UPDATE debit_notes SET status = 'CREDIT_NOTE_RECEIVED', updated_at = now()
       WHERE id = ${dnId} RETURNING *`;

    await postLedger(tx, {
      vendorId: Number(dn.vendor_id),
      side: 'PORTAL',
      entryDate: input.cnDate,
      docType: 'CREDIT_NOTE',
      docRef: cnNo,
      // A credit note confirms the reduction the debit note already claimed, so
      // it records the vendor's acceptance rather than moving the balance twice.
      amount: '0',
      poId: Number(dn.po_id),
      sourceTable: 'vendor_credit_notes',
      sourceId: Number(cn.id),
    });

    await audit(tx, {
      entityType: ENTITY, entityId: dnId, action: 'TRANSITION',
      fromStatus: String(dn.status), toStatus: 'CREDIT_NOTE_RECEIVED',
      after: {
        cn_no: cnNo, value: value.toFixed(2), debited: dn.total,
        variance_pct: cn.variance_pct, flagged: cn.variance_flagged,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: cn.variance_flagged === true
        ? `Short by ${cn.variance_pct}% — ₹${value.toFixed(2)} against ₹${dn.total} debited`
        : `₹${value.toFixed(2)} against ₹${dn.total} debited`,
    });

    return { debitNote: updated, creditNote: cn };
  });
}

/**
 * Accept a short credit note (conflict C-14).
 *
 * `accepted_short_by` is the schema's intended override and nothing ever set
 * it. Setting it is what unblocks reconciliation, so it belongs to CG_FHEAD
 * alone and is written to the audit trail as an OVERRIDE — accepting less money
 * than was claimed is a decision somebody should be able to find later.
 */
export async function acceptShortCredit(actor: Actor, creditNoteId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 10) {
    throw badRequest(
      'Accepting less than was debited needs a reason — it is the record of who agreed to take the loss.',
      'reason',
    );
  }

  return inTransaction(async tx => {
    const [cn] = await tx<Row[]>`
      SELECT c.*, d.dn_no, d.total AS debited, d.po_id
        FROM vendor_credit_notes c
        JOIN debit_notes d ON d.id = c.debit_note_id
       WHERE c.id = ${creditNoteId}
       FOR UPDATE OF c`;
    if (!cn) throw notFound('That credit note no longer exists.');

    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${cn.po_id as number}`;

    // Deliberately narrower than DEBIT_NOTE permissions: Accounts raise and
    // reconcile, but only the Functional Head writes off a shortfall in what
    // the vendor paid back.
    if (!can(actor.principal, 'RECON.REOPEN', Number(po.site_id))) {
      throw forbidden(
        'Accepting a short credit note is the Functional Head’s decision — it writes off the difference.',
      );
    }

    if (cn.variance_flagged !== true) {
      throw conflict(
        `Credit note ${cn.cn_no} is within ${VARIANCE_LIMIT}% of the amount debited, so there is nothing to accept.`,
      );
    }

    if (cn.accepted_short_by !== null) {
      throw conflict('That credit note has already been accepted short.');
    }

    const [updated] = await tx<Row[]>`
      UPDATE vendor_credit_notes SET accepted_short_by = ${actor.principal.userId}
       WHERE id = ${creditNoteId} RETURNING *`;

    const shortfall = Number(cn.debited) - Number(cn.value);

    await audit(tx, {
      entityType: 'CREDIT_NOTE', entityId: creditNoteId, action: 'OVERRIDE',
      before: { debited: cn.debited, credited: cn.value, variance_pct: cn.variance_pct },
      after: { accepted_short_by: actor.principal.userId },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Accepted ₹${shortfall.toFixed(2)} short against ${cn.dn_no} (${cn.variance_pct}%). ${text}`,
    });

    return updated;
  });
}

// =============================================================================
// Offset and reconcile
// =============================================================================

/**
 * Set the debit note against an open invoice.
 *
 * The offset is recorded against a specific invoice rather than floating on the
 * vendor account, because that is what a bill-control reference has to point at
 * when Accounts explain a short payment.
 */
export async function offsetDebitNote(
  actor: Actor,
  dnId: number,
  input: { vendorInvoiceId: number; amount: string; billControlRef?: string | null },
): Promise<Row> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw badRequest('An offset amount must be more than zero.', 'amount');
  }

  return inTransaction(async tx => {
    const dn = await loadDn(tx, dnId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${dn.po_id as number}`;

    await assertTransition(
      {
        entityType: ENTITY, from: String(dn.status), to: 'DN_ADJUSTED',
        principal: actor.principal, siteId: Number(po.site_id),
      },
      tx,
    );

    const [invoice] = await tx<Row[]>`
      SELECT * FROM vendor_invoices WHERE id = ${input.vendorInvoiceId} FOR UPDATE`;
    if (!invoice) throw notFound('That invoice no longer exists.');
    if (Number(invoice.vendor_id) !== Number(dn.vendor_id)) {
      throw badRequest('That invoice belongs to a different vendor.', 'vendor_invoice_id');
    }

    const [already] = await tx<{ total: string }[]>`
      SELECT coalesce(sum(amount), 0)::text AS total FROM debit_note_offsets WHERE debit_note_id = ${dnId}`;

    if (Number(already.total) + amount > Number(dn.total) + 0.01) {
      throw conflict(
        `${dn.dn_no} is worth ₹${dn.total} and ₹${already.total} is already offset. ₹${amount.toFixed(2)} more would exceed it.`,
      );
    }

    await tx`
      INSERT INTO debit_note_offsets (debit_note_id, vendor_invoice_id, amount, bill_control_ref, offset_by)
      VALUES (${dnId}, ${input.vendorInvoiceId}, ${amount.toFixed(2)}::numeric,
              ${input.billControlRef?.trim() || null}, ${actor.principal.userId})`;

    const [updated] = await tx<Row[]>`
      UPDATE debit_notes SET status = 'DN_ADJUSTED', updated_at = now()
       WHERE id = ${dnId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: dnId, action: 'TRANSITION',
      fromStatus: String(dn.status), toStatus: 'DN_ADJUSTED',
      after: { invoice: invoice.invoice_no, amount: amount.toFixed(2) },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `₹${amount.toFixed(2)} set against invoice ${invoice.invoice_no}`,
    });

    return updated;
  });
}

/**
 * Close the debit note.
 *
 * Two gates. `dn_reconciled_needs_tally` requires the voucher reference, which
 * the database enforces. And conflict C-14: a credit note more than 2% short of
 * what was debited blocks this until a Functional Head accepts the shortfall.
 * Nothing in the schema stops that, so it is stopped here.
 */
export async function reconcileDebitNote(actor: Actor, dnId: number, tallyVoucherRef: string): Promise<Row> {
  const ref = normaliseText(tallyVoucherRef);
  if (!ref) {
    throw badRequest('Reconciling needs the Tally voucher reference.', 'tally_voucher_ref');
  }

  return inTransaction(async tx => {
    const dn = await loadDn(tx, dnId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${dn.po_id as number}`;

    await assertTransition(
      {
        entityType: ENTITY, from: String(dn.status), to: 'DN_RECONCILED',
        principal: actor.principal, siteId: Number(po.site_id),
      },
      tx,
    );

    // C-14: the most recent credit note decides. An earlier one that was
    // within tolerance does not excuse a later one that is not.
    const [cn] = await tx<Row[]>`
      SELECT * FROM vendor_credit_notes
       WHERE debit_note_id = ${dnId}
       ORDER BY created_at DESC, id DESC LIMIT 1`;

    if (cn && cn.variance_flagged === true && cn.accepted_short_by === null) {
      const short = Number(dn.total) - Number(cn.value);
      throw conflict(
        `Credit note ${cn.cn_no} is ₹${short.toFixed(2)} short of the ₹${dn.total} debited — ${cn.variance_pct}%, above the ${VARIANCE_LIMIT}% tolerance. A Functional Head has to accept the shortfall before this can be reconciled.`,
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE debit_notes
         SET status = 'DN_RECONCILED', tally_voucher_ref = ${ref},
             reconciled_at = now(), updated_at = now()
       WHERE id = ${dnId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: dnId, action: 'TRANSITION',
      fromStatus: String(dn.status), toStatus: 'DN_RECONCILED',
      after: { tally_voucher_ref: ref, credit_note: cn?.cn_no ?? null },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: cn?.accepted_short_by
        ? `Reconciled with ${cn.variance_pct}% accepted short`
        : 'Reconciled',
    });

    return updated;
  });
}

export async function cancelDebitNote(actor: Actor, dnId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) throw badRequest('Cancelling a debit note needs a reason.', 'reason');

  return inTransaction(async tx => {
    const dn = await loadDn(tx, dnId, true);
    const [po] = await tx<Row[]>`SELECT site_id FROM purchase_orders WHERE id = ${dn.po_id as number}`;

    await assertTransition(
      {
        entityType: ENTITY, from: String(dn.status), to: 'DN_CANCELLED',
        principal: actor.principal, siteId: Number(po.site_id),
      },
      tx,
    );

    // An issued note already moved the payable, so cancelling has to move it back.
    if (String(dn.status) === 'DEBIT_NOTE_ISSUED') {
      await postLedger(tx, {
        vendorId: Number(dn.vendor_id),
        side: 'PORTAL',
        entryDate: new Date().toISOString().slice(0, 10),
        docType: 'DEBIT_NOTE',
        docRef: `${dn.dn_no} (cancelled)`,
        amount: Number(dn.total).toFixed(2),
        poId: Number(dn.po_id),
        sourceTable: 'debit_notes',
        sourceId: dnId,
      });
    }

    const [updated] = await tx<Row[]>`
      UPDATE debit_notes SET status = 'DN_CANCELLED', updated_at = now()
       WHERE id = ${dnId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: dnId, action: 'TRANSITION',
      fromStatus: String(dn.status), toStatus: 'DN_CANCELLED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listDebitNotes(
  principal: Principal,
  filters: { status?: string; vendorId?: number } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT d.*, v.legal_name AS vendor_name, po.po_no, po.site_id, s.name AS site_name,
           r.rtv_no, c.sht_no, i.invoice_no,
           u.full_name AS issued_by_name,
           cn.cn_no, cn.value AS cn_value, cn.variance_pct, cn.variance_flagged,
           cn.accepted_short_by IS NOT NULL AS accepted_short
      FROM debit_notes d
      JOIN vendors v          ON v.id = d.vendor_id
      JOIN purchase_orders po ON po.id = d.po_id
      JOIN sites s            ON s.id = po.site_id
      LEFT JOIN purchase_returns r  ON r.id = d.rtv_id
      LEFT JOIN shortfall_cases c   ON c.id = d.shortfall_id
      LEFT JOIN vendor_invoices i   ON i.id = d.vendor_invoice_id
      LEFT JOIN app_users u         ON u.id = d.issued_by
      LEFT JOIN LATERAL (
        SELECT * FROM vendor_credit_notes x
         WHERE x.debit_note_id = d.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1
      ) cn ON true
     WHERE (${siteIds}::bigint[] IS NULL OR po.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR d.status = ${filters.status ?? null}::dn_status)
       AND (${filters.vendorId ?? null}::bigint IS NULL OR d.vendor_id = ${filters.vendorId ?? null})
     ORDER BY d.created_at DESC`;
}

export async function getDebitNote(id: number): Promise<{ dn: Row; creditNotes: Row[]; offsets: Row[] }> {
  const [dn] = await sql<Row[]>`
    SELECT d.*, v.legal_name AS vendor_name, po.po_no, po.id AS po_id, po.site_id,
           s.name AS site_name, r.rtv_no, r.id AS rtv_id, c.sht_no,
           i.invoice_no, i.id AS invoice_id, u.full_name AS issued_by_name
      FROM debit_notes d
      JOIN vendors v          ON v.id = d.vendor_id
      JOIN purchase_orders po ON po.id = d.po_id
      JOIN sites s            ON s.id = po.site_id
      LEFT JOIN purchase_returns r ON r.id = d.rtv_id
      LEFT JOIN shortfall_cases c  ON c.id = d.shortfall_id
      LEFT JOIN vendor_invoices i  ON i.id = d.vendor_invoice_id
      LEFT JOIN app_users u        ON u.id = d.issued_by
     WHERE d.id = ${id}`;

  if (!dn) throw notFound('That debit note no longer exists.');

  const creditNotes = await sql<Row[]>`
    SELECT c.*, u.full_name AS recorded_by_name, a.full_name AS accepted_short_by_name
      FROM vendor_credit_notes c
      JOIN app_users u      ON u.id = c.recorded_by
      LEFT JOIN app_users a ON a.id = c.accepted_short_by
     WHERE c.debit_note_id = ${id}
     ORDER BY c.created_at DESC`;

  const offsets = await sql<Row[]>`
    SELECT o.*, i.invoice_no, u.full_name AS offset_by_name
      FROM debit_note_offsets o
      JOIN vendor_invoices i ON i.id = o.vendor_invoice_id
      JOIN app_users u       ON u.id = o.offset_by
     WHERE o.debit_note_id = ${id}
     ORDER BY o.offset_at`;

  return { dn, creditNotes, offsets };
}

/** Returns and shortfalls that could be debited but have not been. */
export function debitableOrigins(principal: Principal): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT 'RTV' AS kind, r.id AS source_id, r.rtv_no AS reference,
           r.site_id, s.name AS site_name, v.legal_name AS vendor_name, po.po_no, po.id AS po_id,
           (SELECT coalesce(sum(round(l.qty * l.unit_rate, 2)), 0)
              FROM purchase_return_lines l WHERE l.rtv_id = r.id) AS taxable,
           r.created_at AS at
      FROM purchase_returns r
      JOIN sites s            ON s.id = r.site_id
      JOIN vendors v          ON v.id = r.vendor_id
      JOIN purchase_orders po ON po.id = r.po_id
     WHERE r.status IN ('RTV_DISPATCHED', 'RTV_ACKNOWLEDGED', 'RTV_CLOSED')
       AND (${siteIds}::bigint[] IS NULL OR r.site_id = ANY(${siteIds}))
       AND NOT EXISTS (SELECT 1 FROM debit_notes d WHERE d.rtv_id = r.id)

    UNION ALL

    SELECT 'SHORTFALL', c.id, c.sht_no,
           g.site_id, s.name, v.legal_name, po.po_no, po.id,
           round(c.qty_short * pl.rate, 2), c.created_at
      FROM shortfall_cases c
      JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
      JOIN gate_inwards g      ON g.id = l.gate_inward_id
      JOIN sites s             ON s.id = g.site_id
      JOIN po_lines pl         ON pl.id = c.po_line_id
      JOIN purchase_orders po  ON po.id = pl.po_id
      JOIN vendors v           ON v.id = po.vendor_id
     WHERE c.decision = 'SHORT_CLOSE'
       AND (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND NOT EXISTS (SELECT 1 FROM debit_notes d WHERE d.shortfall_id = c.id)

     ORDER BY at DESC`;
}
