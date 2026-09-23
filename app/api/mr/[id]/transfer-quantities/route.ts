/**
 * POST /api/mr/[id]/transfer-quantities
 * Body { allocations: [{ mr_line_id, qty_transfer }] }
 *
 * Only `qty_transfer` is writable. `qty_purchase` is a generated column, so the
 * purchase balance follows from this and can never be set to contradict it.
 */
import { handlerWithParams, numericId, readJson, requireArray, requireId, requireString } from '@/lib/api';
import { setTransferQuantities } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const raw = requireArray<Record<string, unknown>>(body.allocations, 'allocations', { min: 1 });

  return setTransferQuantities(
    { principal, ip },
    numericId(params.id),
    raw.map(a => ({
      mrLineId: requireId(a.mr_line_id, 'mr_line_id'),
      qtyTransfer: requireString(a.qty_transfer, 'qty_transfer'),
    })),
  );
});
