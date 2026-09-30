/**
 * GET    /api/master/tokens   list, without secrets
 * POST   /api/master/tokens   mint one — the ONLY time the value is returned
 * DELETE /api/master/tokens   revoke
 *
 * All three need MASTER.API_TOKEN_MANAGE, which is CG_ADM. Issuing a token is
 * granting somebody machine access as a user, so it is the same authority as
 * granting a role, and sits beside it.
 */
import { handler, readJson, requireId, requireString, optionalString } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import { createToken, listTokens, revokeToken } from '@/lib/auth/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function assertMayManage(principal: Parameters<typeof can>[0]): void {
  if (!can(principal, 'MASTER.API_TOKEN_MANAGE', null)) {
    throw forbidden('You do not have permission to manage API tokens.');
  }
}

export const GET = handler(async ({ principal }) => {
  assertMayManage(principal);
  return listTokens();
});

export const POST = handler(async ({ principal, ip, req }) => {
  assertMayManage(principal);
  const body = await readJson<Record<string, unknown>>(req);

  if (typeof body.read_only !== 'boolean') {
    throw badRequest('Say whether the token is read-only. Most integrations should be.', 'read_only');
  }

  const { token, row } = await createToken({
    userId: requireId(body.user_id, 'user_id'),
    name: requireString(body.name, 'name', { min: 3, max: 80 }),
    readOnly: body.read_only,
    expiresAt: optionalString(body.expires_at, 'expires_at', 40) ?? null,
    createdBy: principal.userId,
    ip,
  });

  // The one and only time this value exists outside the caller's machine.
  return { token, ...row };
});

export const DELETE = handler(async ({ principal, ip, req }) => {
  assertMayManage(principal);
  const body = await readJson<Record<string, unknown>>(req);
  const id = requireId(body.id, 'id');

  await revokeToken(id, principal.userId, ip);
  return { revoked: true };
});
