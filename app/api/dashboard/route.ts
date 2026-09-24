/**
 * GET /api/dashboard — every metric group.
 *
 * Six queries, one per group, run in parallel. Each metric carries the name of
 * the query that produced it, which is what makes the §24 traceability
 * requirement checkable rather than merely asserted.
 */
import { handler } from '@/lib/api';
import { dashboard } from '@/lib/services/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => dashboard(principal));
