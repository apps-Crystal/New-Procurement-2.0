/**
 * Human labels for schema codes.
 *
 * Role labels come from the prototype's own wording. Three prototype personas
 * — Head of Supply Chain, Head of Operations, Head of Finance — all map to
 * CG_FHEAD (docs/00-decisions.md D-04), so the single label "Functional Head"
 * stands for all three; which one it means in context is set by the approval
 * band, not by the role.
 */
import type { RoleCode } from '@/lib/auth/permissions';

export const ROLE_LABELS: Record<RoleCode, string> = {
  CG_REQ: 'Requester',
  CG_SMGR: 'Site Manager',
  CG_BUY: 'Buyer',
  CG_RCV: 'Site Receiver',
  CG_QC: 'QA/QC Inspector',
  CG_WHL: 'Warehouse Lead',
  CG_ACC: 'Accounts',
  CG_ADM: 'Administrator',
  CG_FHEAD: 'Functional Head',
  CG_DIR: 'Director',
};

export const CATEGORY_LABELS: Record<string, string> = {
  MAINTENANCE_CAPEX: 'Maintenance Capex',
  OPERATIONS_CAPEX: 'Operations Capex',
  PROJECT_SITE_CAPEX: 'Project Site Capex',
  SERVICE: 'Service',
  CONSUMABLES: 'Consumables',
  ASSETS: 'Assets',
};

export const URGENCY_LABELS: Record<string, string> = {
  ROUTINE: 'Routine (15+ days)',
  PLANNED: 'Planned (7–14 days)',
  URGENT: 'Urgent (3–6 days)',
  EMERGENCY: 'Emergency (48 h)',
};

export const SITE_TYPE_LABELS: Record<string, string> = {
  PLANT: 'Plant',
  DEPOT: 'Depot',
  PROJECT_SITE: 'Project site',
  WAREHOUSE: 'Warehouse',
};

export const BUCKET_LABELS: Record<string, string> = {
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  IN_TRANSIT: 'In transit',
  DAMAGED_HOLD: 'Damaged hold',
  UNDER_REPAIR: 'Under repair',
  WRITTEN_OFF: 'Written off',
};

export const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: 'Opening balance',
  GRN_RECEIPT: 'GRN receipt',
  ISSUE: 'Issue',
  TRANSFER_RESERVE: 'Transfer reserved',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  DAMAGE_QUARANTINE: 'Damage quarantine',
  REPAIR_START: 'Repair started',
  REPAIR_COMPLETE: 'Repair completed',
  WRITE_OFF: 'Write-off',
  RTV_REVERSAL: 'Return reversal',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
};

export const DAMAGE_CAUSE_LABELS: Record<string, string> = {
  HANDLING: 'Handling',
  STORAGE_FAILURE: 'Storage failure',
  POWER_REFRIGERATION_FAILURE: 'Power or refrigeration failure',
  PEST_CONTAMINATION: 'Pest or contamination',
  INTERNAL_TRANSIT: 'Internal transit',
  EXPIRY: 'Expiry',
  UNKNOWN: 'Unknown',
};

export const RTV_SOURCE_LABELS: Record<string, string> = {
  QC_REJECTION: 'QC rejection',
  WAREHOUSE_DAMAGE: 'Warehouse damage',
  SHORTFALL: 'Shortfall',
};

export const RTV_BASIS_LABELS: Record<string, string> = {
  CREDIT: 'Credit',
  REPLACEMENT: 'Replacement',
  FREE_REPLACEMENT: 'Free-of-cost replacement',
  REPAIR_AND_RETURN: 'Repair and return',
};

export const RECON_MATCH_LABELS: Record<string, string> = {
  MATCHED: 'Matched',
  AMOUNT_DIFFERS: 'Amount differs',
  ONLY_IN_PORTAL: 'Only in portal',
  ONLY_IN_TALLY: 'Only in Tally',
  MATCHED_TO_DN: 'Matched to DN',
  OPEN_ITEM: 'Open item',
};

/** Fall back to the code itself, so a new enum value is visible rather than blank. */
export function label(map: Record<string, string>, code: string | null | undefined): string {
  if (!code) return '—';
  return map[code] ?? code;
}

/** "Site Receiver · Dhulagarh" — or "Site Receiver, Buyer · 3 sites". */
export function roleSummary(sites: { siteName: string; roles: RoleCode[] }[], groupWide: boolean): string {
  if (sites.length === 0) return groupWide ? 'Group-wide access' : 'No site access';
  const roles = [...new Set(sites.flatMap(s => s.roles))].map(r => ROLE_LABELS[r]);
  const where = sites.length === 1 ? sites[0].siteName : `${sites.length} sites`;
  return `${roles.join(', ')} · ${where}`;
}
