/**
 * POST /api/reconciliation/[id]/transition
 * Body { action: 'close' | 'confirm' | 'reopen', … }
 *
 * `recon_zero_to_close` refuses a close while the two sides differ, and there
 * is no override: a difference is closed by correcting whichever ledger is
 * wrong and running it again, never by agreeing to ignore it.
 */
import {
  handlerWithParams, numericId, readJson, optionalString, requireEnum, requireString,
} from '@/lib/api';
import {
  closeReconciliation, confirmReconciliation, reopenReconciliation,
} from '@/lib/services/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['close', 'confirm', 'reopen'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'close':
      return closeReconciliation(actor, id, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'confirm':
      return confirmReconciliation(actor, id, requireString(body.vendor_confirmed_balance, 'vendor_confirmed_balance'));
    case 'reopen':
      return reopenReconciliation(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
