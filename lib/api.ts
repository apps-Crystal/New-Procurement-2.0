/**
 * Route handler plumbing.
 *
 * Every API route is thin: parse, authorise, call a service, serialise. The
 * wrappers here do the parts that must be identical everywhere — error mapping,
 * the JSON envelope, and idempotency — so a route never invents its own.
 *
 * Response envelope:
 *   success  { ok: true,  data }
 *   failure  { ok: false, error: { message, kind, field? } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { AppError, toAppError, badRequest } from '@/lib/errors';
import { requirePrincipal } from '@/lib/auth/current-user';
import type { Principal } from '@/lib/auth/permissions';

export interface Ctx {
  req: NextRequest;
  principal: Principal;
  /** Client IP, for audit rows. */
  ip: string | null;
  /** Idempotency-Key header, when the client sent one. */
  idempotencyKey: string | null;
}

/**
 * Internal fields that must never reach a client.
 *
 * `_row` is a row's position in the spreadsheet. The repository needs it to
 * target an update, but it is an implementation detail of the store — it shifts
 * whenever rows are inserted, and a client that held onto it would be pointing
 * at the wrong record. Row identity is `id`.
 */
const INTERNAL_FIELDS = new Set(['_row', 'account_number_enc']);

function strip(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 8) return value;
  if (Array.isArray(value)) return value.map(v => strip(v, depth + 1));
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_FIELDS.has(k)) continue;
    out[k] = strip(v, depth + 1);
  }
  return out;
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data: strip(data) }, { status });
}

export function fail(e: unknown) {
  const err = toAppError(e);
  if (err.kind === 'INTERNAL') {
    console.error('[api] internal error:', err.cause ?? err);
  }
  return NextResponse.json(
    { ok: false, error: { message: err.message, kind: err.kind, ...(err.field ? { field: err.field } : {}) } },
    { status: err.status },
  );
}

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

/**
 * Wrap an authenticated handler. Resolves the principal, maps every thrown
 * error, and guarantees the envelope.
 */
export function handler<T>(fn: (ctx: Ctx) => Promise<T>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      const principal = await requirePrincipal();
      const data = await fn({
        req,
        principal,
        ip: clientIp(req),
        idempotencyKey: req.headers.get('idempotency-key'),
      });
      return ok(data);
    } catch (e) {
      return fail(e);
    }
  };
}

/** As `handler`, for routes with dynamic segments. */
export function handlerWithParams<P, T>(fn: (ctx: Ctx & { params: P }) => Promise<T>) {
  return async (req: NextRequest, { params }: { params: Promise<P> }): Promise<NextResponse> => {
    try {
      const principal = await requirePrincipal();
      const data = await fn({
        req,
        principal,
        ip: clientIp(req),
        idempotencyKey: req.headers.get('idempotency-key'),
        params: await params,
      });
      return ok(data);
    } catch (e) {
      return fail(e);
    }
  };
}

// --- Body parsing --------------------------------------------------------------

export async function readJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw badRequest('The request body was not valid JSON.');
  }
}

/** Numeric path parameter, e.g. /api/pr/[id]. */
export function numericId(raw: string, label = 'id'): number {
  const n = Number(decodeURIComponent(raw));
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${label}.`);
  return n;
}

// --- Field helpers -------------------------------------------------------------
// Routes validate shape; services validate business rules; the database is
// authoritative for both. These exist so a malformed request fails with a clear
// message instead of a constraint violation.

export function requireString(v: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${humanise(field)} is required.`, field);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw badRequest(`${humanise(field)} must be at least ${opts.min} characters.`, field);
  if (opts.max && s.length > opts.max) throw badRequest(`${humanise(field)} must be ${opts.max} characters or fewer.`, field);
  return s;
}

export function optionalString(v: unknown, field: string, max?: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  return requireString(v, field, max ? { max } : {});
}

export function requireNumber(v: unknown, field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${humanise(field)} must be a number.`, field);
  if (opts.integer && !Number.isInteger(n)) throw badRequest(`${humanise(field)} must be a whole number.`, field);
  if (opts.min !== undefined && n < opts.min) throw badRequest(`${humanise(field)} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max) throw badRequest(`${humanise(field)} must be at most ${opts.max}.`, field);
  return n;
}

export function optionalNumber(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number | null {
  if (v === null || v === undefined || v === '') return null;
  return requireNumber(v, field, opts);
}

export function requireId(v: unknown, field: string): number {
  return requireNumber(v, field, { min: 1, integer: true });
}

export function optionalId(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  return requireId(v, field);
}

export function requireEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw badRequest(`${humanise(field)} must be one of: ${allowed.join(', ')}.`, field);
  }
  return v as T;
}

export function requireDate(v: unknown, field: string): string {
  const s = requireString(v, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw badRequest(`${humanise(field)} must be a valid date.`, field);
  }
  return s;
}

export function requireArray<T>(v: unknown, field: string, opts: { min?: number } = {}): T[] {
  if (!Array.isArray(v)) throw badRequest(`${humanise(field)} must be a list.`, field);
  if (opts.min && v.length < opts.min) {
    throw badRequest(`${humanise(field)} needs at least ${opts.min} ${opts.min === 1 ? 'entry' : 'entries'}.`, field);
  }
  return v as T[];
}

function humanise(field: string): string {
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

export { AppError };
