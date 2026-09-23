/**
 * GET  /api/reconciliation?vendor_id=&status=
 * POST /api/reconciliation   take a run for a vendor over a period
 *
 * A run is a snapshot: the two balances are stored on it as at the period end.
 * Re-running the same period replaces the findings but keeps the run, because a
 * second look at September is the same exercise repeated, not a different one.
 */
import { handler, readJson, requireDate, requireId } from '@/lib/api';
import { listRuns, runReconciliation } from '@/lib/services/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listRuns(principal, {
    vendorId: p.get('vendor_id') ? Number(p.get('vendor_id')) : undefined,
    status: p.get('status') ?? undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return runReconciliation(
    { principal, ip },
    {
      vendorId: requireId(body.vendor_id, 'vendor_id'),
      periodStart: requireDate(body.period_start, 'period_start'),
      periodEnd: requireDate(body.period_end, 'period_end'),
    },
  );
});
