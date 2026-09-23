/**
 * GET  /api/master/checklists?item_class_id=   current checklist and its points
 * POST /api/master/checklists                  publish a new version (retires the old)
 */
import { handler, readJson, requireArray, requireId, requireString } from '@/lib/api';
import { currentChecklist, listChecklists, publishChecklist } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req }) => {
  const itemClassId = req.nextUrl.searchParams.get('item_class_id');
  if (itemClassId) return currentChecklist(Number(itemClassId));
  return listChecklists();
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const points = requireArray<string>(body.points, 'points', { min: 1 });
  return publishChecklist(
    { principal, ip },
    {
      itemClassId: requireId(body.item_class_id, 'item_class_id'),
      version: requireString(body.version, 'version', { max: 40 }),
      points: points.map((p, i) => requireString(p, `points[${i}]`, { max: 200 })),
    },
  );
});
