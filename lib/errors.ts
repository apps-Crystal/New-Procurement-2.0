/**
 * Business-readable errors (brief §32).
 *
 * The database is the last line of defence and it speaks SQLSTATE. A user must
 * never see `23503 foreign key violation`. Every constraint in the schema that
 * a user can realistically trip is mapped here to a sentence that says what
 * went wrong and what to do about it.
 *
 * Technical detail is logged; only the mapped message reaches the client.
 */

export type ErrorKind =
  | 'VALIDATION' // 400 — the request is malformed or breaks a business rule
  | 'UNAUTHENTICATED' // 401 — no valid session
  | 'FORBIDDEN' // 403 — authenticated but not permitted
  | 'NOT_FOUND' // 404
  | 'CONFLICT' // 409 — state machine / duplicate / concurrent change
  | 'INTERNAL'; // 500

const STATUS: Record<ErrorKind, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

/**
 * An error whose message is safe to show a user.
 * `field` lets the UI attach it to the input that caused it.
 */
export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly field?: string;
  readonly detail?: string;

  constructor(kind: ErrorKind, message: string, opts: { field?: string; detail?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.kind = kind;
    this.field = opts.field;
    this.detail = opts.detail;
  }

  get status(): number {
    return STATUS[this.kind];
  }
}

export const badRequest = (m: string, field?: string) => new AppError('VALIDATION', m, { field });
export const forbidden = (m = 'You do not have permission to do this.') => new AppError('FORBIDDEN', m);
export const notFound = (m = 'That record no longer exists.') => new AppError('NOT_FOUND', m);
export const conflict = (m: string) => new AppError('CONFLICT', m);

/**
 * Constraint name -> message.
 *
 * Keys are the exact constraint/index names from db/migrations/0001_schema.sql.
 * When a constraint fires that is not listed here, the raw name is logged and
 * the user gets a generic message — so an unmapped constraint is a gap to fix,
 * never a leak.
 */
