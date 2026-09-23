/**
 * POST /api/vendors/[id]/transition
 * Body { action: 'submit' | 'approve' | 'block' | 'unblock' | 'deactivate', reason?, tally_ledger_ref? }
 *
 * One endpoint for the whole state machine rather than one per arrow: the arrow
 * itself is checked against status_transitions, so an illegal move is refused
 * the same way whichever route it arrives on.
 */
import { handlerWithParams, numericId, readJson, requireEnum, requireString, optionalString } from '@/lib/api';
import { approveVendor, blockVendor, deactivateVendor, submitVendor, unblockVendor } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['submit', 'approve', 'block', 'unblock', 'deactivate'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'submit':
      return submitVendor(actor, id);
    case 'approve':
      return approveVendor(actor, id, optionalString(body.tally_ledger_ref, 'tally_ledger_ref', 80) ?? undefined);
    case 'block':
      return blockVendor(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
    case 'unblock':
      return unblockVendor(actor, id);
    case 'deactivate':
      return deactivateVendor(actor, id);
  }
});
