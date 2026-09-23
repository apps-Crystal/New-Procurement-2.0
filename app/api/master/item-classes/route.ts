/**
 * GET  /api/master/item-classes
 * POST /api/master/item-classes   (MASTER.ITEM_MANAGE)
 */
import { handler, readJson, requireString, optionalString } from '@/lib/api';
import { createItemClass, listItemClasses } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => listItemClasses());

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return createItemClass(
    { principal, ip },
    {
      code: requireString(body.code, 'code'),
      name: requireString(body.name, 'name', { max: 120 }),
      isColdChain: body.is_cold_chain === true,
      tempMinC: optionalString(body.temp_min_c, 'temp_min_c'),
      tempMaxC: optionalString(body.temp_max_c, 'temp_max_c'),
      requiresDataLogger: body.requires_data_logger === true,
    },
  );
});
