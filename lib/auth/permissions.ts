/**
 * Authorisation.
 *
 * Roles and site scope come from `user_site_roles` on every request — never
 * from the session cookie — so a role change in Crystal Core takes effect
 * immediately without re-issuing sessions.
 *
 * Two things are checked for every mutating operation:
 *   1. the caller holds a role granting the permission key, AND
 *   2. the caller holds it AT THE SITE the record belongs to.
 *
 * A user can be CG_RCV at Dhulagarh and nothing at Taloja; they may log a gate
 * inward at Dhulagarh only. CG_ADM and CG_DIR are group-wide by definition.
 *
 * Fails closed: any lookup error yields no permissions at all.
 */
import { sql, withDbRetry } from '@/lib/db';

export type RoleCode =
  | 'CG_REQ'
  | 'CG_SMGR'
  | 'CG_BUY'
  | 'CG_RCV'
  | 'CG_QC'
  | 'CG_WHL'
  | 'CG_ACC'
  | 'CG_ADM'
  | 'CG_FHEAD'
  | 'CG_DIR';

/** Roles whose scope is the whole group rather than a list of sites. */
export const GROUP_WIDE_ROLES: readonly RoleCode[] = ['CG_ADM', 'CG_DIR'];

/**
 * Permission key -> roles that grant it.
 *
 * Keys match `status_transitions.permission_key` (db/migrations/0002) one for
 * one, plus the non-transition keys (create, read, master data) below.
 *
 * This is the ONLY place the mapping lives. Screens ask `can()`, they never
 * test a role name — so re-mapping a duty is a one-line change here.
 *
 * Role mapping from prototype labels is fixed by docs/00-decisions.md D-04:
 * Head of Supply Chain / Operations / Finance all read as CG_FHEAD.
 */
