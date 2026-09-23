/**
 * The signed-in user, server side.
 *
 * Identity comes from the signed session cookie minted by /sso; roles and site
 * scope come from the database on every call (lib/auth/permissions.ts). An
 * unsigned or expired cookie is "not signed in" — identity is never taken from
 * anything the browser can forge.
 */
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession, type SessionPayload } from '@/lib/auth/session';
import { getPrincipal, type Principal } from '@/lib/auth/permissions';
import { AppError } from '@/lib/errors';

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

/** As above, but throws instead of returning null. For API routes and actions. */
export async function requirePrincipal(): Promise<Principal> {
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
