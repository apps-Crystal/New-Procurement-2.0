/**
 * Master data — sites, locations, item classes, items, budget codes,
 * item-site settings, user-site roles, QC checklists.
 *
 * Much shorter than it needed to be on Sheets, because the database enforces
 * what the service used to hand-code: uniqueness is a UNIQUE index rather than
 * a lock-and-check, formats are CHECK constraints, and `site_code_immutable()`
 * is a trigger again. What is left here is authorisation, normalisation, the
 * audit row, and turning a constraint violation into a sentence — see
 * lib/errors.ts, which maps every constraint by name.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can, invalidatePrincipal, type PermissionKey, type Principal } from '@/lib/auth/permissions';
import { AppError, badRequest, forbidden, notFound } from '@/lib/errors';
import {
  assertGstinMatchesState,
  assertTemperatureBand,
  normaliseText,
  validateCode,
  validateFinancialYear,
  validateGstin,
  validateStateCode,
} from '@/lib/validate';

export interface Actor {
  principal: Principal;
  ip?: string | null;
}

export type Row = Record<string, unknown>;

function requirePermission(actor: Actor, key: PermissionKey, siteId?: number | null) {
  if (!can(actor.principal, key, siteId ?? null)) {
    throw forbidden('You do not have permission to change master data.');
  }
}

async function requireRow(tx: Tx, table: string, id: number, label: string): Promise<Row> {
  const rows = await tx.unsafe<Row[]>(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (rows.length === 0) throw notFound(`That ${label} no longer exists.`);
  return rows[0];
}

// =============================================================================
// Sites
// =============================================================================

export interface SiteInput {
  code: string;
  name: string;
  siteType: string;
  address: string;
  stateCode: string;
  gstin: string;
  coldChainCapable?: boolean;
  tallyCostCentre?: string | null;
  tallyBranch?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

/**
 * Normalise and pre-check.
 *
 * The database would reject all of these anyway; doing it here first means the
 * user gets a message naming the field rather than a constraint name.
 */
function normaliseSite(input: SiteInput) {
  const code = validateCode(input.code, 'code', { min: 2, max: 12 });
  const stateCode = validateStateCode(input.stateCode);
  const gstin = validateGstin(input.gstin);
  assertGstinMatchesState(gstin, stateCode);

  const status = input.status ?? 'INACTIVE';
  const tallyCostCentre = input.tallyCostCentre?.trim() || null;

  if (status === 'ACTIVE' && !tallyCostCentre) {
    throw badRequest('A site cannot be activated until its Tally cost centre is recorded.', 'tally_cost_centre');
  }

  return {
    code,
    name: normaliseText(input.name),
    site_type: input.siteType,
    address: normaliseText(input.address),
    state_code: stateCode,
    gstin,
    cold_chain_capable: input.coldChainCapable ?? false,
    tally_cost_centre: tallyCostCentre,
    tally_branch: input.tallyBranch?.trim() || null,
    status,
  };
}

export async function createSite(actor: Actor, input: SiteInput): Promise<Row> {
  requirePermission(actor, 'MASTER.SITE_MANAGE');
  const v = normaliseSite(input);

  return inTransaction(async tx => {
    const [site] = await tx<Row[]>`
      INSERT INTO sites (code, name, site_type, address, state_code, gstin,
                         cold_chain_capable, tally_cost_centre, tally_branch, status)
      VALUES (${v.code}, ${v.name}, ${v.site_type}::site_type, ${v.address}, ${v.state_code}, ${v.gstin},
              ${v.cold_chain_capable}, ${v.tally_cost_centre}, ${v.tally_branch}, ${v.status}::record_status)
      RETURNING *`;

    await audit(tx, {
      entityType: 'SITE', entityId: Number(site.id), action: 'CREATE',
      after: v, userId: actor.principal.userId, ip: actor.ip,
    });

    return site;
  });
}

