/**
 * POST /api/mr/[id]/transition
 * Body { action: 'approve' | 'reject' | 'cancel', reason? }
 *
 * One endpoint for the state machine, as with vendors: the arrow is checked
 * against `status_transitions`, so an illegal move is refused identically
 * whichever action asked for it.
 */
import { handlerWithParams, numericId, readJson, optionalString, requireEnum, requireString } from '@/lib/api';
import { cancelMr, decideMr } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['approve', 'reject', 'cancel'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'approve':
      return decideMr(actor, id, true, optionalString(body.reason, 'reason', 500) ?? undefined);
    case 'reject':
      return decideMr(actor, id, false, requireString(body.reason, 'reason', { min: 4, max: 500 }));
    case 'cancel':
      return cancelMr(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
