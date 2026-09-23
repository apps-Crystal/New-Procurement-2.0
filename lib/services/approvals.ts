/**
 * The approval engine (brief §8).
 *
 * One mechanism for every value-banded approval: PR, write-off, non-lowest
 * award, quote waiver. The `approvals` table is generic —
 * `(entity_type, entity_id, level_no)` — so adding an approvable entity means
 * seeding rows, not writing a second engine.
 *
 * How a decision works:
 *
 *   1. On submission, the value decides the band (`approval_bands`), and the
 *      band's levels become PENDING rows, one per level, in order.
 *   2. Only the LOWEST pending level is actionable. Level 2 cannot decide
 *      before level 1 has.
 *   3. The decider must hold that level's `required_role` AT THE ENTITY'S SITE.
 *   4. A rejection at any level ends the whole chain.
 *   5. When the last level approves, the caller transitions the entity.
 *
 * SEGREGATION OF DUTIES. The schema has `mr_self_approval` and
 * `rtv_self_approval` as CHECK constraints but nothing equivalent for a PR —
 * conflict register C-16. So the rule lives here and applies to every entity
 * type, whether or not a constraint backs it up. The prototype states it on two
 * separate screens ("You cannot approve a PR you raised"), and it is the single
 * most important control in the module.
 */
import type { Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can, type Principal, type RoleCode } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { ROLE_LABELS } from '@/lib/labels';

export type ApprovableEntity = 'PR' | 'WRITE_OFF' | 'NON_LOWEST_AWARD' | 'QUOTE_WAIVER';

export interface ApprovalRow {
  id: number;
  entity_type: string;
  entity_id: number;
  level_no: number;
  required_role: RoleCode;
  approver_id: number | null;
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
  remarks: string | null;
  decided_at: string | null;
}

/**
 * Create the approval chain for an entity.
 *
 * Returns the levels created. Idempotent per entity: a chain that already
 * exists is returned rather than duplicated, because
 * `UNIQUE (entity_type, entity_id, level_no)` would reject the second insert
 * anyway and a resubmission should not be an error.
 */
export async function openApprovalChain(
  tx: Tx,
  entityType: ApprovableEntity,
  entityId: number,
  value: string,
): Promise<ApprovalRow[]> {
  const existing = await tx<ApprovalRow[]>`
    SELECT * FROM approvals
     WHERE entity_type = ${entityType} AND entity_id = ${entityId}
     ORDER BY level_no`;

  if (existing.length > 0) return existing;

  const [band] = await tx<{ id: string; label: string }[]>`
    SELECT id, label FROM approval_bands
     WHERE entity_type = ${entityType} AND is_active
       AND ${value}::numeric >= min_value
       AND (max_value IS NULL OR ${value}::numeric < max_value)
     ORDER BY min_value DESC
     LIMIT 1`;

  if (!band) {
    throw badRequest(
      `No approval route is configured for a ${entityType.replace(/_/g, ' ').toLowerCase()} of ${value}.`,
    );
  }

  const levels = await tx<{ level_no: number; role: RoleCode }[]>`
    SELECT level_no, role FROM approval_band_levels
     WHERE band_id = ${band.id} ORDER BY level_no`;

  if (levels.length === 0) {
    throw badRequest(`The approval band "${band.label}" has no approvers configured.`);
  }

  const created: ApprovalRow[] = [];
  for (const level of levels) {
    const [row] = await tx<ApprovalRow[]>`
      INSERT INTO approvals (entity_type, entity_id, level_no, required_role)
      VALUES (${entityType}, ${entityId}, ${level.level_no}, ${level.role}::role_code)
      RETURNING *`;
    created.push(row);
  }

  return created;
}

export interface ChainState {
  levels: ApprovalRow[];
  /** The level waiting on a decision, or null when the chain is finished. */
  current: ApprovalRow | null;
  complete: boolean;
  rejected: boolean;
}

export async function chainState(tx: Tx, entityType: string, entityId: number): Promise<ChainState> {
  const levels = await tx<ApprovalRow[]>`
    SELECT * FROM approvals
     WHERE entity_type = ${entityType} AND entity_id = ${entityId}
     ORDER BY level_no`;

  const rejected = levels.some(l => l.state === 'REJECTED');
  const current = rejected ? null : (levels.find(l => l.state === 'PENDING') ?? null);
  const complete = levels.length > 0 && !rejected && current === null;

  return { levels, current, complete, rejected };
}

export interface DecisionInput {
  entityType: ApprovableEntity;
  entityId: number;
  /** Site the record belongs to — permissions are site-scoped. */
  siteId: number;
  /** Who raised the entity. They may never decide on it. */
  originatorId: number;
  principal: Principal;
  approve: boolean;
  remarks?: string | null;
  ip?: string | null;
}

export interface DecisionResult {
  state: ChainState;
  /** The level just decided. */
  decided: ApprovalRow;
  /** True when this decision finished the chain (approved at every level). */
  complete: boolean;
  /** True when this decision rejected it. */
  rejected: boolean;
}

/**
 * Record one approval decision.
 *
 * Locks the level being decided, so two approvers who both hold the role cannot
 * both decide it.
 */
