/**
 * GET /api/inventory?site_id=&status=&search=&below_reorder=1
 *
 * `site_id` is required, not optional. `v_stock_position` cross-joins sites to
 * items, so an unfiltered read materialises every pair in the group for a
 * screen that shows one site (conflict C-21).
 */
import { handler, requireId } from '@/lib/api';
import { stockPosition } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return stockPosition(principal, {
    siteId: requireId(p.get('site_id'), 'site_id'),
    status: p.get('status') ?? undefined,
    search: p.get('search') ?? undefined,
    belowReorder: p.has('below_reorder') ? p.get('below_reorder') === '1' : undefined,
  });
});
