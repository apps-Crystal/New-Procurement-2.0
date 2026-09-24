/** GET /api/audit/[id] — one entry with its before and after. */
import { handlerWithParams, numericId } from '@/lib/api';
import { auditEntry } from '@/lib/services/audit-trail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ principal, params }) =>
  auditEntry(principal, numericId(params.id)),
);
