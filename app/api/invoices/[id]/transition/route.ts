/**
 * POST /api/invoices/[id]/transition
 * Body { action: 'match' | 'hold' | 'release' | 'dispute' | 'pay', … }
 *
 * Matching compares the order, the approved receipts and the bill. An invoice
 * that bills more than arrived is not matched silently — it needs a debit note
 * covering the gap, or a dispute.
 */
import {
  handlerWithParams, numericId, readJson, optionalString, requireEnum, requireString,
} from '@/lib/api';
import {
  disputeInvoice, holdInvoice, matchInvoice, payInvoice, releaseInvoice,
} from '@/lib/services/invoices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['match', 'hold', 'release', 'dispute', 'pay'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'match':
      return matchInvoice(actor, id, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'hold':
      return holdInvoice(
        actor, id,
        requireString(body.held_amount, 'held_amount'),
        requireString(body.remarks, 'remarks', { min: 4, max: 500 }),
      );
    case 'release':
      return releaseInvoice(actor, id, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'dispute':
      return disputeInvoice(actor, id, requireString(body.remarks, 'remarks', { min: 4, max: 500 }));
    case 'pay':
      return payInvoice(actor, id, requireString(body.reference, 'reference', { max: 120 }));
  }
});
