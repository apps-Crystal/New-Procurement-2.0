/**
 * GET /api/po/expected-deliveries?site_id= — what is still owed, by date.
 *
 * Drives the receiving queue and the dashboard's "expected today" card. An
 * order appears until every line is fully received or short-closed.
 */
import { handler } from '@/lib/api';
import { expectedDeliveries } from '@/lib/services/po';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const siteId = req.nextUrl.searchParams.get('site_id');
  return expectedDeliveries(principal, siteId ? Number(siteId) : undefined);
});
