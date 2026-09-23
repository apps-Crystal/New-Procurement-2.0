/** PUT /api/vendors/[id]/categories — the item classes this vendor supplies. */
import { handlerWithParams, numericId, readJson, requireArray, requireId } from '@/lib/api';
import { setVendorCategories } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const ids = requireArray<unknown>(body.item_class_ids, 'item_class_ids').map((v, i) =>
    requireId(v, `item_class_ids[${i}]`),
  );
  await setVendorCategories({ principal, ip }, numericId(params.id), ids);
  return { updated: true };
});
