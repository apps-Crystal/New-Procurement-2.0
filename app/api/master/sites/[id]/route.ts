/**
 * GET   /api/master/sites/[id]
 * PATCH /api/master/sites/[id]   (MASTER.SITE_MANAGE; the code freezes once transacted)
 */
import { handlerWithParams, numericId, readJson } from '@/lib/api';
import { updateSite } from '@/lib/services/masters';
import { sql } from '@/lib/db';
import { notFound } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => {
  const [site] = await sql`SELECT * FROM sites WHERE id = ${numericId(params.id)}`;
  if (!site) throw notFound('That site no longer exists.');
  return site;
});

export const PATCH = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return updateSite({ principal, ip }, numericId(params.id), {
    code: body.code as string | undefined,
    name: body.name as string | undefined,
    siteType: body.site_type as string | undefined,
    address: body.address as string | undefined,
    stateCode: body.state_code as string | undefined,
    gstin: body.gstin as string | undefined,
    coldChainCapable: body.cold_chain_capable as boolean | undefined,
    tallyCostCentre: body.tally_cost_centre as string | undefined,
    tallyBranch: body.tally_branch as string | undefined,
    status: body.status as 'ACTIVE' | 'INACTIVE' | undefined,
  });
});
