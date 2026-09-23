/**
 * POST /api/transfers/[id]/transition
 * Body { action: 'approve' | 'reject' | 'dispatch' | 'receive' | 'cancel', reason?, received? }
 *
 * Approve, dispatch and receive each post stock movements through
 * `post_stock_movement()` — reserve, out, then in. Receipt may report a short
 * quantity per line; anything not sent is released back to available at the
 * holding site rather than vanishing (conflict C-01).
 */
import {
  handlerWithParams, numericId, readJson,
  requireArray, requireEnum, requireId, requireString,
} from '@/lib/api';
import {
  cancelTransfer, decideTransfer, dispatchTransferOrder, receiveTransferOrder,
} from '@/lib/services/transfers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['approve', 'reject', 'dispatch', 'receive', 'cancel'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'approve':
      return decideTransfer(actor, id, true);
    case 'reject':
      return decideTransfer(actor, id, false, requireString(body.reason, 'reason', { min: 4, max: 500 }));
    case 'dispatch':
      return dispatchTransferOrder(actor, id);
    case 'receive': {
      // Omitted entirely means "everything arrived"; the service then receives
      // each line at its dispatched quantity.
      const received = body.received === undefined ? undefined
        : requireArray<Record<string, unknown>>(body.received, 'received').map(r => ({
            transferLineId: requireId(r.transfer_line_id, 'transfer_line_id'),
            qtyReceived: requireString(r.qty_received, 'qty_received'),
          }));
      return receiveTransferOrder(actor, id, received);
    }
    case 'cancel':
      return cancelTransfer(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
