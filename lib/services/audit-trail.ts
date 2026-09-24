/**
 * Audit trail viewer (brief §29).
 *
 * `audit_log` is append-only and has a `forbid_mutation()` trigger on it, so
 * this module reads and never writes. Writing is `lib/audit.ts`, which is
 * called inside every mutating transaction.
 *
 * The filters are the questions people actually ask of an audit trail: what
 * happened to this record, what did this person do, and what was overridden.
 * That last one is why `action` is a filter at all — OVERRIDE and
 * REJECTED_ATTEMPT are the rows that matter, and a viewer that buried them
 * among thousands of ordinary transitions would not be a control.
 */
import { sql } from '@/lib/db';
import { forbidden, notFound } from '@/lib/errors';
import { can, type Principal } from '@/lib/auth/permissions';
import type { Row } from '@/lib/services/masters';

export interface AuditFilters {
  entityType?: string;
  entityId?: number;
  userId?: number;
  action?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

/**
 * Read the trail.
 *
 * Not site-scoped, deliberately: `audit_log` has no site column, and inferring
 * one per entity type would mean a different join for each of twenty tables —
 * each of which could be wrong in a way nobody would notice. `AUDIT.VIEW` is
 * the gate instead, and it is granted narrowly.
 */
export async function auditTrail(principal: Principal, filters: AuditFilters = {}): Promise<Row[]> {
  if (!can(principal, 'AUDIT.VIEW', null)) {
    throw forbidden('You do not have permission to read the audit trail.');
  }

  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;

  return sql<Row[]>`
    SELECT a.*, u.full_name AS user_name, u.email AS user_email
      FROM audit_log a
      LEFT JOIN app_users u ON u.id = a.user_id
     WHERE (${filters.entityType ?? null}::text IS NULL OR a.entity_type = ${filters.entityType ?? null})
       AND (${filters.entityId ?? null}::bigint IS NULL OR a.entity_id = ${filters.entityId ?? null})
       AND (${filters.userId ?? null}::bigint IS NULL OR a.user_id = ${filters.userId ?? null})
       AND (${filters.action ?? null}::text IS NULL OR a.action = ${filters.action ?? null})
       AND (${filters.from ?? null}::date IS NULL OR a.created_at >= ${filters.from ?? null}::date)
       AND (${filters.to ?? null}::date IS NULL OR a.created_at < ${filters.to ?? null}::date + 1)
       AND (${search}::text IS NULL
            OR a.remarks ILIKE ${search}
            OR a.entity_type ILIKE ${search}
            OR u.full_name ILIKE ${search})
     ORDER BY a.id DESC
     LIMIT ${Math.min(filters.limit ?? 200, 500)}`;
}

/** One entry in full, with its before and after. */
export async function auditEntry(principal: Principal, id: number): Promise<Row> {
  if (!can(principal, 'AUDIT.VIEW', null)) {
    throw forbidden('You do not have permission to read the audit trail.');
  }

  const [row] = await sql<Row[]>`
    SELECT a.*, u.full_name AS user_name, u.email AS user_email
      FROM audit_log a
      LEFT JOIN app_users u ON u.id = a.user_id
     WHERE a.id = ${id}`;

  if (!row) throw notFound('That audit entry no longer exists.');
  return row;
}

/**
 * Everything that happened to one record, oldest first.
 *
 * This is the view that matters when somebody asks "who changed this and when",
 * which is the question an audit trail is for.
 */
export async function historyOf(
  principal: Principal,
  entityType: string,
  entityId: number,
): Promise<Row[]> {
  if (!can(principal, 'AUDIT.VIEW', null)) {
    throw forbidden('You do not have permission to read the audit trail.');
  }

  return sql<Row[]>`
    SELECT a.*, u.full_name AS user_name
      FROM audit_log a
      LEFT JOIN app_users u ON u.id = a.user_id
     WHERE a.entity_type = ${entityType} AND a.entity_id = ${entityId}
     ORDER BY a.id`;
}

export interface AuditSummary {
  entityTypes: { entity_type: string; n: number }[];
  actions: { action: string; n: number }[];
  overrides: number;
  total: number;
}

/**
 * What the trail contains, for the filter chips.
 *
 * Counted rather than hardcoded so a new entity type appears in the filters the
 * moment something writes one — a filter list that has to be edited by hand is
 * a filter list that silently goes stale.
 */
export async function auditSummary(principal: Principal, from?: string): Promise<AuditSummary> {
  if (!can(principal, 'AUDIT.VIEW', null)) {
    throw forbidden('You do not have permission to read the audit trail.');
  }

  const [entityTypes, actions, totals] = await Promise.all([
    sql<Row[]>`
      SELECT entity_type, count(*)::int AS n FROM audit_log
       WHERE (${from ?? null}::date IS NULL OR created_at >= ${from ?? null}::date)
       GROUP BY entity_type ORDER BY n DESC`,
    sql<Row[]>`
      SELECT action, count(*)::int AS n FROM audit_log
       WHERE (${from ?? null}::date IS NULL OR created_at >= ${from ?? null}::date)
       GROUP BY action ORDER BY n DESC`,
    sql<Row[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE action = 'OVERRIDE')::int AS overrides
        FROM audit_log
       WHERE (${from ?? null}::date IS NULL OR created_at >= ${from ?? null}::date)`,
  ]);

  return {
    entityTypes: entityTypes.map(r => ({ entity_type: String(r.entity_type), n: Number(r.n) })),
    actions: actions.map(r => ({ action: String(r.action), n: Number(r.n) })),
    overrides: Number(totals[0].overrides),
    total: Number(totals[0].total),
  };
}