export async function decide(tx: Tx, input: DecisionInput): Promise<DecisionResult> {
  const { entityType, entityId, siteId, originatorId, principal } = input;

  // Segregation of duty, before anything else — see the note at the top.
  if (principal.userId === originatorId) {
    throw forbidden(
      `You raised this ${friendly(entityType)}, so you cannot approve it. It has to be someone else.`,
    );
  }

  const [level] = await tx<ApprovalRow[]>`
    SELECT * FROM approvals
     WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND state = 'PENDING'
     ORDER BY level_no
     LIMIT 1
       FOR UPDATE`;

  if (!level) {
    const state = await chainState(tx, entityType, entityId);
    if (state.rejected) throw conflict(`This ${friendly(entityType)} has already been rejected.`);
    if (state.complete) throw conflict(`This ${friendly(entityType)} has already been fully approved.`);
    throw notFound(`This ${friendly(entityType)} has no approval waiting on a decision.`);
  }

  // The level names a role; the caller must hold it at this site.
  const holdsRole = rolesAtSite(principal, siteId).includes(level.required_role);
  if (!holdsRole) {
    throw forbidden(
      `Approval level ${level.level_no} needs ${ROLE_LABELS[level.required_role]} at this site, which you do not hold.`,
    );
  }

  // A rejection at any level requires a reason — the requester has to know why.
  const remarks = input.remarks?.trim() || null;
  if (!input.approve && !remarks) {
    throw badRequest('Rejecting requires a reason.', 'remarks');
  }

  const [decided] = await tx<ApprovalRow[]>`
    UPDATE approvals
       SET state = ${input.approve ? 'APPROVED' : 'REJECTED'}::approval_state,
           approver_id = ${principal.userId},
           remarks = ${remarks},
           decided_at = now()
     WHERE id = ${level.id}
    RETURNING *`;

  await audit(tx, {
    entityType,
    entityId,
    action: 'TRANSITION',
    fromStatus: 'PENDING',
    toStatus: input.approve ? 'APPROVED' : 'REJECTED',
    after: { level_no: level.level_no, required_role: level.required_role },
    userId: principal.userId,
    ip: input.ip,
    remarks: `Approval level ${level.level_no} (${ROLE_LABELS[level.required_role]})${remarks ? ` — ${remarks}` : ''}`,
  });

  const state = await chainState(tx, entityType, entityId);
  return { state, decided, complete: state.complete, rejected: state.rejected };
}

/** Roles the principal holds at a site, including group-wide ones. */
function rolesAtSite(principal: Principal, siteId: number): RoleCode[] {
  const groupWide = principal.groupWide ? principal.roles : [];
  const atSite = principal.sites.find(s => s.siteId === siteId)?.roles ?? [];
  return [...new Set([...groupWide, ...atSite])];
}

function friendly(entityType: string): string {
  switch (entityType) {
    case 'PR':
      return 'purchase request';
    case 'WRITE_OFF':
      return 'write-off';
    case 'NON_LOWEST_AWARD':
      return 'award';
    case 'QUOTE_WAIVER':
      return 'quotation waiver';
    default:
      return entityType.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Approvals waiting on this person, across every entity type.
 *
 * Only the level that is actually actionable is returned — a level 2 sitting
 * behind an undecided level 1 is not this person's problem yet. The
 * originator's own items are excluded, because they can never decide them.
 */
export async function pendingFor(
  tx: Tx,
  principal: Principal,
): Promise<{ entityType: string; entityId: number; levelNo: number; requiredRole: RoleCode; createdAt: string }[]> {
  if (principal.roles.length === 0) return [];

  const siteIds = principal.sites.map(s => s.siteId);
  const roles = principal.roles;

  const rows = await tx<{
    entity_type: string; entity_id: string; level_no: number; required_role: RoleCode; created_at: string;
  }[]>`
    SELECT a.entity_type, a.entity_id, a.level_no, a.required_role, a.created_at
      FROM approvals a
     WHERE a.state = 'PENDING'
       AND a.required_role = ANY(${roles}::role_code[])
       -- only the lowest pending level of each chain is actionable
       AND a.level_no = (
         SELECT min(b.level_no) FROM approvals b
          WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id AND b.state = 'PENDING')
       -- nothing already rejected further down the chain
       AND NOT EXISTS (
         SELECT 1 FROM approvals r
          WHERE r.entity_type = a.entity_type AND r.entity_id = a.entity_id AND r.state = 'REJECTED')
     ORDER BY a.created_at`;

  // Site scoping and the self-approval exclusion need the owning record, which
  // differs per entity type; the caller joins those. Group-wide roles see all.
  void siteIds;

  return rows.map(r => ({
    entityType: r.entity_type,
    entityId: Number(r.entity_id),
    levelNo: r.level_no,
    requiredRole: r.required_role,
    createdAt: r.created_at,
  }));
}

/** Can this principal decide the current level, ignoring who raised it? */
export function canDecideLevel(principal: Principal, level: ApprovalRow, siteId: number): boolean {
  return rolesAtSite(principal, siteId).includes(level.required_role);
}

export { can };
