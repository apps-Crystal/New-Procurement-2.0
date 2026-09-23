/**
 * POST /api/pr/[id]/transition
 * Body { action: 'submit' | 'approve' | 'reject' | 'cancel', remarks?, reason? }
 *
 * Submitting opens the approval chain, with its levels chosen by value from
 * `approval_bands`. Approving decides only the caller's own level: the PR moves
 * when the last level clears, not before.
 */
import { handlerWithParams, numericId, readJson, optionalString, requireEnum, requireString } from '@/lib/api';
import { cancelPr, decidePr, submitPr } from '@/lib/services/pr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['submit', 'approve', 'reject', 'cancel'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'submit':
      return submitPr(actor, id);
    case 'approve':
      return decidePr(actor, id, true, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'reject':
      return decidePr(actor, id, false, requireString(body.remarks, 'remarks', { min: 4, max: 500 }));
    case 'cancel':
      return cancelPr(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
