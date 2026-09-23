/**
 * How a session is established.
 *
 * Two modes, and the difference matters enough to be explicit rather than
 * implied by which environment variables happen to be set.
 *
 *   'local'  — sign in by picking a user. Development only. No password, no
 *              identity provider. The signed session cookie is minted directly.
 *   'core'   — Crystal Core SSO. A short-lived launch token is verified with
 *              Core before any session exists. The production path.
 *
 * LOCAL MODE IS A DEVELOPMENT AFFORDANCE, NOT A LOGIN SYSTEM. Anyone who can
 * reach the server can become anyone. That is fine on localhost and unsafe
 * anywhere else, so `assertLocalAuthAllowed()` refuses to run it in a
 * production build unless someone has very deliberately overridden it.
 *
 * The schema's own comment on app_users — "never a local login" — still holds
 * for what gets deployed. Local mode borrows the table to sign in as an
 * existing mirrored user; it never becomes the source of identity. When Core is
 * switched on, `syncUserFromCore` re-points each row by email, so the users and
 * all their history carry over.
 */

export type AuthMode = 'local' | 'core';

/**
 * Local unless told otherwise. Crystal Core is not wired up yet, and defaulting
 * to it would mean every page redirects to an identity provider that is not
 * ready.
 */
export function authMode(): AuthMode {
  return process.env.AUTH_MODE === 'core' ? 'core' : 'local';
}

export const isLocalAuth = () => authMode() === 'local';

/**
 * Refuse local sign-in outside development.
 *
 * Called by the local sign-in route and page. The override exists because a
 * staging box occasionally needs it, but it has to be typed out on purpose.
 */
export function assertLocalAuthAllowed(): void {
  if (authMode() !== 'local') {
    throw new Error('Local sign-in is disabled; this deployment uses Crystal Core SSO.');
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_AUTH !== '1') {
    throw new Error(
      'Local sign-in is not available in a production build. Set AUTH_MODE=core to use Crystal Core, ' +
        'or ALLOW_LOCAL_AUTH=1 if you genuinely intend to run without an identity provider.',
    );
  }
}

/** True when local sign-in would actually work — for rendering the right page. */
export function localAuthAvailable(): boolean {
  try {
    assertLocalAuthAllowed();
    return true;
  } catch {
    return false;
  }
}

/**
 * The subject id used for a locally-created user.
 *
 * `app_users.core_user_id` is NOT NULL UNIQUE, so a locally-created user still
 * needs one. Prefixing it makes it obvious in the table which rows have never
 * been through Core, and `syncUserFromCore` matches on email, so the first real
 * sign-in replaces this value and keeps the row.
 */
export const localSubjectId = (email: string) => `local:${email.trim().toLowerCase()}`;

export const isLocalSubject = (coreUserId: string) => coreUserId.startsWith('local:') || coreUserId.startsWith('pending:');
