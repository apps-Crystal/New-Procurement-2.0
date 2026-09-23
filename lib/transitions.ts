/**
 * State machine guard.
 *
 * The schema says of `status_transitions`: "Declared transitions; the API
 * rejects anything not listed here." This module is that rejection.
 *
 * Every status change passes through `assertTransition`, which checks:
 *   1. the arrow from -> to is declared for this entity type
 *   2. the caller holds the permission key the arrow requires
 *   3. the caller holds it AT THE SITE the record belongs to
 *
 * Adding a value to an enum is not enough to make it reachable — the arrow must
 * be declared in `0002_reference_data.sql`. That is deliberate: it keeps the
 * whole state machine reviewable in one place.
 */
import { sql, type Tx } from '@/lib/db';
import { AppError, conflict, forbidden } from '@/lib/errors';
import { can, type PermissionKey, type Principal } from '@/lib/auth/permissions';

export interface TransitionRequest {
  entityType: string;
  from: string;
  to: string;
  principal: Principal | null;
  /**
   * Site the record belongs to, or null when the entity is not site-scoped.
   *
   * Most records belong to a site and the permission must be held THERE. A few
   * — vendors above all — are group-wide: a Functional Head at any site can
   * approve a vendor, because a vendor is not "at" a site at all.
   *
   * Passing 0 for those was a bug: `rolesAt()` finds no site with id 0 and
   * falls back to group-wide roles only, so CG_FHEAD was silently refused
   * while CG_ADM passed. null is the correct way to say "held anywhere".
   */
  siteId: number | null;
}

// (entity_type, from_status, to_status) -> permission_key.
// Reference data changes only with a migration, so this is cached for the life
// of the process.
let cached: Map<string, string> | null = null;

const key = (entityType: string, from: string, to: string) => `${entityType}|${from}|${to}`;

async function loadTransitions(tx?: Tx): Promise<Map<string, string>> {
  if (cached) return cached;

  const runner = tx ?? sql;
  const rows = await runner<{ entity_type: string; from_status: string; to_status: string; permission_key: string }[]>`
    SELECT entity_type, from_status, to_status, permission_key FROM status_transitions`;

  const map = new Map<string, string>();
  for (const r of rows) map.set(key(r.entity_type, r.from_status, r.to_status), r.permission_key);

  if (map.size === 0) {
    // An empty table means the reference migration never ran. Failing loudly
    // here beats silently refusing every action in the product.
    throw new AppError('INTERNAL', 'The workflow configuration is missing. Run: npm run migrate');
  }

  cached = map;
  return map;
}

/** Drop the cache — used by tests and after a reference-data change. */
export function invalidateTransitions() {
  cached = null;
}

/**
 * Throws unless the transition is declared AND permitted. Returns the
 * permission key that authorised it, for the audit remark.
 */
export async function assertTransition(req: TransitionRequest, tx?: Tx): Promise<PermissionKey> {
  const { entityType, from, to, principal, siteId } = req;

  if (from === to) {
    throw conflict(`This ${friendly(entityType)} is already ${to}.`);
  }

  const map = await loadTransitions(tx);
  const permissionKey = map.get(key(entityType, from, to));

  if (!permissionKey) {
    throw conflict(`A ${friendly(entityType)} cannot go from ${from} to ${to}.`);
  }

  if (!can(principal, permissionKey as PermissionKey, siteId)) {
    throw forbidden(`You do not have permission to ${friendlyAction(permissionKey)} at this site.`);
  }

  return permissionKey as PermissionKey;
}

/** Every state reachable from `from`, for rendering the actions a user has. */
export async function allowedTargets(
  entityType: string,
  from: string,
  principal: Principal | null,
  siteId: number,
): Promise<string[]> {
  const map = await loadTransitions();
  const out: string[] = [];
  for (const [k, permissionKey] of map) {
    const [e, f, t] = k.split('|');
    if (e !== entityType || f !== from) continue;
    if (can(principal, permissionKey as PermissionKey, siteId)) out.push(t);
  }
  return out;
}

/**
 * Read a row's current status and LOCK it for the rest of the transaction.
 *
 * Without the lock, two concurrent approvals both read `PR_SUBMITTED` and both
 * proceed. `FOR UPDATE` is the thing the Sheets build had to fake with a
 * distributed lease; here it is free and correct.
 *
 * Table and column names are interpolated, so callers pass literals from this
 * module's own call sites — never user input. `assertIdentifier` is the backstop.
 */
export async function lockAndReadStatus(
  tx: Tx,
  table: string,
  id: number,
  statusColumn = 'status',
): Promise<{ status: string; siteId: number | null } | null> {
  assertIdentifier(table);
  assertIdentifier(statusColumn);

  const hasSite = await hasSiteColumn(tx, table);
  const rows = await tx.unsafe<{ status: string; site_id: string | null }[]>(
    `SELECT ${statusColumn} AS status, ${hasSite ? 'site_id' : 'NULL::bigint AS site_id'}
       FROM ${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );

  if (rows.length === 0) return null;
  return { status: rows[0].status, siteId: rows[0].site_id === null ? null : Number(rows[0].site_id) };
}

const siteColumnCache = new Map<string, boolean>();

async function hasSiteColumn(tx: Tx, table: string): Promise<boolean> {
  const hit = siteColumnCache.get(table);
  if (hit !== undefined) return hit;

  const rows = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'site_id'
    ) AS exists`;

  const has = rows[0]?.exists ?? false;
  siteColumnCache.set(table, has);
  return has;
}

function assertIdentifier(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new AppError('INTERNAL', `Unsafe identifier "${name}"`);
  }
}

// --- Presentation helpers ------------------------------------------------------
// Status codes are how the schema and the prototype's chips both speak, so they
// are shown as-is; only the entity name and action are softened.

const ENTITY_NAMES: Record<string, string> = {
  MR: 'material request',
  TRANSFER: 'transfer',
  PR: 'purchase request',
  PO: 'purchase order',
  GATE_INWARD: 'gate inward',
  GRN: 'goods receipt',
  SHORTFALL: 'shortfall case',
  DAMAGE: 'damage case',
  RTV: 'purchase return',
  VENDOR: 'vendor',
  INVOICE: 'invoice',
  DEBIT_NOTE: 'debit note',
  RECON: 'reconciliation',
};

const ACTION_NAMES: Record<string, string> = {
  APPROVE: 'approve this',
  REJECT: 'reject this',
  SUBMIT: 'submit this',
  CANCEL: 'cancel this',
  ISSUE: 'issue this',
  DISPATCH: 'dispatch this',
  RECEIVE: 'receive this',
  CLOSE: 'close this',
  FLAG: 'flag this',
  DECIDE: 'decide this',
  COMPLETE: 'complete this',
};

function friendly(entityType: string): string {
  return ENTITY_NAMES[entityType] ?? entityType.toLowerCase().replace(/_/g, ' ');
}

function friendlyAction(permissionKey: string): string {
  const [entity, action] = permissionKey.split('.');
  const verb = ACTION_NAMES[action] ?? `${action.toLowerCase().replace(/_/g, ' ')} this`;
  return `${verb} ${friendly(entity)}`;
}