const CONSTRAINT_MESSAGES: Record<string, { kind: ErrorKind; message: string; field?: string }> = {
  // --- Sites ------------------------------------------------------------------
  sites_gstin_format: { kind: 'VALIDATION', field: 'gstin', message: 'That GSTIN is not valid. It must be 15 characters: two state digits, a 10-character PAN, then three more.' },
  sites_gstin_state: { kind: 'VALIDATION', field: 'gstin', message: 'The GSTIN does not match the state selected. The first two digits of a GSTIN are the GST state code.' },
  sites_active_needs_mapping: { kind: 'VALIDATION', field: 'tally_cost_centre', message: 'A site cannot be activated until its Tally cost centre is recorded.' },
  sites_code_key: { kind: 'CONFLICT', field: 'code', message: 'Another site already uses that code.' },

  // --- Vendors ----------------------------------------------------------------
  vendors_pan_format: { kind: 'VALIDATION', field: 'pan', message: 'That PAN is not valid. The format is five letters, four digits, then one letter — for example ABCDE1234F.' },
  vendors_gstin_format: { kind: 'VALIDATION', field: 'gstin', message: 'That GSTIN is not valid. It must be 15 characters.' },
  vendors_gstin_pan: { kind: 'VALIDATION', field: 'gstin', message: 'The GSTIN does not contain the PAN entered. Characters 3 to 12 of a GSTIN are the PAN.' },
  vendors_approved_needs_ledger: { kind: 'VALIDATION', field: 'tally_ledger_ref', message: 'A vendor cannot be approved until their Tally ledger reference is recorded.' },
  vendors_blocked_reason: { kind: 'VALIDATION', field: 'blocked_reason', message: 'Blocking a vendor requires a reason.' },
  vendors_pan_uq: { kind: 'CONFLICT', field: 'pan', message: 'A vendor with that PAN already exists. Open the existing vendor instead of creating a duplicate.' },
  vendors_gstin_uq: { kind: 'CONFLICT', field: 'gstin', message: 'A vendor with that GSTIN already exists. Open the existing vendor instead of creating a duplicate.' },
  vendors_vendor_code_key: { kind: 'CONFLICT', field: 'vendor_code', message: 'Another vendor already uses that code.' },

  // --- Vendor bank accounts ---------------------------------------------------
  vba_maker_checker: { kind: 'FORBIDDEN', message: 'You proposed these bank details, so you cannot approve them. Someone else in Accounts or Finance must check them.' },
  vba_one_live: { kind: 'CONFLICT', message: 'This vendor already has an approved bank account. Deactivate the current one before approving another.' },
  vendor_bank_accounts_ifsc_check: { kind: 'VALIDATION', field: 'ifsc', message: 'That IFSC is not valid. The format is four letters, a zero, then six characters.' },

  // --- Material request -------------------------------------------------------
  mr_self_approval: { kind: 'FORBIDDEN', message: 'You raised this material request, so you cannot approve it.' },
  mr_reject_reason: { kind: 'VALIDATION', field: 'rejection_reason', message: 'Rejecting a material request requires a reason.' },
  mr_lines_transfer_le: { kind: 'VALIDATION', field: 'qty_transfer', message: 'The transfer quantity cannot exceed the quantity requested.' },
  material_requests_mr_no_key: { kind: 'CONFLICT', message: 'That material request number is already in use. Please retry.' },

  // --- Declaration ------------------------------------------------------------
  mr_declarations_business_impact_check: { kind: 'VALIDATION', field: 'business_impact', message: 'The business impact must be between 40 and 500 characters.' },
  mr_declarations_estimated_value_check: { kind: 'VALIDATION', field: 'estimated_value', message: 'The estimated value must be greater than zero.' },
  mr_allocations_pct_check: { kind: 'VALIDATION', field: 'pct', message: 'Each allocation must be more than 0% and at most 100%.' },

  // --- Transfers --------------------------------------------------------------
  trf_sites_differ: { kind: 'VALIDATION', field: 'to_site_id', message: 'A transfer must move stock between two different sites.' },
  trf_reject_reason: { kind: 'VALIDATION', field: 'rejection_reason', message: 'Rejecting a transfer requires a reason.' },

  // --- Purchase request -------------------------------------------------------
  pr_payment_terms_total: { kind: 'VALIDATION', field: 'payment_terms', message: 'Payment terms must total exactly 100%. Enter an override note if the terms cannot be expressed as percentages.' },
  pr_delivery_charge: { kind: 'VALIDATION', field: 'delivery_charge_amount', message: 'When delivery is chargeable, both the delivery amount and its GST rate are required.' },
  pr_cancel_reason: { kind: 'VALIDATION', field: 'cancelled_reason', message: 'Cancelling a purchase request requires a reason.' },
  pr_lines_qty_check: { kind: 'VALIDATION', field: 'qty', message: 'The quantity must be greater than zero.' },
  purchase_requests_pr_no_key: { kind: 'CONFLICT', message: 'That purchase request number is already in use. Please retry.' },

  // --- Quotations and award ---------------------------------------------------
  quotations_validity: { kind: 'VALIDATION', field: 'valid_until', message: 'The validity date cannot be before the quotation date.' },
  quotations_pr_id_vendor_id_key: { kind: 'CONFLICT', field: 'vendor_id', message: 'This vendor has already quoted against this purchase request. Edit the existing quotation instead.' },
  awards_waiver: { kind: 'VALIDATION', field: 'waiver_reason', message: 'Fewer than the minimum number of quotations were received, so a waiver reason is required.' },
  awards_nonlow: { kind: 'VALIDATION', field: 'justification', message: 'Awarding to a vendor that is not the lowest requires both a reason code and a written justification.' },
  quote_awards_pr_id_key: { kind: 'CONFLICT', message: 'This purchase request has already been awarded.' },

  // --- Purchase order ---------------------------------------------------------
  po_issue_needs_tally: { kind: 'VALIDATION', field: 'tally_po_ref', message: 'The Tally PO reference must be entered before this purchase order can be issued.' },
  po_short_reason: { kind: 'VALIDATION', field: 'short_close_reason', message: 'Short-closing a purchase order requires a reason.' },
  purchase_orders_pr_id_key: { kind: 'CONFLICT', message: 'A purchase order already exists for this purchase request. Only one is allowed.' },
  purchase_orders_tally_po_ref_key: { kind: 'CONFLICT', field: 'tally_po_ref', message: 'That Tally PO reference is already used by another purchase order.' },

  // --- Gate inward ------------------------------------------------------------
  gi_vehicle_format: { kind: 'VALIDATION', field: 'vehicle_no', message: 'That vehicle number is not valid. Use the registration without spaces — for example WB11C4821.' },
  gi_reject_reason: { kind: 'VALIDATION', field: 'rejection_reason', message: 'Rejecting a delivery at the gate requires a reason.' },
  gi_replacement: { kind: 'VALIDATION', field: 'replacement_rtv_id', message: 'A replacement delivery must reference the purchase return it replaces.' },
  gate_inwards_challan_uq: { kind: 'CONFLICT', field: 'challan_no', message: 'That delivery challan has already been logged against this purchase order.' },

  // --- QC ---------------------------------------------------------------------
  qc_lines_sum: { kind: 'VALIDATION', field: 'qty_accepted', message: 'Accepted, hold and rejected quantities must add up to the delivered quantity.' },
  qc_lines_reason: { kind: 'VALIDATION', field: 'reason_code', message: 'A reason is required whenever any quantity is put on hold or rejected.' },
  qc_inspections_gi_original: { kind: 'CONFLICT', message: 'This delivery has already been inspected. Raise a re-inspection instead of a new inspection.' },
  qc_checklists_current: { kind: 'CONFLICT', message: 'That item class already has a current checklist version. Retire it before publishing another.' },

  // --- GRN --------------------------------------------------------------------
  grn_v2_needs_qc: { kind: 'VALIDATION', message: 'A goods receipt must be linked to both a gate inward and a completed QC inspection.' },
  grn_flag_reason: { kind: 'VALIDATION', field: 'flag_reason', message: 'Flagging a goods receipt requires a reason.' },
  grn_reject_reason: { kind: 'VALIDATION', field: 'rejection_reason', message: 'Rejecting a goods receipt requires a reason.' },
  grn_lines_concession: { kind: 'VALIDATION', field: 'qty_concession', message: 'The concession quantity cannot exceed the accepted quantity.' },
  grns_gate_inward_id_key: { kind: 'CONFLICT', message: 'A goods receipt already exists for this delivery.' },
  grns_qc_id_key: { kind: 'CONFLICT', message: 'A goods receipt already exists for this inspection.' },

  // --- Stock ------------------------------------------------------------------
  stock_balances_qty_check: { kind: 'CONFLICT', message: 'There is not enough stock to complete this movement. Refresh the page — the balance may have changed since you opened it.' },
  stock_ledger_qty_check: { kind: 'VALIDATION', field: 'qty', message: 'A stock movement quantity must be greater than zero.' },
  stock_ledger_idempotency_key_key: { kind: 'CONFLICT', message: 'This stock movement has already been posted.' },
  sl_has_direction: { kind: 'INTERNAL', message: 'A stock movement must take stock from somewhere or put it somewhere.' },
  sl_bucket_change: { kind: 'INTERNAL', message: 'A stock movement must change the stock bucket.' },
  stock_ledger_entry_no_key: { kind: 'CONFLICT', message: 'That stock ledger entry number is already in use. Please retry.' },

  // --- Damage -----------------------------------------------------------------
  dmg_warranty_claim: { kind: 'VALIDATION', field: 'decision', message: 'A warranty claim can only be raised while the item is still in warranty.' },
  dmg_insurance_ref: { kind: 'VALIDATION', field: 'insurance_claim_ref', message: 'A write-off above ₹50,000 requires an insurance claim reference.' },
  damage_reports_observed_on_check: { kind: 'VALIDATION', field: 'observed_on', message: 'The observed date cannot be in the future.' },

  // --- Purchase return --------------------------------------------------------
  rtv_one_source: { kind: 'VALIDATION', message: 'A purchase return must come from exactly one source — a QC rejection, a warehouse damage case, or a shortfall.' },
  rtv_self_approval: { kind: 'FORBIDDEN', message: 'You raised this purchase return, so you cannot approve it.' },
  rtv_approved_docs: { kind: 'INTERNAL', message: 'A purchase return must have a return note and a gate pass before it leaves draft.' },
  purchase_returns_prn_no_key: { kind: 'CONFLICT', message: 'That return note number is already in use. Please retry.' },
  purchase_returns_gate_pass_no_key: { kind: 'CONFLICT', message: 'That gate pass number is already in use. Please retry.' },

  // --- Accounts ---------------------------------------------------------------
  vi_tax_mode: { kind: 'VALIDATION', field: 'igst', message: 'An invoice carries either IGST, or CGST and SGST — never both.' },
  vendor_invoices_no_uq: { kind: 'CONFLICT', field: 'invoice_no', message: 'That invoice number has already been recorded for this vendor.' },
  dn_one_source: { kind: 'VALIDATION', message: 'A debit note must come from exactly one source — either a purchase return or a shortfall.' },
  dn_tax_mode: { kind: 'VALIDATION', field: 'igst', message: 'A debit note carries either IGST, or CGST and SGST — never both.' },
  dn_reconciled_needs_tally: { kind: 'VALIDATION', field: 'tally_voucher_ref', message: 'A debit note cannot be reconciled until its Tally voucher reference is recorded.' },
  debit_notes_rtv_id_key: { kind: 'CONFLICT', message: 'A debit note already exists for this purchase return.' },
  debit_notes_shortfall_id_key: { kind: 'CONFLICT', message: 'A debit note already exists for this shortfall case.' },
  debit_notes_taxable_value_check: { kind: 'VALIDATION', field: 'taxable_value', message: 'The taxable value must be greater than zero.' },
  vendor_credit_notes_uq: { kind: 'CONFLICT', field: 'cn_no', message: 'That credit note number has already been recorded for this vendor.' },
  recon_zero_to_close: { kind: 'VALIDATION', message: 'A reconciliation cannot be closed while the portal and Tally balances differ. Resolve the open items first.' },
  vendor_recon_runs_vendor_id_period_start_period_end_key: { kind: 'CONFLICT', message: 'A reconciliation already exists for this vendor and period.' },

  // --- Documents --------------------------------------------------------------
  documents_size_bytes_check: { kind: 'VALIDATION', field: 'file', message: 'Files must be 10 MB or smaller.' },
};

