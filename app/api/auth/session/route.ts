/**
 * GET /api/auth/session — who the caller is, what they may do, and where.
 * The client uses `granted` to hide actions; the server checks the same keys.
 */
import { handler } from '@/lib/api';
import { grantedKeys, openAccess, openApprovals } from '@/lib/auth/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => ({
  userId: principal.userId,
  email: principal.email,
  fullName: principal.fullName,
  roles: principal.roles,
  groupWide: principal.groupWide,
  sites: principal.sites,
  granted: grantedKeys(principal),
  // Reported so screens can smooth testing — prefilling a field rather than
  // making you type it. Never for deciding what is allowed: that is `granted`
  // and, authoritatively, the server.
  devOpenAccess: openAccess() || openApprovals(),
}));
