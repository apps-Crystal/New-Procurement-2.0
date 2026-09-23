/**
 * POST /api/quotations/[id]/withdraw — a vendor pulls their quote.
 *
 * Withdrawn rather than deleted: the comparison that was made at the time has
 * to stay reconstructible, and a vendor who withdraws late is exactly what the
 * scorecard should remember.
 */
import { handlerWithParams, numericId, readJson, requireString } from '@/lib/api';
import { withdrawQuotation } from '@/lib/services/quotations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return withdrawQuotation(
    { principal, ip },
    numericId(params.id),
    requireString(body.reason, 'reason', { min: 4, max: 500 }),
  );
});
