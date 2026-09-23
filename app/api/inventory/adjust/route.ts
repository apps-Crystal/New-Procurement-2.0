/**
 * POST /api/inventory/adjust — reconcile the system to a physical count.
 *
 * The body carries what was COUNTED, not a delta. A delta invites the wrong
 * sign and double-counts if resubmitted; the movement is derived from the gap,
 * and a count that agrees posts nothing.
 */
import { handler, readJson, optionalId, requireId, requireString } from '@/lib/api';
import { adjustToCount } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return adjustToCount(
    { principal, ip },
    {
      siteId: requireId(body.site_id, 'site_id'),
      itemId: requireId(body.item_id, 'item_id'),
      countedQty: requireString(body.counted_qty, 'counted_qty'),
      reason: requireString(body.reason, 'reason', { min: 4, max: 500 }),
      locationId: optionalId(body.location_id, 'location_id'),
    },
  );
});
