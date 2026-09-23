/**
 * GET  /api/damage?status=&site_id=&in_warranty=
 * POST /api/damage   report damage, which quarantines the stock at once
 *
 * `estimated_value` is usually not in the body: it is derived from the receipt
 * rate, because it decides whether a later write-off needs an insurance
 * reference, and a figure the reporter picks is one they can pick to stay under
 * the threshold.
 */
import {
  handler, readJson, optionalId, optionalString, requireDate, requireEnum, requireId, requireString,
} from '@/lib/api';
import { ENUMS } from '@/lib/enums';
import { listDamage, reportDamage } from '@/lib/services/damage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listDamage(principal, {
    status: p.get('status') ?? undefined,
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
    inWarranty: p.has('in_warranty') ? p.get('in_warranty') === '1' : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);

  return reportDamage(
    { principal, ip },
    {
      siteId: requireId(body.site_id, 'site_id'),
      itemId: requireId(body.item_id, 'item_id'),
      qty: requireString(body.qty, 'qty'),
      cause: requireEnum(body.cause, 'cause', ENUMS.damage_cause),
      observedOn: requireDate(body.observed_on, 'observed_on'),
      assetUnitId: optionalId(body.asset_unit_id, 'asset_unit_id'),
      locationId: optionalId(body.location_id, 'location_id'),
      sourceGrnLineId: optionalId(body.source_grn_line_id, 'source_grn_line_id'),
      estimatedValue: optionalString(body.estimated_value, 'estimated_value'),
    },
  );
});
