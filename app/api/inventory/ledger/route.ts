/**
 * GET /api/inventory/ledger?site_id=&item_id=&movement=&location_id=&from=&to=
 *
 * The ledger is append-only, so this is the whole truth about how stock got
 * where it is. `location_id` filters movements, never balances — there is no
 * per-location balance and none is synthesised (conflict C-18).
 */
import { handler } from '@/lib/api';
import { ledger } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return ledger(principal, {
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
    itemId: p.get('item_id') ? Number(p.get('item_id')) : undefined,
    movement: p.get('movement') ?? undefined,
    locationId: p.get('location_id') ? Number(p.get('location_id')) : undefined,
    from: p.get('from') ?? undefined,
    to: p.get('to') ?? undefined,
    limit: p.get('limit') ? Number(p.get('limit')) : undefined,
  });
});
