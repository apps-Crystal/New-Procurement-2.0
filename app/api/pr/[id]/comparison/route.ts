/**
 * GET /api/pr/[id]/comparison — the comparative statement.
 *
 * Landed cost and rank come from `v_quotation_landed_cost`, including its
 * window function. The screen renders the order it is given; it does not sort,
 * because a client-side sort would be a second opinion about which quote is
 * lowest, and the award is checked against the view's.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { buildComparison } from '@/lib/services/quotations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  buildComparison(numericId(params.id)),
);
