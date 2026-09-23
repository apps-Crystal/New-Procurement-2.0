/**
 * POST /api/mr/[id]/stock-check — run the check and record its verdict.
 *
 * POST, not GET: this writes. The status moves to AVAILABLE, PARTIAL or
 * UNAVAILABLE according to what `v_group_surplus` reports, and that verdict is
 * what the rest of the chain routes on.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { runStockCheck } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, params }) =>
  runStockCheck({ principal, ip }, numericId(params.id)),
);
