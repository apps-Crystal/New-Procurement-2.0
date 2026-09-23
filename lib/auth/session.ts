/**
 * Signed session cookie. Ported from Crystal Procurement v1.0.
 *
 * A session is `base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))`
 * and is only ever minted by /sso, after Crystal Core has verified the launch
 * token. Identity is never taken from anything the browser can forge — there is
 * no local login, and no query-string launch.
 *
 * The cookie carries only what Core asserts. Roles and site scope are NOT read
 * from here: they come from user_site_roles on every request (lib/auth/permissions.ts),
 * so a role change in Core takes effect without re-issuing sessions.
 *
 * Web Crypto is used so this works in both the Node and Edge runtimes.
 */

export const SESSION_COOKIE = 'crystal_proc2_session';
export const SESSION_MAX_AGE = 60 * 60 * 8; // 8 hours, unchanged from the previous cookie

export interface SessionPayload {
  email: string;
  name: string;
  role: string;
  userId: string;
  iat: number; // seconds
  exp: number; // seconds
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set (>= 32 chars) to sign sessions');
  }
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(input: Omit<SessionPayload, 'iat' | 'exp'>, maxAgeSec = SESSION_MAX_AGE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { ...input, iat: now, exp: now + maxAgeSec };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Returns the payload when the signature is valid and the session has not expired; otherwise null. */
export async function verifySession(cookie: string | undefined | null): Promise<SessionPayload | null> {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (!payload?.userId || !payload.email) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE,
};
