/**
 * GET /api/master/item-site-settings?site_id=
 * PUT /api/master/item-site-settings   upsert a reorder level
 */
import { handler, readJson, requireId, requireString, optionalString } from '@/lib/api';
import { listItemSiteSettings, setItemSiteSettings } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req }) => {
  const siteId = req.nextUrl.searchParams.get('site_id');
  return listItemSiteSettings(siteId ? Number(siteId) : undefined);
});

export const PUT = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return setItemSiteSettings(
    { principal, ip },
    {
      itemId: requireId(body.item_id, 'item_id'),
      siteId: requireId(body.site_id, 'site_id'),
      reorderLevel: requireString(body.reorder_level, 'reorder_level'),
      reorderQty: optionalString(body.reorder_qty, 'reorder_qty'),
    },
  );
});
