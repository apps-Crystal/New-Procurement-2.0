/**
 * GET  /api/vendors?status=&search=&orderable_for_site=
 * POST /api/vendors   create a draft vendor (VENDOR.CREATE)
 */
import { handler, readJson, requireString, optionalString } from '@/lib/api';
import { createVendor, listVendors, orderableVendors } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req }) => {
  const params = req.nextUrl.searchParams;

  // Used by the PO screen: only approved vendors matching the site and category.
  const forSite = params.get('orderable_for_site');
  if (forSite) {
    const itemClass = params.get('item_class_id');
    return orderableVendors(Number(forSite), itemClass ? Number(itemClass) : undefined);
  }

  return listVendors({
    status: params.get('status') ?? undefined,
    search: params.get('search') ?? undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return createVendor(
    { principal, ip },
    {
      vendorCode: optionalString(body.vendor_code, 'vendor_code') ?? undefined,
      legalName: requireString(body.legal_name, 'legal_name', { max: 200 }),
      vendorType: optionalString(body.vendor_type, 'vendor_type') ?? undefined,
      pan: requireString(body.pan, 'pan'),
      gstin: optionalString(body.gstin, 'gstin'),
      stateCode: requireString(body.state_code, 'state_code'),
      address: requireString(body.address, 'address', { max: 500 }),
      contactName: optionalString(body.contact_name, 'contact_name', 120),
      contactEmail: optionalString(body.contact_email, 'contact_email', 160),
      contactPhone: optionalString(body.contact_phone, 'contact_phone', 20),
      msmeNumber: optionalString(body.msme_number, 'msme_number', 40),
      tallyLedgerRef: optionalString(body.tally_ledger_ref, 'tally_ledger_ref', 80),
    },
  );
});
