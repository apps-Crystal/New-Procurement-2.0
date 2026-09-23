/**
 * POST /api/reconciliation/import — bring in the Tally side of a vendor ledger.
 *
 * Deliberately dumb: the figures are written exactly as supplied. An import
 * that rounded, netted or corrected anything on the way in would hide the very
 * discrepancy the reconciliation exists to surface. Re-importing the same rows
 * is skipped rather than duplicated, so a re-uploaded file is safe.
 */
import {
  handler, readJson, optionalString, requireArray, requireDate, requireEnum,
  requireId, requireString,
} from '@/lib/api';
import { importTally } from '@/lib/services/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DOC_TYPES = ['OPENING', 'INVOICE', 'PAYMENT', 'ADVANCE', 'DEBIT_NOTE', 'CREDIT_NOTE'] as const;

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rows = requireArray<Record<string, unknown>>(body.entries, 'entries', { min: 1 });

  return importTally(
    { principal, ip },
    requireId(body.vendor_id, 'vendor_id'),
    rows.map(r => ({
      entryDate: requireDate(r.entry_date, 'entry_date'),
      docType: requireEnum(r.doc_type, 'doc_type', DOC_TYPES),
      docRef: requireString(r.doc_ref, 'doc_ref', { max: 120 }),
      amount: requireString(r.amount, 'amount'),
      tallyVoucherRef: optionalString(r.tally_voucher_ref, 'tally_voucher_ref', 80),
    })),
  );
});
