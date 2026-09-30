/**
 * API tokens — machine access to the same API the browser uses.
 *
 * A token acts as an existing user. It carries no permissions of its own, so
 * everything that governs that person governs the token: the permission matrix,
 * site scoping, segregation of duties, the audit trail. Revoke their roles and
 * the token's reach goes with them, in the same instant, because roles are read
 * from the database on every call.
 *
 * The value is shown once, at creation, and never again — only its SHA-256 is
 * stored, so there is no code path that could print it. See the migration for
 * why SHA-256 is right here and would be wrong for a password.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { inTransaction, sql } from '@/lib/db';
import { audit } from '@/lib/audit';
import { badRequest, conflict, notFound } from '@/lib/errors';

/** Recognisable in a log or a config file, and obviously not a password. */
const PREFIX = 'cgp_';
const PREFIX_SHOWN = 12;

export interface ApiToken {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  read_only: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Mint a token.
 *
 * 32 bytes of CSPRNG, base64url. The value is returned here and nowhere else —
 * the caller must show it to the person once and then forget it.
 */
export async function createToken(input: {
  userId: number;
  name: string;
  readOnly: boolean;
  expiresAt: string | null;
  createdBy: number;
  ip?: string | null;
}): Promise<{ token: string; row: ApiToken }> {
  const name = input.name?.trim();
  if (!name || name.length < 3 || name.length > 80) {
    throw badRequest('Give the token a name between 3 and 80 characters, so it can be told apart later.', 'name');
  }

  const [user] = await sql<{ status: string }[]>`SELECT status FROM app_users WHERE id = ${input.userId}`;
  if (!user) throw notFound('That user no longer exists.');
  if (user.status !== 'ACTIVE') {
    throw badRequest('That account is not active, so a token for it could never be used.', 'user_id');
  }

  if (input.expiresAt && new Date(input.expiresAt) <= new Date()) {
    throw badRequest('An expiry in the past would make the token dead on arrival.', 'expires_at');
  }

  const token = PREFIX + randomBytes(32).toString('base64url');

  const row = await inTransaction(async tx => {
    const [created] = await tx<ApiToken[]>`
      INSERT INTO api_tokens (user_id, name, prefix, token_hash, read_only, expires_at, created_by)
      VALUES (${input.userId}, ${name}, ${token.slice(0, PREFIX_SHOWN)}, ${hash(token)},
              ${input.readOnly}, ${input.expiresAt}, ${input.createdBy})
      RETURNING id, user_id, name, prefix, read_only, expires_at, last_used_at, revoked_at, created_at`;

    await audit(tx, {
      entityType: 'API_TOKEN', entityId: Number(created.id), action: 'CREATE',
      // The value is never audited — only which token, for whom, and how wide.
      after: { name: created.name, prefix: created.prefix, user_id: created.user_id, read_only: created.read_only },
      userId: input.createdBy, ip: input.ip ?? null,
      remarks: `API token "${created.name}" issued${created.read_only ? ' (read-only)' : ' WITH WRITE ACCESS'}`,
    });

    return created;
  });

  return { token, row };
}

export interface TokenBearer {
  tokenId: number;
  userId: number;
  /** app_users.core_user_id — what getPrincipal() is keyed on. */
  coreUserId: string;
  readOnly: boolean;
}

/**
 * Resolve a presented token, or null.
 *
 * Returns null rather than throwing for every failure — an unknown, expired or
 * revoked token is all the same thing to the caller ("not authenticated"), and
 * distinguishing them in the response would tell an attacker which of their
 * guesses had once been real.
 */
export async function verifyToken(presented: string | null | undefined): Promise<TokenBearer | null> {
  if (!presented || !presented.startsWith(PREFIX)) return null;

  const [row] = await sql<
    {
      id: string; user_id: string; core_user_id: string; token_hash: string;
      read_only: boolean; expires_at: string | null; revoked_at: string | null;
    }[]
  >`SELECT t.id, t.user_id, u.core_user_id, t.token_hash, t.read_only, t.expires_at, t.revoked_at
      FROM api_tokens t
      JOIN app_users u ON u.id = t.user_id
     WHERE t.token_hash = ${hash(presented)}`;

  if (!row) return null;

  // The lookup above already matched on the hash; this is belt and braces
  // against a future change that fetches by prefix instead.
  const a = Buffer.from(row.token_hash, 'utf8');
  const b = Buffer.from(hash(presented), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;

  // Useful for finding tokens nobody is using any more. Deliberately not
  // awaited into the request path — a failed timestamp must not fail the call.
  void sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${Number(row.id)}`.catch(() => {});

  return {
    tokenId: Number(row.id),
    userId: Number(row.user_id),
    coreUserId: row.core_user_id,
    readOnly: row.read_only,
  };
}

/** Extract the token from an Authorization header. */
export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

export async function listTokens(): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    SELECT t.id, t.name, t.prefix, t.read_only, t.expires_at, t.last_used_at,
           t.revoked_at, t.created_at,
           u.email AS user_email, u.full_name AS user_name,
           c.email AS created_by_email
      FROM api_tokens t
      JOIN app_users u ON u.id = t.user_id
      JOIN app_users c ON c.id = t.created_by
     ORDER BY t.revoked_at NULLS FIRST, t.created_at DESC`;
}

/** Revoking is recorded, never deleted — a token that was used is history. */
export async function revokeToken(tokenId: number, revokedBy: number, ip?: string | null): Promise<void> {
  await inTransaction(async tx => {
    const [row] = await tx<{ name: string; revoked_at: string | null }[]>`
      SELECT name, revoked_at FROM api_tokens WHERE id = ${tokenId} FOR UPDATE`;

    if (!row) throw notFound('That token no longer exists.');
    if (row.revoked_at) throw conflict('That token was already revoked.');

    await tx`
      UPDATE api_tokens SET revoked_at = now(), revoked_by = ${revokedBy} WHERE id = ${tokenId}`;

    await audit(tx, {
      entityType: 'API_TOKEN', entityId: tokenId, action: 'UPDATE',
      after: { revoked: true }, userId: revokedBy, ip: ip ?? null,
      remarks: `API token "${row.name}" revoked`,
    });
  });
}
