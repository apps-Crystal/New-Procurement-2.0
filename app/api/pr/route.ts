/**
 * GET  /api/pr?status=&mine=1
 * POST /api/pr   raise a purchase request from an approved material request
 *
 * Quantities are NOT in the body. They are copied from `mr_lines.qty_purchase`
 * — the balance left after any transfer — so a PR cannot quietly ask for more
 * than the request it came from. What the caller supplies per line is the
 * estimated rate and the GST rate, which the MR has no opinion about.
 */
import {
  handler, readJson, optionalId, optionalString,
  requireArray, requireDate, requireEnum, requireId, requireString,
} from '@/lib/api';
import { ENUMS } from '@/lib/enums';
import { createPr, listPrs, parsePaymentTerms } from '@/lib/services/pr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listPrs(principal, { status: p.get('status') ?? undefined, mine: p.get('mine') === '1' });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rawLines = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return createPr(
    { principal, ip },
    {
      mrId: requireId(body.mr_id, 'mr_id'),
      procurementType: requireEnum(body.procurement_type, 'procurement_type', ENUMS.procurement_type),
      purpose: requireString(body.purpose, 'purpose', { min: 10, max: 1000 }),
      expectedDelivery: requireDate(body.expected_delivery, 'expected_delivery'),
      suggestedVendorId: optionalId(body.suggested_vendor_id, 'suggested_vendor_id'),
      deliveryLocationId: optionalId(body.delivery_location_id, 'delivery_location_id'),
      deliveryChargeable: body.delivery_chargeable === true,
      deliveryChargeAmount: optionalString(body.delivery_charge_amount, 'delivery_charge_amount'),
      deliveryChargeGstRate: optionalString(body.delivery_charge_gst_rate, 'delivery_charge_gst_rate'),
      paymentTerms: parsePaymentTerms(body.payment_terms),
      paymentTermsOverride: optionalString(body.payment_terms_override, 'payment_terms_override', 500),
      lines: rawLines.map(l => ({
        mrLineId: requireId(l.mr_line_id, 'mr_line_id'),
        estRate: requireString(l.est_rate, 'est_rate'),
        gstRate: requireString(l.gst_rate, 'gst_rate'),
      })),
    },
  );
});
