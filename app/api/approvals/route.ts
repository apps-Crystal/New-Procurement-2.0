/**
 * GET /api/approvals — everything the caller can decide right now.
 *
 * Only the lowest open level of each chain appears, and only where the caller
 * holds the required role at the record's site and did not raise it themselves.
 * Offering work that `decide()` would refuse is worse than not offering it: the
 * refusal arrives after the approver has read the whole request.
 */
import { handler } from '@/lib/api';
import { pendingApprovals } from '@/lib/services/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => pendingApprovals(principal));
