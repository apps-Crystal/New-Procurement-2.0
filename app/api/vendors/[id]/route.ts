/**
 * GET   /api/vendors/[id]   vendor, its bank accounts, categories and sites
 * PATCH /api/vendors/[id]   (VENDOR.EDIT; KYC fields freeze once approved)
 */
import { handlerWithParams, numericId, readJson } from '@/lib/api';
import { getVendor, listBankAccounts, updateVendor } from '@/lib/services/vendors';
import { sql } from '@/lib/db';
import { can } from '@/lib/auth/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, params }) => {
  const id = numericId(params.id);
  const vendor = await getVendor(id);

  const categoryRows = await sql<{ item_class_id: string }[]>`
    SELECT item_class_id FROM vendor_categories WHERE vendor_id = ${id}`;
  const siteRows = await sql<{ site_id: string }[]>`
    SELECT site_id FROM vendor_sites WHERE vendor_id = ${id}`;

  const categories = categoryRows.map(r => Number(r.item_class_id));
  const sites = siteRows.map(r => Number(r.site_id));

  // Bank details sit behind a narrower permission than the vendor record.
  const banks = can(principal, 'VENDOR.BANK_VIEW', null) ? await listBankAccounts({ principal, ip }, id) : [];

  return { vendor, categories, sites, banks };
});

export const PATCH = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return updateVendor({ principal, ip }, numericId(params.id), {
    legalName: body.legal_name as string | undefined,
    vendorType: body.vendor_type as string | undefined,
    pan: body.pan as string | undefined,
    gstin: body.gstin as string | undefined,
    stateCode: body.state_code as string | undefined,
    address: body.address as string | undefined,
    contactName: body.contact_name as string | undefined,
    contactEmail: body.contact_email as string | undefined,
    contactPhone: body.contact_phone as string | undefined,
    msmeNumber: body.msme_number as string | undefined,
    tallyLedgerRef: body.tally_ledger_ref as string | undefined,
  });
});
