/**
 * GET /api/audit/summary?from= — what the trail contains.
 *
 * The filter chips are built from this rather than from a hardcoded list, so a
 * new entity type appears the moment something writes one.
 */
import { handler } from '@/lib/api';
import { auditSummary } from '@/lib/services/audit-trail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) =>
  auditSummary(principal, req.nextUrl.searchParams.get('from') ?? undefined),
);
