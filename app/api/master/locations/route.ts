/**
 * GET  /api/master/locations?site_id=   storage locations
 * POST /api/master/locations            create one (MASTER.LOCATION_MANAGE at that site)
 */
import { handler, readJson, requireId, requireString, optionalString } from '@/lib/api';
import { createLocation, listLocations } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req }) => {
  const siteId = req.nextUrl.searchParams.get('site_id');
  return listLocations(siteId ? Number(siteId) : undefined);
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return createLocation(
    { principal, ip },
    {
      siteId: requireId(body.site_id, 'site_id'),
      code: requireString(body.code, 'code'),
      description: optionalString(body.description, 'description', 200),
      isCold: body.is_cold === true,
    },
  );
});
