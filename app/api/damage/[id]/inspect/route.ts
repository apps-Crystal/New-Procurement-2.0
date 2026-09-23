/**
 * POST /api/damage/[id]/inspect — sign the joint inspection.
 *
 * Both a Site Manager and a QC inspector must sign before the report moves on.
 * The reporter may not sign at all: someone assessing their own find is the
 * thing a joint inspection exists to prevent.
 */
import { handlerWithParams, numericId, readJson, requireString } from '@/lib/api';
import { inspectDamage } from '@/lib/services/damage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return inspectDamage(
    { principal, ip },
    numericId(params.id),
    requireString(body.notes, 'notes', { min: 10, max: 2000 }),
  );
});
