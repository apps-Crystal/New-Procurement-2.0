/**
 * Session gate.
 *
 * An unauthenticated page request is sent somewhere it can sign in — the local
 * picker, or Crystal Core once AUTH_MODE=core. Either way the session cookie is
 * verified here but its CONTENTS are never trusted: roles and site scope are
 * read from the database on every request.
 *
 * API routes are not gated here, so they can answer 401 as JSON rather than
 * redirecting a fetch into an HTML page.
 *
 * Also rejects the v1.0 query-string login (/?u=&n=&r=&uid=), which let anyone
 * impersonate anyone by typing a URL.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session';

const LEGACY_PARAMS = ['u', 'n', 'r', 'uid'];
const CORE_URL = process.env.CRYSTAL_CORE_URL || 'https://crystal-core-official-version.vercel.app';
const PUBLIC_PATHS = ['/sso', '/logout', '/signed-out', '/signin', '/no-access'];

export async function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (LEGACY_PARAMS.some(p => searchParams.has(p))) {
    console.warn('[auth] legacy query-string login attempted and rejected', {
      path: pathname,
      ip: req.headers.get('x-forwarded-for') ?? undefined,
    });
    return NextResponse.redirect(new URL('/signin?error=legacy_login_disabled', req.url));
  }

  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // Read the mode directly rather than importing lib/auth/mode: middleware runs
  // on the Edge runtime, and keeping its imports to nothing but the session
  // module avoids dragging server-only code into that bundle.
  if (process.env.AUTH_MODE === 'core') {
    const back = new URL(CORE_URL);
    back.searchParams.set('system', 'procurement');
    back.searchParams.set('return', pathname);
    return NextResponse.redirect(back);
  }

  const signin = new URL('/signin', req.url);
  if (pathname !== '/') signin.searchParams.set('return', pathname);
  return NextResponse.redirect(signin);
}

export const config = {
  matcher: '/((?!_next/|api/|favicon.ico|.*\\.[\\w]+$).*)',
};
