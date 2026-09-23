/** GET /api/assets?site_id=&item_id=&bucket=&search= — the serialised register. */
import { handler } from '@/lib/api';
import { listAssets } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listAssets(principal, {
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
    itemId: p.get('item_id') ? Number(p.get('item_id')) : undefined,
    bucket: p.get('bucket') ?? undefined,
    search: p.get('search') ?? undefined,
  });
});