export async function updateSite(actor: Actor, id: number, input: Partial<SiteInput>): Promise<Row> {
  requirePermission(actor, 'MASTER.SITE_MANAGE');

  return inTransaction(async tx => {
    const current = await requireRow(tx, 'sites', id, 'site');

    const v = normaliseSite({
      code: input.code ?? String(current.code),
      name: input.name ?? String(current.name),
      siteType: input.siteType ?? String(current.site_type),
      address: input.address ?? String(current.address),
      stateCode: input.stateCode ?? String(current.state_code),
      gstin: input.gstin ?? String(current.gstin),
      coldChainCapable: input.coldChainCapable ?? Boolean(current.cold_chain_capable),
      tallyCostCentre: input.tallyCostCentre ?? (current.tally_cost_centre as string | null),
      tallyBranch: input.tallyBranch ?? (current.tally_branch as string | null),
      status: input.status ?? (current.status as 'ACTIVE' | 'INACTIVE'),
    });

    // `site_code_immutable()` fires on UPDATE OF code and raises if the site
    // has transacted. Migration 0003 widens what "transacted" means — see
    // conflict register C-24.
    const [site] = await tx<Row[]>`
      UPDATE sites
         SET code = ${v.code}, name = ${v.name}, site_type = ${v.site_type}::site_type,
             address = ${v.address}, state_code = ${v.state_code}, gstin = ${v.gstin},
             cold_chain_capable = ${v.cold_chain_capable}, tally_cost_centre = ${v.tally_cost_centre},
             tally_branch = ${v.tally_branch}, status = ${v.status}::record_status
       WHERE id = ${id}
      RETURNING *`;

    await audit(tx, {
      entityType: 'SITE', entityId: id, action: 'UPDATE',
      before: current, after: v, userId: actor.principal.userId, ip: actor.ip,
    });

    return site;
  });
}

export async function listSites(actor: Actor): Promise<Row[]> {
  if (actor.principal.groupWide) {
    return sql<Row[]>`SELECT * FROM sites ORDER BY code`;
  }
  const ids = actor.principal.sites.map(s => s.siteId);
  if (ids.length === 0) return [];
  return sql<Row[]>`SELECT * FROM sites WHERE id = ANY(${ids}) ORDER BY code`;
}

// =============================================================================
// Storage locations
// =============================================================================

export interface LocationInput {
  siteId: number;
  code: string;
  description?: string | null;
  isCold?: boolean;
  status?: 'ACTIVE' | 'INACTIVE';
}

export async function createLocation(actor: Actor, input: LocationInput): Promise<Row> {
  requirePermission(actor, 'MASTER.LOCATION_MANAGE', input.siteId);
  const code = validateCode(input.code, 'code', { min: 1, max: 24 });

  return inTransaction(async tx => {
    await requireRow(tx, 'sites', input.siteId, 'site');

    const [location] = await tx<Row[]>`
      INSERT INTO storage_locations (site_id, code, description, is_cold, status)
      VALUES (${input.siteId}, ${code}, ${input.description?.trim() || null},
              ${input.isCold ?? false}, ${input.status ?? 'ACTIVE'}::record_status)
      RETURNING *`;

    await audit(tx, {
      entityType: 'STORAGE_LOCATION', entityId: Number(location.id), action: 'CREATE',
      after: { site_id: input.siteId, code }, userId: actor.principal.userId, ip: actor.ip,
    });

    return location;
  });
}

export function listLocations(siteId?: number): Promise<Row[]> {
  return siteId
    ? sql<Row[]>`SELECT * FROM storage_locations WHERE site_id = ${siteId} ORDER BY code`
    : sql<Row[]>`SELECT * FROM storage_locations ORDER BY site_id, code`;
}

// =============================================================================
// Item classes
// =============================================================================

export interface ItemClassInput {
  code: string;
  name: string;
  isColdChain?: boolean;
  tempMinC?: string | null;
  tempMaxC?: string | null;
  requiresDataLogger?: boolean;
}

export async function createItemClass(actor: Actor, input: ItemClassInput): Promise<Row> {
  requirePermission(actor, 'MASTER.ITEM_MANAGE');

  const code = validateCode(input.code, 'code', { min: 2, max: 16 });
  const isCold = input.isColdChain ?? false;
  const minC = input.tempMinC ?? null;
  const maxC = input.tempMaxC ?? null;
  assertTemperatureBand(isCold, minC, maxC);

  return inTransaction(async tx => {
    const [cls] = await tx<Row[]>`
      INSERT INTO item_classes (code, name, is_cold_chain, temp_min_c, temp_max_c, requires_data_logger)
      VALUES (${code}, ${normaliseText(input.name)}, ${isCold},
              ${minC}::numeric, ${maxC}::numeric, ${input.requiresDataLogger ?? false})
      RETURNING *`;

    await audit(tx, {
      entityType: 'ITEM_CLASS', entityId: Number(cls.id), action: 'CREATE',
      after: { code, is_cold_chain: isCold }, userId: actor.principal.userId, ip: actor.ip,
    });

    return cls;
  });
}

