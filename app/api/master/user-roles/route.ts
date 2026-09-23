/**
 * GET    /api/master/user-roles
 * POST   /api/master/user-roles   grant   (MASTER.USER_ROLE_MANAGE)
 * DELETE /api/master/user-roles   revoke
 */
import { handler, readJson, requireId, requireEnum } from '@/lib/api';
import { grantRole, listUserRoles, revokeRole } from '@/lib/services/masters';
import { ENUMS } from '@/lib/enums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => listUserRoles());

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  await grantRole(
    { principal, ip },
    {
      userId: requireId(body.user_id, 'user_id'),
      siteId: requireId(body.site_id, 'site_id'),
      role: requireEnum(body.role, 'role', ENUMS.role_code),
    },
  );
  return { granted: true };
});

export const DELETE = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  await revokeRole(
    { principal, ip },
    {
      userId: requireId(body.user_id, 'user_id'),
      siteId: requireId(body.site_id, 'site_id'),
      role: requireEnum(body.role, 'role', ENUMS.role_code),
    },
  );
  return { revoked: true };
});
