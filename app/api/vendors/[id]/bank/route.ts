/**
 * GET  /api/vendors/[id]/bank   accounts; the account number is never returned
 * POST /api/vendors/[id]/bank   propose details (VENDOR.BANK_PROPOSE)
 *
 * Proposing is only half of it. A different person must approve before the
 * account goes live — see bank/[bankId].
 */
import { handlerWithParams, numericId, readJson, requireString } from '@/lib/api';
import { listBankAccounts, proposeBankAccount } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, params }) =>
  listBankAccounts({ principal, ip }, numericId(params.id)),
);

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return proposeBankAccount(
    { principal, ip },
    {
      vendorId: numericId(params.id),
      accountNumber: requireString(body.account_number, 'account_number'),
      ifsc: requireString(body.ifsc, 'ifsc'),
      beneficiaryName: requireString(body.beneficiary_name, 'beneficiary_name', { max: 160 }),
    },
  );
});
