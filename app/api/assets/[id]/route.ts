/**
 * GET   /api/assets/[id]   the unit, its receipt, and the movements that named it
 * PATCH /api/assets/[id]   correct its serial, location or warranty
 *
 * The bucket is not patchable. It belongs to the ledger, and letting it be
 * typed would recreate exactly the drift conflict C-19 is about.
 */
import { handlerWithParams, numericId, readJson, optionalId, optionalString, requireDate } from '@/lib/api';
import { getAsset, updateAsset, type AssetPatch } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getAsset(numericId(params.id)));

export const PATCH = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);

  const patch: AssetPatch = {};
  if (body.serial_no !== undefined) patch.serialNo = optionalString(body.serial_no, 'serial_no', 120);
  if (body.location_id !== undefined) patch.locationId = optionalId(body.location_id, 'location_id');
  if (body.warranty_until !== undefined) {
    patch.warrantyUntil = body.warranty_until === null ? null : requireDate(body.warranty_until, 'warranty_until');
  }

  return updateAsset({ principal, ip }, numericId(params.id), patch);
});
