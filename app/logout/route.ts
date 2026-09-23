/**
 * GET /logout — clear the session.
 *
 * In local mode that lands you back on the picker. With Crystal Core it hands
 * back to Core, which does not sign you out of Core itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session';

const CORE_URL = process.env.CRYSTAL_CORE_URL || 'https://crystal-core-official-version.vercel.app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const target = process.env.AUTH_MODE === 'core' ? new URL(CORE_URL) : new URL('/signin', req.url);

  const response = NextResponse.redirect(target);
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