export const listItemClasses = (): Promise<Row[]> => sql<Row[]>`SELECT * FROM item_classes ORDER BY code`;

// =============================================================================
// Items
// =============================================================================

export interface ItemInput {
  code: string;
  name: string;
  itemClassId: number;
  uom: string;
  hsnSac?: string | null;
  defaultGstRate?: string;
  isSerialised?: boolean;
  warrantyMonths?: number | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export async function createItem(actor: Actor, input: ItemInput): Promise<Row> {
  requirePermission(actor, 'MASTER.ITEM_MANAGE');

  const code = validateCode(input.code, 'code', { min: 2, max: 32 });
  const uom = input.uom?.trim();
  if (!uom) throw badRequest('Unit of measure is required.', 'uom');

  return inTransaction(async tx => {
    await requireRow(tx, 'item_classes', input.itemClassId, 'item class');

    const [item] = await tx<Row[]>`
      INSERT INTO items (code, name, item_class_id, uom, hsn_sac, default_gst_rate,
                         is_serialised, warranty_months, status)
      VALUES (${code}, ${normaliseText(input.name)}, ${input.itemClassId}, ${uom},
              ${input.hsnSac?.trim() || null}, ${input.defaultGstRate ?? '18'}::numeric,
              ${input.isSerialised ?? false}, ${input.warrantyMonths ?? null},
              ${input.status ?? 'ACTIVE'}::record_status)
      RETURNING *`;

    await audit(tx, {
      entityType: 'ITEM', entityId: Number(item.id), action: 'CREATE',
      after: { code, item_class_id: input.itemClassId }, userId: actor.principal.userId, ip: actor.ip,
    });

    return item;
  });
}

export async function updateItem(actor: Actor, id: number, input: Partial<ItemInput>): Promise<Row> {
  requirePermission(actor, 'MASTER.ITEM_MANAGE');

  return inTransaction(async tx => {
    const current = await requireRow(tx, 'items', id, 'item');

    // Serialisation cannot flip once stock exists: asset_units either exist per
    // unit or they do not, and retrofitting them is not something a toggle can
    // do. Nothing in the schema stops it, so the check lives here.
    if (input.isSerialised !== undefined && input.isSerialised !== current.is_serialised) {
      const [{ count }] = await tx<{ count: string }[]>`
        SELECT count(*)::text FROM stock_ledger WHERE item_id = ${id}`;
      if (Number(count) > 0) {
        throw forbidden(
          'Whether this item is serialised cannot be changed once it has stock movements. Create a new item instead.',
        );
      }
    }

    if (input.itemClassId !== undefined) {
      await requireRow(tx, 'item_classes', input.itemClassId, 'item class');
    }

    const [item] = await tx<Row[]>`
      UPDATE items SET
        name             = ${input.name !== undefined ? normaliseText(input.name) : (current.name as string)},
        item_class_id    = ${input.itemClassId ?? (current.item_class_id as number)},
        uom              = ${input.uom?.trim() ?? (current.uom as string)},
        hsn_sac          = ${input.hsnSac !== undefined ? input.hsnSac?.trim() || null : (current.hsn_sac as string | null)},
        default_gst_rate = ${input.defaultGstRate ?? (current.default_gst_rate as string)}::numeric,
        is_serialised    = ${input.isSerialised ?? (current.is_serialised as boolean)},
        warranty_months  = ${input.warrantyMonths !== undefined ? input.warrantyMonths : (current.warranty_months as number | null)},
        status           = ${input.status ?? (current.status as string)}::record_status
      WHERE id = ${id}
      RETURNING *`;

    await audit(tx, {
      entityType: 'ITEM', entityId: id, action: 'UPDATE',
      before: current, after: item, userId: actor.principal.userId, ip: actor.ip,
    });

    return item;
  });
}

export const listItems = (): Promise<Row[]> => sql<Row[]>`SELECT * FROM items ORDER BY code`;

// =============================================================================
// Item-site settings (reorder levels)
// =============================================================================

export async function setItemSiteSettings(
  actor: Actor,
  input: { itemId: number; siteId: number; reorderLevel: string; reorderQty?: string | null },
): Promise<Row> {
  requirePermission(actor, 'MASTER.ITEM_SITE_MANAGE', input.siteId);

  return inTransaction(async tx => {
    await requireRow(tx, 'items', input.itemId, 'item');
    await requireRow(tx, 'sites', input.siteId, 'site');

    // Composite primary key (item_id, site_id) — a real upsert rather than the
    // read-then-decide the Sheets build had to do.
    const [row] = await tx<Row[]>`
      INSERT INTO item_site_settings (item_id, site_id, reorder_level, reorder_qty)
      VALUES (${input.itemId}, ${input.siteId}, ${input.reorderLevel}::numeric, ${input.reorderQty ?? null}::numeric)
      ON CONFLICT (item_id, site_id)
      DO UPDATE SET reorder_level = EXCLUDED.reorder_level, reorder_qty = EXCLUDED.reorder_qty
      RETURNING *`;

    await audit(tx, {
      entityType: 'ITEM_SITE_SETTING', entityId: input.itemId, action: 'UPDATE',
      after: row, userId: actor.principal.userId, ip: actor.ip,
      remarks: `Reorder level for item ${input.itemId} at site ${input.siteId}`,
    });

    return row;
  });
}

export const listItemSiteSettings = (siteId?: number): Promise<Row[]> =>
  siteId
    ? sql<Row[]>`SELECT * FROM item_site_settings WHERE site_id = ${siteId}`
    : sql<Row[]>`SELECT * FROM item_site_settings`;

// =============================================================================
// Budget codes
// =============================================================================

export interface BudgetCodeInput {
  code: string;
  financialYear: string;
  siteId?: number | null;
  category?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export async function createBudgetCode(actor: Actor, input: BudgetCodeInput): Promise<Row> {
  requirePermission(actor, 'MASTER.BUDGET_MANAGE', input.siteId ?? null);

  const code = validateCode(input.code, 'code', { min: 2, max: 32 });
  const financialYear = validateFinancialYear(input.financialYear);

  return inTransaction(async tx => {
    if (input.siteId) await requireRow(tx, 'sites', input.siteId, 'site');

    const [budget] = await tx<Row[]>`
      INSERT INTO budget_codes (code, financial_year, site_id, category, description, is_active)
      VALUES (${code}, ${financialYear}, ${input.siteId ?? null},
              ${input.category ?? null}::category_code, ${input.description?.trim() || null},
              ${input.isActive ?? true})
      RETURNING *`;

    await audit(tx, {
      entityType: 'BUDGET_CODE', entityId: Number(budget.id), action: 'CREATE',
      after: { code, financial_year: financialYear }, userId: actor.principal.userId, ip: actor.ip,
    });

    return budget;
  });
}

export const listBudgetCodes = (): Promise<Row[]> =>
  sql<Row[]>`SELECT * FROM budget_codes ORDER BY financial_year DESC, code`;

// =============================================================================
// User-site roles
// =============================================================================

export async function grantRole(actor: Actor, input: { userId: number; siteId: number; role: string }): Promise<void> {
  requirePermission(actor, 'MASTER.USER_ROLE_MANAGE');

  await inTransaction(async tx => {
    await requireRow(tx, 'app_users', input.userId, 'user');
    await requireRow(tx, 'sites', input.siteId, 'site');

    // The primary key makes granting twice a no-op rather than an error.
    await tx`
      INSERT INTO user_site_roles (user_id, site_id, role)
      VALUES (${input.userId}, ${input.siteId}, ${input.role}::role_code)
      ON CONFLICT (user_id, site_id, role) DO NOTHING`;

    await audit(tx, {
      entityType: 'USER_SITE_ROLE', entityId: input.userId, action: 'PERMISSION_CHANGE',
      after: input, userId: actor.principal.userId, ip: actor.ip,
      remarks: `Granted ${input.role} at site ${input.siteId}`,
    });
  });

  invalidatePrincipal();
}

export async function revokeRole(actor: Actor, input: { userId: number; siteId: number; role: string }): Promise<void> {
  requirePermission(actor, 'MASTER.USER_ROLE_MANAGE');

  await inTransaction(async tx => {
    const deleted = await tx`
      DELETE FROM user_site_roles
       WHERE user_id = ${input.userId} AND site_id = ${input.siteId} AND role = ${input.role}::role_code`;

    if (deleted.count === 0) return; // nothing held; not an error

    await audit(tx, {
      entityType: 'USER_SITE_ROLE', entityId: input.userId, action: 'PERMISSION_CHANGE',
      before: input, userId: actor.principal.userId, ip: actor.ip,
      remarks: `Revoked ${input.role} at site ${input.siteId}`,
    });
  });

  invalidatePrincipal();
}

export const listUserRoles = (): Promise<Row[]> => sql<Row[]>`
  SELECT usr.user_id, usr.site_id, usr.role, usr.granted_at,
         u.email, u.full_name, s.code AS site_code, s.name AS site_name
    FROM user_site_roles usr
    JOIN app_users u ON u.id = usr.user_id
    JOIN sites s     ON s.id = usr.site_id
   ORDER BY u.full_name, s.code, usr.role`;

// =============================================================================
// QC checklists
// =============================================================================

export interface ChecklistInput {
  itemClassId: number;
  version: string;
  points: string[];
}

/**
 * Publish a checklist version for an item class.
 *
 * `qc_checklists_current` is a partial unique index allowing exactly one
 * current version per class, so the previous one is retired in the same
 * transaction. Doing it in one transaction is what makes that safe — on Sheets
 * this needed a lock.
 */
export async function publishChecklist(actor: Actor, input: ChecklistInput): Promise<Row> {
  requirePermission(actor, 'MASTER.CHECKLIST_MANAGE');

  const version = normaliseText(input.version);
  if (!version) throw badRequest('A checklist version is required.', 'version');
  if (input.points.length === 0) throw badRequest('A checklist needs at least one check point.', 'points');

  return inTransaction(async tx => {
    await requireRow(tx, 'item_classes', input.itemClassId, 'item class');

    await tx`
      UPDATE qc_checklists SET is_current = false
       WHERE item_class_id = ${input.itemClassId} AND is_current`;

    const [checklist] = await tx<Row[]>`
      INSERT INTO qc_checklists (item_class_id, version, is_current)
      VALUES (${input.itemClassId}, ${version}, true)
      RETURNING *`;

    for (const [i, description] of input.points.entries()) {
      await tx`
        INSERT INTO qc_checklist_points (checklist_id, point_no, description)
        VALUES (${checklist.id as number}, ${i + 1}, ${normaliseText(description)})`;
    }

    await audit(tx, {
      entityType: 'QC_CHECKLIST', entityId: Number(checklist.id), action: 'CREATE',
      after: { item_class_id: input.itemClassId, version, points: input.points.length },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return checklist;
  });
}

/** The current checklist for an item class, with its points. */
export async function currentChecklist(itemClassId: number): Promise<{ checklist: Row; points: Row[] } | null> {
  const [checklist] = await sql<Row[]>`
    SELECT * FROM qc_checklists WHERE item_class_id = ${itemClassId} AND is_current`;
  if (!checklist) return null;

  const points = await sql<Row[]>`
    SELECT * FROM qc_checklist_points WHERE checklist_id = ${checklist.id as number} ORDER BY point_no`;

  return { checklist, points };
}

export const listChecklists = (): Promise<Row[]> => sql<Row[]>`
  SELECT c.*, ic.code AS item_class_code, ic.name AS item_class_name
    FROM qc_checklists c
    JOIN item_classes ic ON ic.id = c.item_class_id
   ORDER BY ic.code, c.created_at DESC`;

// =============================================================================
// Approval bands
// =============================================================================

/**
 * The band an amount falls into, and the roles that must approve it.
 *
 * `min_value` is inclusive and `max_value` exclusive, so the seeded bands
 * (0–1 lakh, 1–10 lakh, above) tile the range without overlap or gap.
 */
export async function resolveApprovalBand(
  entityType: 'PR' | 'WRITE_OFF' | 'NON_LOWEST_AWARD' | 'QUOTE_WAIVER',
  amount: string,
): Promise<{ band: Row; levels: Row[] }> {
  const [band] = await sql<Row[]>`
    SELECT * FROM approval_bands
     WHERE entity_type = ${entityType} AND is_active
       AND ${amount}::numeric >= min_value
       AND (max_value IS NULL OR ${amount}::numeric < max_value)
     ORDER BY min_value DESC
     LIMIT 1`;

  if (!band) {
    throw new AppError(
      'INTERNAL',
      `No approval band is configured for a ${entityType} of ${amount}. Run: npm run migrate`,
    );
  }

  const levels = await sql<Row[]>`
    SELECT * FROM approval_band_levels WHERE band_id = ${band.id as number} ORDER BY level_no`;

  return { band, levels };
}
