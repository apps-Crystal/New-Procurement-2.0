/**
 * POST /api/vendors/[id]/bank/[bankId]
 * Body { action: 'approve' | 'reject', reason? }
 *
 * The checker half of maker-checker. The service refuses the proposer, and an
 * approval retires whatever account was previously live.
 */
import { handlerWithParams, numericId, readJson, requireEnum, requireString } from '@/lib/api';
import { approveBankAccount, rejectBankAccount } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string; bankId: string }, unknown>(
  async ({ principal, ip, req, params }) => {
    const bankId = numericId(params.bankId, 'bank account id');
    const body = await readJson<Record<string, unknown>>(req);
    const action = requireEnum(body.action, 'action', ['approve', 'reject'] as const);

    return action === 'approve'
      ? approveBankAccount({ principal, ip }, bankId)
      : rejectBankAccount({ principal, ip }, bankId, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  },
);
