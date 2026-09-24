/**
 * GET /api/audit?entity_type=&entity_id=&user_id=&action=&from=&to=&search=
 *
 * Read-only by construction: `audit_log` carries a `forbid_mutation()` trigger,
 * so there is nothing to write here even if a route wanted to.
 */
import { handler } from '@/lib/api';
import { auditTrail } from '@/lib/services/audit-trail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return auditTrail(principal, {
    entityType: p.get('entity_type') ?? undefined,
    entityId: p.get('entity_id') ? Number(p.get('entity_id')) : undefined,
    userId: p.get('user_id') ? Number(p.get('user_id')) : undefined,
    action: p.get('action') ?? undefined,
    from: p.get('from') ?? undefined,
    to: p.get('to') ?? undefined,
    search: p.get('search') ?? undefined,
    limit: p.get('limit') ? Number(p.get('limit')) : undefined,
  });
});
