/**
 * GET /api/assets/drift?site_id= — where the unit count and the balance disagree.
 *
 * Conflict C-19 says report drift, never silently repair it: a repair picks a
 * winner, and which of the two is right is a warehouse question. An empty list
 * is the answer worth seeing.
 */
import { handler } from '@/lib/api';
import { assetDrift } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req }) => {
  const siteId = req.nextUrl.searchParams.get('site_id');
  return assetDrift(siteId ? Number(siteId) : undefined);
});
