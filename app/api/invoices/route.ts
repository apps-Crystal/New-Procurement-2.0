/**
 * GET  /api/invoices?status=&vendor_id=&po_id=
 * POST /api/invoices   book a vendor invoice against an order
 *
 * The vendor is not in the body — it comes from the order. An invoice billed to
 * one order by a different vendor is not a typing slip to be recorded, it is a
 * document that should not be booked at all.
 *
 * Nor is the GST mode a choice: intra-state carries CGST and SGST, inter-state
 * carries IGST, and which applies is decided by comparing the place of supply
 * with the receiving site's state.
 */
import { handler, readJson, optionalString, requireDate, requireId, requireString } from '@/lib/api';
import { listInvoices, recordInvoice } from '@/lib/services/invoices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listInvoices(principal, {
    status: p.get('status') ?? undefined,
    vendorId: p.get('vendor_id') ? Number(p.get('vendor_id')) : undefined,
    poId: p.get('po_id') ? Number(p.get('po_id')) : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);

  return recordInvoice(
    { principal, ip },
    {
      poId: requireId(body.po_id, 'po_id'),
      invoiceNo: requireString(body.invoice_no, 'invoice_no', { max: 80 }),
      invoiceDate: requireDate(body.invoice_date, 'invoice_date'),
      placeOfSupply: requireString(body.place_of_supply, 'place_of_supply'),
      taxableValue: requireString(body.taxable_value, 'taxable_value'),
      cgst: optionalString(body.cgst, 'cgst') ?? undefined,
      sgst: optionalString(body.sgst, 'sgst') ?? undefined,
      igst: optionalString(body.igst, 'igst') ?? undefined,
      billControlRef: optionalString(body.bill_control_ref, 'bill_control_ref', 80),
    },
  );
});
