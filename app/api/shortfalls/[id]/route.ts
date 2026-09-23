/**
 * GET  /api/shortfalls/[id]
 * POST /api/shortfalls/[id]   decide it
 *
 * Body { decision: 'AWAIT_BALANCE' | 'SHORT_CLOSE', remarks? }
 *
 * AWAIT_BALANCE leaves the order open so the gap keeps showing as outstanding.
 * SHORT_CLOSE accepts it will never arrive, so it needs a reason.
 */
import { handlerWithParams, numericId, readJson, optionalString, requireEnum } from '@/lib/api';
import { decideShortfall, getShortfall } from '@/lib/services/shortfall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DECISIONS = ['AWAIT_BALANCE', 'SHORT_CLOSE'] as const;

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  getShortfall(numericId(params.id)),
);

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return decideShortfall(
    { principal, ip },
    numericId(params.id),
    requireEnum(body.decision, 'decision', DECISIONS),
    optionalString(body.remarks, 'remarks', 500) ?? undefined,
  );
});
