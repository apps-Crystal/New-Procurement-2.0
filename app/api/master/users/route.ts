/**
 * GET /api/master/users   everyone who can sign in, with their grants
 *                         (MASTER.USER_ROLE_MANAGE)
 *
 * Separate from /api/master/user-roles, which lists grants. This lists people,
 * including the ones holding nothing — which is who you are usually looking for
 * when you open this screen.
 */
import { handler } from '@/lib/api';
import { listUsers } from '@/lib/services/masters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal, ip }) => listUsers({ principal, ip }));
