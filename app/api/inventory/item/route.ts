/**
 * GET /api/inventory/item?site_id=&item_id=
 *
 * One item at one site: its balance in each bucket, its last fifty movements,
 * and — for a serialised item — the individual units.
 */
import { handler, requireId } from '@/lib/api';
import { itemAtSite } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return itemAtSite(principal, requireId(p.get('site_id'), 'site_id'), requireId(p.get('item_id'), 'item_id'));
});