export const PERMISSION_MATRIX: Record<string, readonly RoleCode[]> = {
  // --- Material request -------------------------------------------------------
  'MR.VIEW': ['CG_REQ', 'CG_SMGR', 'CG_BUY', 'CG_WHL', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'MR.CREATE': ['CG_REQ', 'CG_SMGR'],
  'MR.EDIT': ['CG_REQ', 'CG_SMGR'],
  'MR.STOCK_CHECK': ['CG_REQ', 'CG_SMGR'],
  'MR.DECLARE': ['CG_REQ', 'CG_SMGR'],
  'MR.REQUEST_TRANSFER': ['CG_REQ', 'CG_SMGR'],
  'MR.TRANSFER_DECIDE': ['CG_WHL'],
  'MR.FULFIL': ['CG_WHL'],
  'MR.APPROVE': ['CG_SMGR', 'CG_FHEAD', 'CG_DIR'],
  'MR.CONVERT': ['CG_REQ', 'CG_BUY', 'CG_SMGR'],
  'MR.CANCEL': ['CG_REQ', 'CG_SMGR'],

  // --- Inter-site transfer ----------------------------------------------------
  'TRANSFER.VIEW': ['CG_REQ', 'CG_SMGR', 'CG_WHL', 'CG_RCV', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'TRANSFER.DECIDE': ['CG_WHL'], // the HOLDING site's warehouse lead
  'TRANSFER.DISPATCH': ['CG_WHL'],
  'TRANSFER.RECEIVE': ['CG_RCV', 'CG_WHL'],
  'TRANSFER.CANCEL': ['CG_REQ', 'CG_SMGR', 'CG_WHL'],

  // --- Purchase request -------------------------------------------------------
  'PR.VIEW': ['CG_REQ', 'CG_SMGR', 'CG_BUY', 'CG_ACC', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'PR.CREATE': ['CG_REQ', 'CG_SMGR', 'CG_BUY'],
  'PR.EDIT': ['CG_REQ', 'CG_SMGR', 'CG_BUY'],
  'PR.SUBMIT': ['CG_REQ', 'CG_SMGR', 'CG_BUY'],
  'PR.RETURN_FOR_EDIT': ['CG_SMGR', 'CG_FHEAD', 'CG_DIR'],
  'PR.APPROVE': ['CG_SMGR', 'CG_FHEAD', 'CG_DIR'],
  'PR.POST_PO': ['CG_BUY'],
  'PR.CLOSE': ['CG_BUY', 'CG_SMGR'],
  'PR.CANCEL': ['CG_REQ', 'CG_SMGR', 'CG_BUY'],

  // --- Quotations and award ---------------------------------------------------
  'QUOTATION.VIEW': ['CG_BUY', 'CG_SMGR', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'QUOTATION.MANAGE': ['CG_BUY'],
  'AWARD.CREATE': ['CG_BUY'],
  'AWARD.APPROVE_NON_LOWEST': ['CG_FHEAD', 'CG_DIR'],
  'AWARD.APPROVE_WAIVER': ['CG_FHEAD', 'CG_DIR'],

  // --- Purchase order ---------------------------------------------------------
  'PO.VIEW': ['CG_BUY', 'CG_SMGR', 'CG_RCV', 'CG_ACC', 'CG_WHL', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'PO.CREATE': ['CG_BUY'],
  'PO.EDIT': ['CG_BUY'],
  'PO.ISSUE': ['CG_BUY'],
  'PO.RECEIVE': ['CG_RCV', 'CG_SMGR', 'CG_WHL'], // system-driven on GRN approval
  'PO.SHORT_CLOSE': ['CG_BUY', 'CG_SMGR'],
  'PO.CLOSE': ['CG_BUY'],
  'PO.CANCEL': ['CG_BUY', 'CG_FHEAD'],

  // --- Gate inward ------------------------------------------------------------
  'GATE_INWARD.VIEW': ['CG_RCV', 'CG_QC', 'CG_SMGR', 'CG_WHL', 'CG_ACC', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'GATE_INWARD.CREATE': ['CG_RCV'],
  'GATE_INWARD.SEND_TO_QC': ['CG_RCV'],
  'GATE_INWARD.REJECT': ['CG_RCV', 'CG_SMGR'],

  // --- QC ---------------------------------------------------------------------
  'QC.VIEW': ['CG_QC', 'CG_RCV', 'CG_SMGR', 'CG_WHL', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'QC.START': ['CG_QC'],
  'QC.EDIT': ['CG_QC'],
  'QC.COMPLETE': ['CG_QC'],
  'QC.REINSPECT': ['CG_QC'],
  'QC.HOLD_DECIDE': ['CG_SMGR'], // concession or reject — Site Manager's call
  'QC.ESCALATE': ['CG_FHEAD'],

  // --- GRN --------------------------------------------------------------------
  'GRN.VIEW': ['CG_RCV', 'CG_QC', 'CG_SMGR', 'CG_WHL', 'CG_ACC', 'CG_BUY', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'GRN.CREATE': ['CG_RCV', 'CG_WHL'],
  'GRN.APPROVE': ['CG_SMGR'],
  'GRN.FLAG': ['CG_SMGR', 'CG_WHL', 'CG_ACC'],
  'GRN.UNFLAG': ['CG_SMGR'],
  'GRN.CLOSE': ['CG_SMGR', 'CG_ACC'],

  // --- Shortfall --------------------------------------------------------------
  'SHORTFALL.VIEW': ['CG_RCV', 'CG_SMGR', 'CG_BUY', 'CG_ACC', 'CG_WHL', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'SHORTFALL.DECIDE': ['CG_SMGR', 'CG_BUY'],

  // --- Inventory --------------------------------------------------------------
  'INVENTORY.VIEW': ['CG_WHL', 'CG_RCV', 'CG_SMGR', 'CG_REQ', 'CG_QC', 'CG_BUY', 'CG_ACC', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'INVENTORY.ISSUE': ['CG_WHL'],
  'INVENTORY.ADJUST': ['CG_WHL', 'CG_SMGR'],
  'INVENTORY.REVERSE': ['CG_SMGR', 'CG_FHEAD'],
  'ASSET.VIEW': ['CG_WHL', 'CG_SMGR', 'CG_RCV', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'ASSET.EDIT': ['CG_WHL', 'CG_SMGR'],

  // --- Damage -----------------------------------------------------------------
  'DAMAGE.VIEW': ['CG_WHL', 'CG_SMGR', 'CG_QC', 'CG_ACC', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'DAMAGE.CREATE': ['CG_WHL', 'CG_RCV', 'CG_SMGR'],
  'DAMAGE.INSPECT': ['CG_SMGR', 'CG_QC'], // joint inspection: both roles required
  'DAMAGE.DECIDE': ['CG_WHL', 'CG_SMGR'],
  'DAMAGE.APPROVE_DECISION': ['CG_WHL', 'CG_FHEAD', 'CG_DIR'], // band-driven
  'DAMAGE.CLOSE': ['CG_WHL', 'CG_SMGR'],

  // --- Purchase return --------------------------------------------------------
  'RTV.VIEW': ['CG_RCV', 'CG_QC', 'CG_WHL', 'CG_SMGR', 'CG_BUY', 'CG_ACC', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'RTV.CREATE': ['CG_QC', 'CG_WHL', 'CG_RCV', 'CG_SMGR'],
  'RTV.APPROVE': ['CG_SMGR', 'CG_FHEAD'],
  'RTV.DISPATCH': ['CG_RCV', 'CG_WHL'],
  'RTV.ACKNOWLEDGE': ['CG_BUY', 'CG_ACC'],
  'RTV.CLOSE': ['CG_ACC', 'CG_SMGR'],
  'RTV.CANCEL': ['CG_SMGR', 'CG_FHEAD'],

  // --- Vendor -----------------------------------------------------------------
  'VENDOR.VIEW': ['CG_BUY', 'CG_ACC', 'CG_SMGR', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'VENDOR.CREATE': ['CG_BUY', 'CG_ADM'],
  'VENDOR.EDIT': ['CG_BUY', 'CG_ADM'],
  'VENDOR.SUBMIT': ['CG_BUY', 'CG_ADM'],
  'VENDOR.APPROVE': ['CG_FHEAD', 'CG_ADM'],
  'VENDOR.RETURN_FOR_EDIT': ['CG_FHEAD', 'CG_ADM'],
  'VENDOR.BLOCK': ['CG_FHEAD', 'CG_ADM'],
  'VENDOR.UNBLOCK': ['CG_FHEAD', 'CG_ADM'],
  'VENDOR.DEACTIVATE': ['CG_ADM'],
  'VENDOR.ACTIVATE': ['CG_ADM'],
  'VENDOR.BANK_VIEW': ['CG_ACC', 'CG_FHEAD', 'CG_ADM'],
  'VENDOR.BANK_PROPOSE': ['CG_ACC', 'CG_BUY'],
  'VENDOR.BANK_APPROVE': ['CG_FHEAD', 'CG_ADM'], // maker-checker: never the proposer

  // --- Accounts ---------------------------------------------------------------
  'INVOICE.VIEW': ['CG_ACC', 'CG_BUY', 'CG_SMGR', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'INVOICE.CREATE': ['CG_ACC'],
  'INVOICE.MATCH': ['CG_ACC'],
  'INVOICE.HOLD': ['CG_ACC'],
  'INVOICE.RELEASE': ['CG_ACC', 'CG_FHEAD'],
  'INVOICE.DISPUTE': ['CG_ACC'],
  'INVOICE.PAY': ['CG_ACC', 'CG_FHEAD'],
  'DEBIT_NOTE.VIEW': ['CG_ACC', 'CG_BUY', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'DEBIT_NOTE.ISSUE': ['CG_ACC'],
  'DEBIT_NOTE.OFFSET': ['CG_ACC'],
  'DEBIT_NOTE.RECONCILE': ['CG_ACC'],
  'DEBIT_NOTE.CANCEL': ['CG_ACC', 'CG_FHEAD'],
  'CREDIT_NOTE.RECORD': ['CG_ACC'],
  'CREDIT_NOTE.ACCEPT_SHORT': ['CG_FHEAD'], // Head of Finance override, C-14
  'RECON.VIEW': ['CG_ACC', 'CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'RECON.RUN': ['CG_ACC'],
  'RECON.RESOLVE': ['CG_ACC'],
  'RECON.CLOSE': ['CG_ACC'],
  'RECON.REOPEN': ['CG_FHEAD'],
  'RECON.CONFIRM': ['CG_ACC'],
  'RECON.IMPORT_TALLY': ['CG_ACC', 'CG_ADM'],

  // --- Master data ------------------------------------------------------------
  'MASTER.VIEW': ['CG_ADM', 'CG_FHEAD', 'CG_DIR', 'CG_BUY', 'CG_SMGR', 'CG_WHL', 'CG_ACC'],
  'MASTER.SITE_MANAGE': ['CG_ADM'],
  'MASTER.LOCATION_MANAGE': ['CG_ADM', 'CG_WHL'],
  'MASTER.ITEM_MANAGE': ['CG_ADM'],
  'MASTER.ITEM_SITE_MANAGE': ['CG_ADM', 'CG_WHL', 'CG_SMGR'],
  'MASTER.BUDGET_MANAGE': ['CG_ADM', 'CG_FHEAD'],
  'MASTER.APPROVAL_BAND_MANAGE': ['CG_ADM'],
  'MASTER.USER_ROLE_MANAGE': ['CG_ADM'],
  'MASTER.CHECKLIST_MANAGE': ['CG_ADM', 'CG_QC'],
  'MASTER.EMAIL_CONFIG_MANAGE': ['CG_ADM'],

  // --- Platform ---------------------------------------------------------------
  'DASHBOARD.VIEW': ['CG_REQ', 'CG_SMGR', 'CG_BUY', 'CG_RCV', 'CG_QC', 'CG_WHL', 'CG_ACC', 'CG_ADM', 'CG_FHEAD', 'CG_DIR'],
  'DASHBOARD.VIEW_GROUP': ['CG_FHEAD', 'CG_DIR', 'CG_ADM'],
  'AUDIT.VIEW': ['CG_ADM', 'CG_FHEAD', 'CG_DIR'],
  'DOCUMENT.UPLOAD': ['CG_REQ', 'CG_SMGR', 'CG_BUY', 'CG_RCV', 'CG_QC', 'CG_WHL', 'CG_ACC', 'CG_ADM'],
};

export type PermissionKey = keyof typeof PERMISSION_MATRIX;

export interface SiteGrant {
  siteId: number;
  siteCode: string;
  siteName: string;
  roles: RoleCode[];
}

export interface Principal {
  /** app_users.id — the FK used by every business table. */
  userId: number;
  coreUserId: string;
  email: string;
  fullName: string;
  /** Every (site, role) grant this user holds. */
  sites: SiteGrant[];
  /** Union of roles across all sites — for group-wide checks only. */
  roles: RoleCode[];
  /** True when the user holds a group-wide role (CG_ADM / CG_DIR). */
  groupWide: boolean;
}

// Short per-process cache so repeated queries in a warm function don't re-read.
const cache = new Map<string, { at: number; principal: Principal | null }>();
const CACHE_MS = 30_000;

export function invalidatePrincipal(coreUserId?: string) {
  if (coreUserId) cache.delete(coreUserId.trim());
  else cache.clear();
}

/**
 * Resolve the signed-in Crystal Core identity to an application principal.
 * Returns null when the user has no app_users row, is INACTIVE, or the lookup
 * fails — all of which mean "no permissions".
 */
export async function getPrincipal(coreUserId: string | undefined | null): Promise<Principal | null> {
  const id = (coreUserId || '').trim();
  if (!id) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.principal;

  let principal: Principal | null = null;
  try {
    principal = await withDbRetry(async () => {
      // One round trip: the user, and every (site, role) grant they hold.
      const rows = await sql<{
        id: string; core_user_id: string; email: string; full_name: string; status: string;
        site_id: string | null; site_code: string | null; site_name: string | null; role: RoleCode | null;
      }[]>`
        SELECT u.id, u.core_user_id, u.email, u.full_name, u.status,
               s.id AS site_id, s.code AS site_code, s.name AS site_name, usr.role
          FROM app_users u
          LEFT JOIN user_site_roles usr ON usr.user_id = u.id
          LEFT JOIN sites s             ON s.id = usr.site_id
         WHERE u.core_user_id = ${id}
         ORDER BY s.code, usr.role`;

      if (rows.length === 0) {
        console.warn(`[auth] no app_users row for core_user_id "${id}"`);
        return null;
      }

      const user = rows[0];
      if (user.status !== 'ACTIVE') return null;

      const bySite = new Map<number, SiteGrant>();
      for (const r of rows) {
        if (r.site_id === null || r.role === null) continue; // user with no grants
        const siteId = Number(r.site_id);
        const entry =
          bySite.get(siteId) ?? { siteId, siteCode: r.site_code!, siteName: r.site_name!, roles: [] };
        entry.roles.push(r.role);
        bySite.set(siteId, entry);
      }

      const sites = [...bySite.values()];
      const roles = [...new Set(sites.flatMap(s => s.roles))];

      return {
        userId: Number(user.id),
        coreUserId: user.core_user_id,
        email: user.email,
        fullName: user.full_name,
        sites,
        roles,
        groupWide: roles.some(r => GROUP_WIDE_ROLES.includes(r)),
      } satisfies Principal;
    }, 'auth');
  } catch (err) {
    console.error('[auth] principal lookup failed:', err);
    principal = null; // fail closed
  }

  cache.set(id, { at: Date.now(), principal });
  return principal;
}

/** Roles the principal holds at a given site, including group-wide roles. */
export function rolesAt(principal: Principal | null, siteId: number | null | undefined): RoleCode[] {
  if (!principal) return [];
  const groupRoles = principal.roles.filter(r => GROUP_WIDE_ROLES.includes(r));
  if (siteId == null) return groupRoles;
  const site = principal.sites.find(s => s.siteId === siteId);
  return [...new Set([...groupRoles, ...(site?.roles ?? [])])];
}

/**
 * Does the principal hold `key` at `siteId`?
 *
 * Passing siteId = null asks whether they hold it ANYWHERE — use that only for
 * navigation and list screens. Every mutation must pass the record's real site.
 */
export function can(principal: Principal | null, key: PermissionKey, siteId?: number | null): boolean {
  if (!principal) return false;
  const granted = PERMISSION_MATRIX[key];
  if (!granted) {
    console.error(`[auth] unknown permission key "${String(key)}"`);
    return false; // fail closed on a typo
  }
  const held = siteId === null || siteId === undefined ? allRolesAnywhere(principal) : rolesAt(principal, siteId);
  return held.some(r => granted.includes(r));
}

function allRolesAnywhere(principal: Principal): RoleCode[] {
  return principal.roles;
}

/** Site ids the principal may act on. `null` means "all sites" (group-wide role). */
export function scopedSiteIds(principal: Principal | null): number[] | null {
  if (!principal) return [];
  if (principal.groupWide) return null;
  return principal.sites.map(s => s.siteId);
}

/** Every permission key the principal holds somewhere — for the client session payload. */
export function grantedKeys(principal: Principal | null): string[] {
  if (!principal) return [];
  return Object.entries(PERMISSION_MATRIX)
    .filter(([, roles]) => principal.roles.some(r => roles.includes(r)))
    .map(([key]) => key);
}
