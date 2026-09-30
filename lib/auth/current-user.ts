/**
 * The signed-in user, server side.
 *
 * Identity comes from the signed session cookie minted by /sso; roles and site
 * scope come from the database on every call (lib/auth/permissions.ts). An
 * unsigned or expired cookie is "not signed in" — identity is never taken from
 * anything the browser can forge.
 */
import { cookies, headers } from 'next/headers';
import { SESSION_COOKIE, verifySession, type SessionPayload } from '@/lib/auth/session';
import { getPrincipal, type Principal } from '@/lib/auth/permissions';
import { AppError } from '@/lib/errors';
import { bearerFrom, verifyToken } from '@/lib/auth/tokens';

/** The Crystal Core identity in the cookie, or null. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/**
 * The application principal — app_users id plus every (site, role) grant.
 * Returns null when not signed in, or when Crystal Core knows the user but this
 * application does not (no app_users row, or status INACTIVE).
 */
export async function getCurrentPrincipal(): Promise<Principal | null> {
  const session = await getSession();
  if (!session) return null;
  return getPrincipal(session.userId);
}

/**
 * Can this principal do anything at all?
 *
 * A user can exist in `app_users` — mirrored from Crystal Core, or created by
 * `bootstrap:admin` — and hold no role anywhere. Every record in Procurement
 * belongs to a site, so such a user has literally nothing to see.
 *
 * One rule, used by both the API and the page shell. They disagreed once: the
 * API refused a role-less user while the shell rendered an empty dashboard for
 * them, so they saw a nav with nothing in it and every action failing.
 */
export function hasAnyAccess(principal: Principal | null): principal is Principal {
  if (!principal) return false;
  return principal.groupWide || principal.sites.length > 0;
}

/**
 * As above, but throws instead of returning null. For API routes and actions.
 *
 * Two ways in, in this order:
 *
 *   Authorization: Bearer cgp_…   a machine, acting as the token's user
 *   the session cookie            a person in a browser
 *
 * A token is checked first because a request that carries one is asking to be
 * that token, and falling back to a cookie that happened to be attached would
 * silently act as somebody else.
 *
 * Either way the result is an ordinary Principal built from the database, so
 * everything downstream — permissions, site scope, segregation, audit — cannot
 * tell the difference and does not need to.
 */
export async function requirePrincipal(): Promise<Principal> {
  const bearer = bearerFrom((await headers()).get('authorization'));

  if (bearer) {
    const holder = await verifyToken(bearer);
    if (!holder) {
      // Unknown, revoked and expired are one answer on purpose — saying which
      // tells an attacker that a guess was once real.
      throw new AppError('UNAUTHENTICATED', 'That API token is not valid.');
    }

    const principal = await getPrincipal(holder.coreUserId);

    if (!principal || !hasAnyAccess(principal)) {
      throw new AppError(
        'FORBIDDEN',
        'The account this token acts as has no site access in Procurement.',
      );
    }

    return { ...principal, viaToken: { id: holder.tokenId, readOnly: holder.readOnly } };
  }

  const session = await getSession();
  if (!session) {
    throw new AppError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');
  }

  const principal = await getPrincipal(session.userId);
  if (!principal) {
    throw new AppError(
      'FORBIDDEN',
      'Your account is not set up in Procurement yet. Ask an administrator to grant you a site and role.',
    );
  }
  if (!hasAnyAccess(principal)) {
    throw new AppError(
      'FORBIDDEN',
      'You have no site access in Procurement. Ask an administrator to grant you a site and role.',
    );
  }
  return principal;
}
