/**
 * GET  /api/debit-notes?status=&vendor_id=
 * POST /api/debit-notes   raise one against a dispatched return or a short-close
 *
 * The value comes from the origin — a return is worth what went back at the
 * order rate, a shortfall what never arrived. Accounts may override the figure,
 * because a settlement is a negotiation, but never the quantity: that is a
 * physical fact somebody already recorded.
 */
import { handler, readJson, optionalId, optionalString } from '@/lib/api';
import { createDebitNote, listDebitNotes } from '@/lib/services/debit-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listDebitNotes(principal, {
    status: p.get('status') ?? undefined,
    vendorId: p.get('vendor_id') ? Number(p.get('vendor_id')) : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);

  return createDebitNote(
    { principal, ip },
    {
      rtvId: optionalId(body.rtv_id, 'rtv_id'),
      shortfallId: optionalId(body.shortfall_id, 'shortfall_id'),
      vendorInvoiceId: optionalId(body.vendor_invoice_id, 'vendor_invoice_id'),
      valueOverride: optionalString(body.value_override, 'value_override'),
      valueOverrideRemark: optionalString(body.value_override_remark, 'value_override_remark', 500),
    },
  );
});
