/**
 * POST /api/gate-inward/[id]/transition
 * Body { action: 'send-to-qc' | 'reject', reason? }
 *
 * Handing over to QC also raises a shortfall case for every short line, because
 * the gap between challan and count is a gate fact settled before anybody looks
 * at quality.
 */
import { handlerWithParams, numericId, readJson, requireEnum, requireString } from '@/lib/api';
import { rejectGateInward, sendToQc } from '@/lib/services/gate-inward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['send-to-qc', 'reject'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'send-to-qc':
      return sendToQc(actor, id);
    case 'reject':
      return rejectGateInward(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
