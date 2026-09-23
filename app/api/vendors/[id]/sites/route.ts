/** PUT /api/vendors/[id]/sites — the sites this vendor may deliver to. */
import { handlerWithParams, numericId, readJson, requireArray, requireId } from '@/lib/api';
import { setVendorSites } from '@/lib/services/vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const ids = requireArray<unknown>(body.site_ids, 'site_ids').map((v, i) => requireId(v, `site_ids[${i}]`));
  await setVendorSites({ principal, ip }, numericId(params.id), ids);
  return { updated: true };
});
