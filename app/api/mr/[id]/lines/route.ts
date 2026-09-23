/**
 * PUT /api/mr/[id]/lines — replace every line on a draft request.
 *
 * Replace rather than patch: `mr_lines_item_uq` forbids the same item twice, and
 * a line-by-line patch would have to reason about the order edits arrive in to
 * avoid tripping it halfway. Sending the whole set makes the end state explicit.
 */
import { handlerWithParams, numericId, readJson, requireArray, requireId, requireString } from '@/lib/api';
import { replaceLines, type MrLineInput } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rawLines = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return replaceLines(
    { principal, ip },
    numericId(params.id),
    rawLines.map(
      (l): MrLineInput => ({
        itemId: requireId(l.item_id, 'item_id'),
        qtyRequested: requireString(l.qty_requested, 'qty_requested'),
      }),
    ),
  );
});
