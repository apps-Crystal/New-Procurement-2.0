/**
 * GET  /api/transfers?status=&direction=in|out
 * POST /api/transfers   request stock from another site
 *
 * `direction` is relative to the caller's sites: "out" is stock leaving one of
 * them, "in" is stock arriving. A transfer between two sites the caller holds
 * appears under both.
 */
import { handler, readJson, optionalId, requireArray, requireEnum, requireId, requireString } from '@/lib/api';
import { listTransfers, requestTransfer } from '@/lib/services/transfers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  const dir = p.get('direction');
  return listTransfers(principal, {
    status: p.get('status') ?? undefined,
    direction: dir === 'in' || dir === 'out' ? dir : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const raw = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return requestTransfer(
    { principal, ip },
    {
      mrId: optionalId(body.mr_id, 'mr_id'),
      fromSiteId: requireId(body.from_site_id, 'from_site_id'),
      toSiteId: requireId(body.to_site_id, 'to_site_id'),
      lines: raw.map(l => ({
        itemId: requireId(l.item_id, 'item_id'),
        qty: requireString(l.qty, 'qty'),
        mrLineId: optionalId(l.mr_line_id, 'mr_line_id'),
      })),
    },
  );
});
