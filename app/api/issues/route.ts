/**
 * GET  /api/issues?site_id=&from=&to=
 * POST /api/issues   issue stock out of the warehouse
 *
 * Every line posts inside one transaction: `stock_issues` has no status column,
 * so a partly-issued receipt is a state the schema cannot express.
 */
import { handler, readJson, optionalId, requireArray, requireId, requireString } from '@/lib/api';
import { createIssue, listIssues } from '@/lib/services/issues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listIssues(principal, {
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
    from: p.get('from') ?? undefined,
    to: p.get('to') ?? undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rawLines = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return createIssue(
    { principal, ip },
    {
      siteId: requireId(body.site_id, 'site_id'),
      issuedTo: requireString(body.issued_to, 'issued_to', { min: 2, max: 200 }),
      lines: rawLines.map(l => ({
        itemId: requireId(l.item_id, 'item_id'),
        qty: requireString(l.qty, 'qty'),
        locationId: optionalId(l.location_id, 'location_id'),
      })),
    },
  );
});
