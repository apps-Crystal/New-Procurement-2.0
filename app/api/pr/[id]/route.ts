/**
 * GET   /api/pr/[id]   the request, its lines, the view's totals, the approval chain
 * PATCH /api/pr/[id]   edit a draft
 *
 * Totals come from `v_pr_totals`, never from the client — the money shown on the
 * screen and the money the approval band routes on are the same number.
 */
import {
  handlerWithParams, numericId, readJson, optionalId, optionalString, requireDate,
} from '@/lib/api';
import { getPr, parsePaymentTerms, updatePr, type PrInput } from '@/lib/services/pr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getPr(numericId(params.id)));

export const PATCH = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);

  // Only the fields actually sent are touched, so an edit to the purpose alone
  // does not clear the payment terms.
  const patch: Partial<PrInput> = {};
  if (body.purpose !== undefined) patch.purpose = optionalString(body.purpose, 'purpose', 1000) ?? undefined;
  if (body.expected_delivery !== undefined) patch.expectedDelivery = requireDate(body.expected_delivery, 'expected_delivery');
  if (body.suggested_vendor_id !== undefined) patch.suggestedVendorId = optionalId(body.suggested_vendor_id, 'suggested_vendor_id');
  if (body.delivery_location_id !== undefined) patch.deliveryLocationId = optionalId(body.delivery_location_id, 'delivery_location_id');
  if (body.delivery_chargeable !== undefined) patch.deliveryChargeable = body.delivery_chargeable === true;
  if (body.delivery_charge_amount !== undefined) patch.deliveryChargeAmount = optionalString(body.delivery_charge_amount, 'delivery_charge_amount');
  if (body.payment_terms !== undefined) patch.paymentTerms = parsePaymentTerms(body.payment_terms);

  return updatePr({ principal, ip }, numericId(params.id), patch);
});
