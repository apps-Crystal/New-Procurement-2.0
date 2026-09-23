/**
 * POST /api/qc/holds/[lineId] — concession or rejection on held stock.
 *
 * Body { decision: 'CONCESSION' | 'REJECT', qty, reason }
 *
 * A concession takes material that failed inspection, so the reason is the
 * record of who accepted the risk. The inspector cannot make this call.
 */
import { handlerWithParams, numericId, readJson, requireEnum, requireString } from '@/lib/api';
import { decideHold } from '@/lib/services/qc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DECISIONS = ['CONCESSION', 'REJECT'] as const;

export const POST = handlerWithParams<{ lineId: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return decideHold(
    { principal, ip },
    numericId(params.lineId, 'lineId'),
    requireEnum(body.decision, 'decision', DECISIONS),
    requireString(body.qty, 'qty'),
    requireString(body.reason, 'reason', { min: 4, max: 500 }),
  );
});
