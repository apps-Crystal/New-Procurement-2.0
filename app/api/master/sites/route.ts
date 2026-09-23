/**
 * GET  /api/master/sites   sites the caller may see
 * POST /api/master/sites   create a site (MASTER.SITE_MANAGE)
 */
import { handler, readJson, requireString, requireEnum } from '@/lib/api';
import { createSite, listSites } from '@/lib/services/masters';
import { ENUMS } from '@/lib/enums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal, ip }) => listSites({ principal, ip }));

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return createSite(
    { principal, ip },
    {
      code: requireString(body.code, 'code'),
      name: requireString(body.name, 'name', { max: 120 }),
      siteType: requireEnum(body.site_type, 'site_type', ENUMS.site_type),
      address: requireString(body.address, 'address', { max: 500 }),
      stateCode: requireString(body.state_code, 'state_code'),
      gstin: requireString(body.gstin, 'gstin'),
      coldChainCapable: body.cold_chain_capable === true,
      tallyCostCentre: (body.tally_cost_centre as string) ?? null,
      tallyBranch: (body.tally_branch as string) ?? null,
      status: body.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
    },
  );
});
