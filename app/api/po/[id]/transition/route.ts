/**
 * POST /api/po/[id]/transition
 * Body { action: 'issue' | 'short-close' | 'cancel', tally_po_ref?, reason? }
 *
 * Issuing requires the Tally reference — `po_issue_needs_tally` enforces it in
 * the database, because an order the accounts system has never heard of cannot
 * be matched to an invoice later.
 */
import { handlerWithParams, numericId, readJson, requireEnum, requireString } from '@/lib/api';
import { cancelPo, issuePo, shortClosePo } from '@/lib/services/po';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['issue', 'short-close', 'cancel'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'issue':
      return issuePo(actor, id, requireString(body.tally_po_ref, 'tally_po_ref', { max: 80 }));
    case 'short-close':
      return shortClosePo(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
    case 'cancel':
      return cancelPo(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
