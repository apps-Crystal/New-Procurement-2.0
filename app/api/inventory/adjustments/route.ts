/** GET /api/inventory/adjustments?site_id=&item_id= — stock takes that found a discrepancy. */
import { handler } from '@/lib/api';
import { listAdjustments } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listAdjustments(principal, {
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
    itemId: p.get('item_id') ? Number(p.get('item_id')) : undefined,
  });
});
