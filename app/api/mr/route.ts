/**
 * GET  /api/mr?status=&site_id=&mine=1   material requests visible to the caller
 * POST /api/mr                            raise one (MR.CREATE at the site)
 *
 * The list is filtered by the caller's sites inside the service — a query
 * parameter cannot widen it, only narrow it.
 */
import { handler, readJson, requireArray, requireDate, requireEnum, requireId, requireString } from '@/lib/api';
import { ENUMS } from '@/lib/enums';
import { createMr, listMrs, type MrLineInput } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listMrs(principal, {
    status: p.get('status') ?? undefined,
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
    mine: p.get('mine') === '1',
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rawLines = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return createMr(
    { principal, ip },
    {
      siteId: requireId(body.site_id, 'site_id'),
      category: requireEnum(body.category, 'category', ENUMS.category_code),
      requiredBy: requireDate(body.required_by, 'required_by'),
      urgency: requireEnum(body.urgency, 'urgency', ENUMS.urgency_code),
      lines: rawLines.map(
        (l): MrLineInput => ({
          itemId: requireId(l.item_id, 'item_id'),
          qtyRequested: requireString(l.qty_requested, 'qty_requested'),
        }),
      ),
    },
  );
});
