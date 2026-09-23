/**
 * GET /sso?token=<JWT>&return=<optional path>
 *
 * The ONLY way a session is created. Crystal Core mints a short-lived launch
 * token and redirects here; we verify it with Core, mirror the identity into
 * app_users, and set the signed session cookie (lib/auth/session.ts).
 *
 * Ported from Crystal Procurement v1.0.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions, signSession } from '@/lib/auth/session';
import { syncUserFromCore } from '@/lib/auth/users';
import { dbConfigured } from '@/lib/db';

const CORE_URL = process.env.CRYSTAL_CORE_URL || 'https://crystal-core-official-version.vercel.app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  const returnTo = req.nextUrl.searchParams.get('return') || '/';

  if (!token) {
    return NextResponse.redirect(new URL('/signed-out?error=missing_token', req.url));
  }
  // Same-origin relative paths only — no open redirect.
  const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';

  let identity: { email: string; name: string; role: string; userId: string };
  try {
    const res = await fetch(`${CORE_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, system: 'procurement' }),
      cache: 'no-store',
    });
    const json = await res.json();

    if (!res.ok || !json.ok || !json.data?.allowed) {
      const code = json?.error?.code ?? 'sso_failed';
      return NextResponse.redirect(new URL(`/signed-out?error=${encodeURIComponent(code)}`, req.url));
    }
    const user = json.data.user;
    if (!user?.email || !user?.userId) {
      return NextResponse.redirect(new URL('/signed-out?error=sso_incomplete_identity', req.url));
    }
    identity = {
      email: String(user.email),
      name: String(user.name ?? ''),
      role: String(json.data.role ?? ''),
      userId: String(user.userId),
    };
  } catch {
    return NextResponse.redirect(new URL('/signed-out?error=sso_unreachable', req.url));
  }

  // Mirror the identity. A failure here must not block sign-in: roles are read
  // from the database anyway, so an unmirrored user simply has no permissions
  // and sees the "ask an administrator" message.
  if (dbConfigured) {
    try {
      await syncUserFromCore(identity);
    } catch (err) {
      console.error('[sso] app_users sync failed:', err);
    }
  }

  const response = NextResponse.redirect(new URL(safeReturn, req.url));
  response.cookies.set(SESSION_COOKIE, await signSession(identity), sessionCookieOptions);
  return response;
}
