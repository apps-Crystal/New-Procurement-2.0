/**
 * POST /api/reconciliation/items/[id] — note what was done about one item.
 *
 * Resolving an item does not make it match; it records the explanation. The
 * difference still has to go to zero before the run can close, so a note is an
 * account of the work, not a way around it.
 */
import { handlerWithParams, numericId, readJson, requireString } from '@/lib/api';
import { resolveItem } from '@/lib/services/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return resolveItem(
    { principal, ip },
    numericId(params.id),
    requireString(body.note, 'note', { min: 4, max: 1000 }),
  );
});
