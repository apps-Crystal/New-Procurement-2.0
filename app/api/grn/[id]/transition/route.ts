/**
 * POST /api/grn/[id]/transition
 * Body { action: 'approve' | 'flag' | 'unflag' | 'reject' | 'close', reason?, remarks? }
 *
 * Approval is the only action here that touches stock, and it posts every line
 * through `post_stock_movement()`. It is idempotent on the GRN line, so a retry
 * after a dropped connection posts nothing twice.
 */
import { handlerWithParams, numericId, readJson, optionalString, requireEnum, requireString } from '@/lib/api';
import { approveGrn, closeGrn, flagGrn, rejectGrn, unflagGrn } from '@/lib/services/grn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['approve', 'flag', 'unflag', 'reject', 'close'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'approve':
      return approveGrn(actor, id);
    case 'flag':
      return flagGrn(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
    case 'unflag':
      return unflagGrn(actor, id, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'reject':
      return rejectGrn(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
    case 'close':
      return closeGrn(actor, id);
  }
});
