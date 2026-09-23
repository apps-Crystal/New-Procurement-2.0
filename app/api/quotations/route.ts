/**
 * POST /api/quotations — record what a vendor quoted.
 *
 * One quotation per vendor per PR (`quotations_pr_vendor_uq`); a revision
 * replaces the earlier one rather than sitting beside it, so the comparison
 * never shows the same vendor twice.
 */
import {
  handler, readJson, optionalNumber, optionalString,
  requireArray, requireDate, requireId, requireString,
} from '@/lib/api';
import { recordQuotation } from '@/lib/services/quotations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rawLines = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return recordQuotation(
    { principal, ip },
    {
      prId: requireId(body.pr_id, 'pr_id'),
      vendorId: requireId(body.vendor_id, 'vendor_id'),
      vendorQuoteRef: requireString(body.vendor_quote_ref, 'vendor_quote_ref', { max: 80 }),
      quoteDate: requireDate(body.quote_date, 'quote_date'),
      validUntil: requireDate(body.valid_until, 'valid_until'),
      freightAmount: optionalString(body.freight_amount, 'freight_amount') ?? undefined,
      paymentTerms: optionalString(body.payment_terms, 'payment_terms', 500),
      warrantyMonths: optionalNumber(body.warranty_months, 'warranty_months', { min: 0, max: 600 }),
      lines: rawLines.map(l => ({
        prLineId: requireId(l.pr_line_id, 'pr_line_id'),
        unitRate: requireString(l.unit_rate, 'unit_rate'),
        gstRate: requireString(l.gst_rate, 'gst_rate'),
        leadTimeDays: optionalNumber(l.lead_time_days, 'lead_time_days', { min: 0, max: 3650 }),
        make: optionalString(l.make, 'make', 120),
      })),
    },
  );
});
