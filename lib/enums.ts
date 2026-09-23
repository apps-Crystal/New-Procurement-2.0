/**
 * Enumerations, taken verbatim from section 0 of the SQL schema.
 *
 * In the database these are CREATE TYPE … AS ENUM, and that is what makes an
 * invalid value impossible — not this file. These copies exist so a dropdown can
 * be built and a bad value refused with a sentence before the round trip, never
 * as the enforcement. If the two ever disagree, the type wins.
 *
 * (Under the retired Sheets backend this file had to carry the enforcement,
 * because a spreadsheet column has no type. See D-05 and D-06.)
 */

export const ENUMS = {
  record_status: ['ACTIVE', 'INACTIVE'],

  site_type: ['PLANT', 'DEPOT', 'PROJECT_SITE', 'WAREHOUSE'],

  role_code: ['CG_REQ', 'CG_SMGR', 'CG_BUY', 'CG_RCV', 'CG_QC', 'CG_WHL', 'CG_ACC', 'CG_ADM', 'CG_FHEAD', 'CG_DIR'],

  vendor_status: ['VENDOR_DRAFT', 'VENDOR_PENDING', 'VENDOR_APPROVED', 'VENDOR_BLOCKED', 'VENDOR_INACTIVE'],

  approval_state: ['PENDING', 'APPROVED', 'REJECTED'],

  category_code: ['MAINTENANCE_CAPEX', 'OPERATIONS_CAPEX', 'PROJECT_SITE_CAPEX', 'SERVICE', 'CONSUMABLES', 'ASSETS'],

  procurement_type: ['MATERIAL', 'SERVICE'],

  urgency_code: ['ROUTINE', 'PLANNED', 'URGENT', 'EMERGENCY'],

  stock_bucket: ['AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'DAMAGED_HOLD', 'UNDER_REPAIR', 'WRITTEN_OFF'],

  movement_type: [
    'OPENING', 'GRN_RECEIPT', 'ISSUE', 'TRANSFER_RESERVE', 'TRANSFER_OUT', 'TRANSFER_IN',
    'DAMAGE_QUARANTINE', 'REPAIR_START', 'REPAIR_COMPLETE', 'WRITE_OFF', 'RTV_REVERSAL',
    'ADJUSTMENT', 'REVERSAL',
  ],

  mr_status: [
    'MR_DRAFT', 'MR_STOCK_CHECK', 'MR_STOCK_AVAILABLE', 'MR_STOCK_PARTIAL', 'MR_STOCK_UNAVAILABLE',
    'MR_TRANSFER_REQUESTED', 'MR_TRANSFER_APPROVED', 'MR_TRANSFER_REJECTED', 'MR_DECLARED',
    'MR_APPROVED', 'MR_REJECTED', 'MR_CONVERTED_TO_PR', 'MR_FULFILLED_INTERNAL', 'MR_CANCELLED',
  ],

  transfer_status: ['TRF_REQUESTED', 'TRF_APPROVED', 'TRF_REJECTED', 'TRF_DISPATCHED', 'TRF_RECEIVED', 'TRF_CANCELLED'],

  pr_status: ['PR_DRAFT', 'PR_SUBMITTED', 'PR_APPROVED', 'PR_REJECTED', 'PO_POSTED', 'PR_CLOSED', 'PR_CANCELLED'],

  quotation_status: ['QUOTE_RECEIVED', 'QUOTE_AWARDED', 'QUOTE_LOST', 'QUOTE_EXPIRED', 'QUOTE_WITHDRAWN'],

  po_status: ['PO_DRAFT', 'PO_CREATED', 'PO_PARTIALLY_RECEIVED', 'PO_RECEIVED', 'PO_SHORT_CLOSED', 'PO_CLOSED', 'PO_CANCELLED'],

  gate_status: ['INWARD_RECEIVED', 'INWARD_REJECTED', 'QC_PENDING', 'QC_IN_PROGRESS', 'QC_COMPLETED'],

  qc_line_verdict: ['QC_ACCEPTED', 'QC_CONDITIONAL_HOLD', 'QC_ACCEPTED_CONCESSION', 'QC_REJECTED'],

  checklist_result: ['PASS', 'FAIL', 'NA'],

  hold_decision: ['CONCESSION', 'REJECT'],

  grn_status: ['GRN_DRAFT', 'GRN_APPROVED', 'GRN_REJECTED', 'GRN_FLAGGED', 'GRN_CLOSED'],

  shortfall_decision: ['PENDING', 'AWAIT_BALANCE', 'SHORT_CLOSE'],

  damage_cause: ['HANDLING', 'STORAGE_FAILURE', 'POWER_REFRIGERATION_FAILURE', 'PEST_CONTAMINATION', 'INTERNAL_TRANSIT', 'EXPIRY', 'UNKNOWN'],

  damage_status: ['DMG_REPORTED', 'DMG_INSPECTED', 'DMG_DECISION_PENDING_APPROVAL', 'DMG_UNDER_REPAIR', 'DMG_RETURN_RAISED', 'DMG_WRITTEN_OFF', 'DMG_CLOSED'],

  damage_decision: ['INTERNAL_REPAIR', 'WARRANTY_CLAIM', 'WRITE_OFF'],

  rtv_source: ['QC_REJECTION', 'WAREHOUSE_DAMAGE', 'SHORTFALL'],

  rtv_basis: ['CREDIT', 'REPLACEMENT', 'FREE_REPLACEMENT', 'REPAIR_AND_RETURN'],

  rtv_status: ['RTV_DRAFT', 'RTV_APPROVED', 'RTV_DISPATCHED', 'RTV_ACKNOWLEDGED', 'RTV_CLOSED', 'RTV_CANCELLED'],

  dn_status: ['DEBIT_NOTE_PENDING', 'DEBIT_NOTE_ISSUED', 'CREDIT_NOTE_RECEIVED', 'DN_ADJUSTED', 'DN_RECONCILED', 'DN_CANCELLED'],

  invoice_status: ['INV_RECEIVED', 'INV_MATCHED', 'INV_PARTIALLY_HELD', 'INV_RELEASED', 'INV_PAID', 'INV_DISPUTED'],

  ledger_side: ['PORTAL', 'TALLY'],

  recon_match: ['MATCHED', 'AMOUNT_DIFFERS', 'ONLY_IN_PORTAL', 'ONLY_IN_TALLY', 'MATCHED_TO_DN', 'OPEN_ITEM'],

  recon_status: ['RECON_OPEN', 'RECON_DIFFERENCE', 'RECON_RECONCILED', 'RECON_CONFIRMED_BY_VENDOR'],

  // Not SQL enums, but closed sets the application relies on.
  entity_type_approval: ['PR', 'WRITE_OFF', 'NON_LOWEST_AWARD', 'QUOTE_WAIVER'],
  outbox_status: ['QUEUED', 'SENT', 'FAILED', 'DEAD'],
  journal_status: ['PENDING', 'COMMITTED', 'FAILED', 'RECOVERED'],
} as const;

export type EnumName = keyof typeof ENUMS;

export function enumValues(name: EnumName): readonly string[] {
  return ENUMS[name];
}

export function isValidEnum(name: EnumName, value: string): boolean {
  return (ENUMS[name] as readonly string[]).includes(value);
}
