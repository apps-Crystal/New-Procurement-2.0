/**
 * GET  /api/master/items
 * POST /api/master/items   (MASTER.ITEM_MANAGE)
 */
import { handler, readJson, requireId, requireString, optionalString, optionalNumber } from '@/lib/api';
import { createItem, listItems } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => listItems());

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return createItem(
    { principal, ip },
    {
      code: requireString(body.code, 'code'),
      name: requireString(body.name, 'name', { max: 160 }),
      itemClassId: requireId(body.item_class_id, 'item_class_id'),
      uom: requireString(body.uom, 'uom', { max: 12 }),
      hsnSac: optionalString(body.hsn_sac, 'hsn_sac', 12),
      defaultGstRate: (body.default_gst_rate as string) ?? '18.00',
      isSerialised: body.is_serialised === true,
      warrantyMonths: optionalNumber(body.warranty_months, 'warranty_months', { min: 0, max: 600 }),
    },
  );
});
