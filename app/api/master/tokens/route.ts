/**
 * GET    /api/master/tokens   list, without secrets
 * POST   /api/master/tokens   mint one — the ONLY time the value is returned
 * DELETE /api/master/tokens   revoke
 *
 * All three need MASTER.API_TOKEN_MANAGE, which is CG_ADM. Issuing a token is
 * granting somebody machine access as a user, so it is the same authority as
 * granting a role, and sits beside it.
 */
import { handler, readJson, requireDate, requireId, requireString } from '@/lib/api';
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

  // `requireDate`, not a bare string. A free string reaches the INSERT and
  // Postgres rejects the cast, which surfaces as a 500 and a logged internal
  // error — when the truth is simply that the caller sent a bad date. Note the
  // emptiness check is separate: `expires_at` is optional, but if it is there
  // it has to be a date.
  const expiresAt =
    body.expires_at === undefined || body.expires_at === null || body.expires_at === ''
      ? null
      : requireDate(body.expires_at, 'expires_at');

  const { token, row } = await createToken({
    userId: requireId(body.user_id, 'user_id'),
    name: requireString(body.name, 'name', { min: 3, max: 80 }),
    readOnly: body.read_only,
    expiresAt,
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