/** Append-only tables. Their trigger raises a bare message; map it to something useful. */
const APPEND_ONLY_MESSAGES: Record<string, string> = {
  stock_ledger: 'The stock ledger cannot be edited. To correct a movement, post a reversing entry against it.',
  audit_log: 'The audit trail cannot be edited or deleted.',
};

interface PgError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  table_name?: string;
  table?: string;
  column_name?: string;
  detail?: string;
  message?: string;
}

function asPgError(e: unknown): PgError | null {
  if (!e || typeof e !== 'object') return null;
  const pg = e as PgError;
  return typeof pg.code === 'string' ? pg : null;
}

/**
 * Convert anything thrown by a service or the database into an AppError.
 * Already-mapped AppErrors pass through untouched.
 */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;

  const pg = asPgError(e);
  if (!pg) {
    console.error('[error] unhandled non-database error:', e);
    return new AppError('INTERNAL', 'Something went wrong. The problem has been logged.', { cause: e });
  }

  const constraint = pg.constraint_name ?? pg.constraint;
  const table = pg.table_name ?? pg.table;

  // Named constraint we understand.
  if (constraint) {
    const mapped = CONSTRAINT_MESSAGES[constraint];
    if (mapped) {
      return new AppError(mapped.kind, mapped.message, { field: mapped.field, cause: e });
    }
    console.error(`[error] unmapped constraint "${constraint}" on table "${table ?? '?'}" — add it to lib/errors.ts`, pg.detail);
  }

  switch (pg.code) {
    case '23505': // unique_violation
      return new AppError('CONFLICT', 'That record already exists.', { cause: e });

    case '23503': // foreign_key_violation
      return new AppError('VALIDATION', 'Something this record depends on is missing or has been removed. Refresh the page and try again.', { cause: e });

    case '23514': // check_violation
      return new AppError('VALIDATION', 'That change breaks a business rule for this record.', { cause: e });

    case '23502': // not_null_violation
      return new AppError('VALIDATION', `${humanColumn(pg.column_name)} is required.`, { field: pg.column_name, cause: e });

    case '22003': // numeric_value_out_of_range
      return new AppError('VALIDATION', 'That number is too large for this field.', { cause: e });

    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new AppError('CONFLICT', 'Someone else changed this record at the same time. Please try again.', { cause: e });

    case 'P0001': {
      // RAISE EXCEPTION from a PL/pgSQL function.
      const msg = pg.message ?? '';

      const appendOnly = Object.keys(APPEND_ONLY_MESSAGES).find(t => msg.includes(`${t} is append-only`));
      if (appendOnly) return new AppError('FORBIDDEN', APPEND_ONLY_MESSAGES[appendOnly], { cause: e });

      if (msg.includes('Site allocation must total 100')) {
        return new AppError('VALIDATION', 'The site allocation must total exactly 100%.', { field: 'allocations', cause: e });
      }
      if (msg.includes('PR quantity') && msg.includes('must equal MR purchase balance')) {
        return new AppError('VALIDATION', 'The purchase request quantity must match the purchase balance left on the material request.', { field: 'qty', cause: e });
      }
      if (msg.includes('is locked after approval')) {
        return new AppError('FORBIDDEN', 'This purchase request was approved and can no longer be edited.', { cause: e });
      }
      if (msg.includes('only approved vendors can be ordered from')) {
        return new AppError('VALIDATION', 'This purchase order cannot be created because the selected vendor is not approved.', { field: 'vendor_id', cause: e });
      }
      if (msg.includes('Inspector cannot be the user who logged the gate inward')) {
        return new AppError('FORBIDDEN', 'You logged this delivery at the gate, so you cannot inspect it. Segregation of duties requires a different inspector.', { cause: e });
      }
      if (msg.includes('GRN approver must differ from the receiver and the inspector')) {
        return new AppError('FORBIDDEN', 'You received or inspected this delivery, so you cannot approve its goods receipt. Segregation of duties requires a third person.', { cause: e });
      }
      if (msg.includes('Site code') && msg.includes('cannot change once transactions exist')) {
        return new AppError('FORBIDDEN', 'This site code cannot be changed because transactions have already been recorded against it.', { field: 'code', cause: e });
      }
      if (msg.startsWith('No ') && msg.includes(' stock for item ')) {
        return new AppError('CONFLICT', 'There is not enough stock in that state to complete this movement.', { cause: e });
      }

      console.error('[error] unmapped RAISE from database:', msg);
      return new AppError('VALIDATION', 'That action breaks a business rule.', { cause: e });
    }

    default:
      console.error(`[error] unhandled SQLSTATE ${pg.code}:`, pg.message, pg.detail);
      return new AppError('INTERNAL', 'Something went wrong. The problem has been logged.', { cause: e });
  }
}

function humanColumn(col: string | undefined): string {
  if (!col) return 'A required field';
  return col
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}
