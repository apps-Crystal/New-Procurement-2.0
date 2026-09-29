/**
 * POST /api/pr/[id]/award/decide — approve or reject the approval an award
 * opened.
 *
 * Body { approve: boolean, remarks?: string }
 *
 * Separate from /api/pr/[id]/transition, which decides the PURCHASE REQUEST's
 * own chain. A non-lowest award and a quotation waiver are their own approvable
 * entities with their own chains, and conflating the two would let approving a
 * request quietly approve a departure from the lowest price as well.
 */
import { handlerWithParams, numericId, readJson, optionalString } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { decideAward } from '@/lib/services/quotations';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ params, principal, ip, req }) => {
  const prId = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);

  if (typeof body.approve !== 'boolean') {
    throw badRequest('Say whether the award is approved or rejected.', 'approve');
  }

  // The award is addressed through its purchase request, because that is what
  // the person is looking at. One award per PR, so this is unambiguous.
  const [award] = await sql<{ id: string }[]>`SELECT id FROM quote_awards WHERE pr_id = ${prId}`;
  if (!award) throw badRequest('No quotation has been awarded on this request yet.', 'pr_id');

  return decideAward(
    { principal, ip },
    Number(award.id),
    body.approve,
    optionalString(body.remarks, 'remarks', 500) ?? undefined,
  );
});
