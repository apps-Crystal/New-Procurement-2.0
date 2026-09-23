/**
 * POST /api/debit-notes/[id]/transition
 * Body { action: 'issue' | 'credit-note' | 'offset' | 'reconcile' | 'cancel', … }
 *
 * `reconcile` is where conflict C-14 bites: a credit note more than 2% short of
 * what was debited blocks it until a Functional Head accepts the shortfall. The
 * schema flags the variance and then does nothing with it, so the block lives
 * in the service.
 */
import {
  handlerWithParams, numericId, readJson, optionalString, requireDate, requireEnum,
  requireId, requireString,
} from '@/lib/api';
import {
  cancelDebitNote, issueDebitNote, offsetDebitNote, recordCreditNote, reconcileDebitNote,
} from '@/lib/services/debit-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['issue', 'credit-note', 'offset', 'reconcile', 'cancel'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'issue':
      return issueDebitNote(actor, id, optionalString(body.tally_voucher_ref, 'tally_voucher_ref', 80) ?? undefined);
    case 'credit-note':
      return recordCreditNote(actor, id, {
        cnNo: requireString(body.cn_no, 'cn_no', { max: 80 }),
        cnDate: requireDate(body.cn_date, 'cn_date'),
        value: requireString(body.value, 'value'),
      });
    case 'offset':
      return offsetDebitNote(actor, id, {
        vendorInvoiceId: requireId(body.vendor_invoice_id, 'vendor_invoice_id'),
        amount: requireString(body.amount, 'amount'),
        billControlRef: optionalString(body.bill_control_ref, 'bill_control_ref', 80),
      });
    case 'reconcile':
      return reconcileDebitNote(actor, id, requireString(body.tally_voucher_ref, 'tally_voucher_ref', { max: 80 }));
    case 'cancel':
      return cancelDebitNote(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
