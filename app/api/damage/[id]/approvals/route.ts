/**
 * GET /api/damage/[id]/approvals — the write-off chain on this report.
 *
 * Empty for a repair or a warranty claim: only a write-off is banded, because
 * it is the only decision that destroys stock rather than moving it.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { writeOffApprovals } from '@/lib/services/damage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  writeOffApprovals(numericId(params.id)),
);
