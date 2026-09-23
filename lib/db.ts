/**
 * PostgreSQL client — the system of record.
 *
 * The schema does the enforcing again: triggers, CHECK constraints, unique
 * indexes, generated columns, `post_stock_movement()` and `next_document_no()`.
 * The service layer's job is to compose them inside a transaction, not to
 * reimplement them.
 *
 * Never import this from a client component. Every business operation that
 * spans more than one statement runs inside `sql.begin`.
 */
import postgres from 'postgres';
import { toAppError } from '@/lib/errors';

declare global {
  // eslint-disable-next-line no-var
  var __crystalSql: ReturnType<typeof postgres> | undefined;
}

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  // A local server does not use SSL and has no connection pooler in front of
  // it, so prepared statements are available and worth having.
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

  return postgres(url, {
    ssl: isLocal ? false : 'require',
    // Supabase and other transaction-mode poolers cannot do prepared
    // statements; a direct connection can, and they are faster.
    prepare: isLocal,
    max: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    transform: { undefined: null },
    connection: { application_name: 'crystal-procurement-2' },
    types: {
      // numeric comes back as a string so a 14,2 money value never touches a
      // JS float. postgres.js does this by default; stated here so nobody
      // "helpfully" parses it later.
    },
  });
}

const RETRYABLE = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/**
 * Retry once on a dropped connection. Never retries SQL errors — those are
 * real, and a constraint violation retried is still a constraint violation.
 *
 * Safe only around reads and around transactions that are atomic end to end,
 * because a retry re-runs the whole function.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, label = 'db'): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code && RETRYABLE.has(code)) {
      console.warn(`[${label}] ${code} — retrying once`);
      return await fn();
    }
    throw e;
  }
}

// Reused across hot reloads and warm lambdas. Created LAZILY on first use —
// importing this module must never require DATABASE_URL, or `next build`
// (which imports route modules but runs no queries) fails without it.
function client(): ReturnType<typeof postgres> {
  return globalThis.__crystalSql ?? (globalThis.__crystalSql = create());
}

export const sql = new Proxy((() => {}) as unknown as ReturnType<typeof postgres>, {
  // Tagged-template call: sql`...`
  apply(_t, _thisArg, args: unknown[]) {
    return (client() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  // Methods and properties: sql.begin, sql.unsafe, sql.json, sql.end, …
  get(_t, prop) {
    // Don't open a connection for a benign thenable probe.
    if (prop === 'then') return undefined;
    const c = client() as unknown as Record<string | symbol, unknown>;
    const v = c[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
}) as ReturnType<typeof postgres>;

export type Sql = postgres.Sql;

/**
 * A transaction handle — the same surface as `sql`, scoped to one transaction.
 *
 * Taken from the postgres.js namespace rather than derived from `Sql['begin']`:
 * `begin` is overloaded, so `Parameters<…>` resolves to the wrong overload and
 * yields `string`.
 */
export type Tx = postgres.TransactionSql;

export const dbConfigured = !!process.env.DATABASE_URL;

/**
 * Run a business operation in one transaction.
 *
 * Two jobs, and the second is easy to overlook.
 *
 * ATOMICITY. If any step throws — a constraint, a trigger, a segregation-of-duty
 * rule — everything rolls back, including the audit row and any document number
 * drawn from a counter.
 *
 * TRANSLATION. Whatever the database raises is mapped to a business-readable
 * error here, at the service boundary, rather than at the HTTP boundary. A
 * caller that is not an HTTP route — the bootstrap script, a verification run,
 * one service calling another — must get the same sentence a user would, not
 * `duplicate key value violates unique constraint "sites_code_key"`.
 *
 * This was found by `npm run verify:db`: the database refused correctly, but
 * because mapping lived only in lib/api.ts, the raw SQLSTATE leaked to anything
 * that called a service directly.
 */
export async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin(fn)) as T;
  } catch (e) {
    throw toAppError(e);
  }
}

/**
 * Map database errors on a read.
 *
 * Reads rarely trip a constraint, so this is for the cases where a service
 * queries outside a transaction and still wants a business-readable failure.
 */
export async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toAppError(e);
  }
}
