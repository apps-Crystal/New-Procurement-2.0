/**
 * Local sign-in. DEVELOPMENT ONLY.
 *
 *   GET  /api/auth/local   the users available to sign in as
 *   POST /api/auth/local   { email } — mints the session cookie
 *
 * There is no password. Anyone who can reach this endpoint can become any user
 * in `app_users`, which is exactly why `assertLocalAuthAllowed()` refuses to
 * let it run in a production build. See lib/auth/mode.ts.
 *
 * The cookie it mints is the same signed cookie /sso mints, so everything
 * downstream — the principal lookup, site scoping, segregation of duties — is
 * identical to the Core path. Only the way identity is asserted differs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { SESSION_COOKIE, sessionCookieOptions, signSession } from '@/lib/auth/session';
import { assertLocalAuthAllowed } from '@/lib/auth/mode';
import { fail, ok, readJson, requireString } from '@/lib/api';
import { AppError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  core_user_id: string;
  email: string;
  full_name: string;
  status: string;
  roles: string[] | null;
  sites: string[] | null;
}

export async function GET() {
  try {
    assertLocalAuthAllowed();

    // Roles and sites come along so the picker can show what each user can
    // actually do — the quickest way to spot a missing grant.
    const users = await sql<UserRow[]>`
      SELECT u.id, u.core_user_id, u.email, u.full_name, u.status,
             array_remove(array_agg(DISTINCT usr.role::text), NULL) AS roles,
             array_remove(array_agg(DISTINCT s.code), NULL)          AS sites
        FROM app_users u
        LEFT JOIN user_site_roles usr ON usr.user_id = u.id
        LEFT JOIN sites s             ON s.id = usr.site_id
       GROUP BY u.id
       ORDER BY u.full_name`;

    return ok({
      users: users.map(u => ({
        email: u.email,
        fullName: u.full_name,
        status: u.status,
        roles: u.roles ?? [],
        sites: u.sites ?? [],
      })),
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertLocalAuthAllowed();

    const body = await readJson<{ email?: unknown }>(req);
    const email = requireString(body.email, 'email').toLowerCase();

    const [user] = await sql<{ core_user_id: string; full_name: string; status: string }[]>`
      SELECT core_user_id, full_name, status FROM app_users WHERE email = ${email}`;

    if (!user) {
      throw new AppError(
        'NOT_FOUND',
        `No user with the email ${email}. Create one with: npm run bootstrap:admin -- ${email}`,
        { field: 'email' },
      );
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', `${email} is marked ${user.status.toLowerCase()} and cannot sign in.`);
    }

    const response = NextResponse.json({ ok: true, data: { email, fullName: user.full_name } });
    response.cookies.set(
      SESSION_COOKIE,
      await signSession({ email, name: user.full_name, role: '', userId: user.core_user_id }),
      sessionCookieOptions,
    );
    return response;
  } catch (e) {
    return fail(e);
  }
}
