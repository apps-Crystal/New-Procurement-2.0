/**
 * Vendor master — lifecycle, KYC, categories, sites, and bank maker-checker.
 *
 * Nearly every rule here is back where it belongs, in the schema:
 *
 *   vendors_pan_format / gstin_format    CHECK
 *   vendors_gstin_pan                    CHECK — GSTIN chars 3–12 are the PAN
 *   vendors_pan_uq / gstin_uq            UNIQUE INDEX on upper(btrim(...))
 *   vendors_approved_needs_ledger        CHECK
 *   vendors_blocked_reason               CHECK
 *   vba_maker_checker                    CHECK — approver <> proposer
 *   vba_one_live                         partial UNIQUE INDEX
 *   check_po_vendor()                    trigger on purchase_orders
 *
 * So this module normalises, authorises, audits, and lets the database refuse.
 * lib/errors.ts turns each constraint name into a sentence naming the vendor.
 *
 * One note on de-duplication: the unique index is on `upper(btrim(pan))`, but
 * `vendors_pan_format` rejects anything not already upper-case and unspaced, so
 * the normalisation in the index is unreachable from raw input. Normalising
 * here first is what makes that index's intent work — "aabcu 9603r" is caught
 * as a duplicate rather than thrown out as a format error.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { encryptSecret, last4 } from '@/lib/crypto';
import {
  assertGstinMatchesPan,
  normaliseText,
  validateBankAccountNumber,
  validateCode,
  validateEmail,
  validateGstin,
  validateIfsc,
  validatePan,
  validatePhone,
  validateStateCode,
} from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';

function normaliseVendor(input: VendorInput) {
  const pan = validatePan(input.pan);
  const stateCode = validateStateCode(input.stateCode);

  // GSTIN is optional — an unregistered vendor has none — but where present it
  // must agree with both the PAN and the state.
  let gstin: string | null = null;
  if (input.gstin?.trim()) {
    gstin = validateGstin(input.gstin);
    assertGstinMatchesPan(gstin, pan);
    if (gstin.slice(0, 2) !== stateCode) {
      throw badRequest(
        `This GSTIN is registered in state ${gstin.slice(0, 2)}, but the vendor's state is ${stateCode}.`,
        'gstin',
      );
    }
  }

  return {
    legal_name: normaliseText(input.legalName),
    vendor_type: input.vendorType ?? 'COMPANY',
    pan,
    gstin,
    state_code: stateCode,
    address: normaliseText(input.address),
    contact_name: input.contactName?.trim() || null,
    contact_email: input.contactEmail?.trim() ? validateEmail(input.contactEmail) : null,
    contact_phone: input.contactPhone?.trim() ? validatePhone(input.contactPhone) : null,
    msme_number: input.msmeNumber?.trim() || null,
    tally_ledger_ref: input.tallyLedgerRef?.trim() || null,
  };
}

export interface VendorInput {
  vendorCode?: string;
  legalName: string;
  vendorType?: string;
  pan: string;
  gstin?: string | null;
  stateCode: string;
  address: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  msmeNumber?: string | null;
  tallyLedgerRef?: string | null;
}

/**
 * Next code in the V-0001 series.
 *
 * Read inside the caller's transaction and guarded by `vendors_vendor_code_key`
 * — a concurrent creator racing to the same number hits the unique index and
 * gets a retryable conflict rather than a duplicate.
 */
async function nextVendorCode(tx: Tx): Promise<string> {
  const [row] = await tx<{ next: string }[]>`
    SELECT coalesce(max(substring(vendor_code from '^V-(\\d+)$')::int), 0) + 1 AS next
      FROM vendors WHERE vendor_code ~ '^V-\\d+$'`;
  return `V-${String(row.next).padStart(4, '0')}`;
}

// =============================================================================
// Create and edit
// =============================================================================

export async function createVendor(actor: Actor, input: VendorInput): Promise<Row> {
  if (!can(actor.principal, 'VENDOR.CREATE', null)) {
    throw forbidden('You do not have permission to add vendors.');
  }
  const v = normaliseVendor(input);

  return inTransaction(async tx => {
    // The unique indexes would catch this, but naming the existing vendor is
    // far more useful than "that record already exists".
    await assertNoDuplicate(tx, v.pan, v.gstin, null);

    const vendorCode = input.vendorCode ? validateCode(input.vendorCode, 'vendor_code') : await nextVendorCode(tx);

    const [vendor] = await tx<Row[]>`
      INSERT INTO vendors (vendor_code, legal_name, vendor_type, pan, gstin, state_code, address,
                           contact_name, contact_email, contact_phone, msme_number, tally_ledger_ref,
                           status, created_by)
      VALUES (${vendorCode}, ${v.legal_name}, ${v.vendor_type}, ${v.pan}, ${v.gstin}, ${v.state_code},
              ${v.address}, ${v.contact_name}, ${v.contact_email}, ${v.contact_phone}, ${v.msme_number},
              ${v.tally_ledger_ref}, 'VENDOR_DRAFT', ${actor.principal.userId})
      RETURNING *`;

    await audit(tx, {
      entityType: 'VENDOR', entityId: Number(vendor.id), action: 'CREATE',
      after: v, userId: actor.principal.userId, ip: actor.ip,
    });

    return vendor;
  });
}

async function assertNoDuplicate(tx: Tx, pan: string, gstin: string | null, excludeId: number | null) {
  const [samePan] = await tx<Row[]>`
    SELECT id, vendor_code, legal_name FROM vendors
     WHERE upper(btrim(pan)) = ${pan} AND (${excludeId}::bigint IS NULL OR id <> ${excludeId})`;

  if (samePan) {
    throw conflict(
      `${samePan.legal_name} (${samePan.vendor_code}) already uses PAN ${pan}. Open that vendor instead of creating a duplicate.`,
    );
  }

  if (gstin) {
    const [sameGstin] = await tx<Row[]>`
      SELECT id, vendor_code, legal_name FROM vendors
       WHERE upper(btrim(gstin)) = ${gstin} AND (${excludeId}::bigint IS NULL OR id <> ${excludeId})`;

    if (sameGstin) {
      throw conflict(
        `${sameGstin.legal_name} (${sameGstin.vendor_code}) already uses GSTIN ${gstin}. Open that vendor instead of creating a duplicate.`,
      );
    }
  }
}

export async function updateVendor(actor: Actor, id: number, input: Partial<VendorInput>): Promise<Row> {
  if (!can(actor.principal, 'VENDOR.EDIT', null)) {
    throw forbidden('You do not have permission to edit vendors.');
  }

  return inTransaction(async tx => {
    const [current] = await tx<Row[]>`SELECT * FROM vendors WHERE id = ${id} FOR UPDATE`;
    if (!current) throw notFound('That vendor no longer exists.');

    const v = normaliseVendor({
      legalName: input.legalName ?? String(current.legal_name),
      vendorType: input.vendorType ?? String(current.vendor_type),
      pan: input.pan ?? String(current.pan),
      gstin: input.gstin !== undefined ? input.gstin : (current.gstin as string | null),
      stateCode: input.stateCode ?? String(current.state_code),
      address: input.address ?? String(current.address),
      contactName: input.contactName ?? (current.contact_name as string | null),
      contactEmail: input.contactEmail ?? (current.contact_email as string | null),
      contactPhone: input.contactPhone ?? (current.contact_phone as string | null),
      msmeNumber: input.msmeNumber ?? (current.msme_number as string | null),
      tallyLedgerRef: input.tallyLedgerRef ?? (current.tally_ledger_ref as string | null),
    });

    // An approved vendor's identity is referenced by live purchase orders, so
    // KYC fields freeze. Contact details stay editable. Nothing in the schema
    // enforces this, so it lives here.
    const identityChanging =
      v.pan !== current.pan || v.gstin !== current.gstin || v.state_code !== current.state_code;

    if (identityChanging && current.status === 'VENDOR_APPROVED') {
      throw conflict(
        'PAN, GSTIN and state cannot be changed on an approved vendor. Block this vendor and create a new record if their registration has changed.',
      );
    }

    await assertNoDuplicate(tx, v.pan, v.gstin, id);

    const [vendor] = await tx<Row[]>`
      UPDATE vendors SET
        legal_name = ${v.legal_name}, vendor_type = ${v.vendor_type}, pan = ${v.pan}, gstin = ${v.gstin},
        state_code = ${v.state_code}, address = ${v.address}, contact_name = ${v.contact_name},
        contact_email = ${v.contact_email}, contact_phone = ${v.contact_phone},
        msme_number = ${v.msme_number}, tally_ledger_ref = ${v.tally_ledger_ref}
      WHERE id = ${id}
      RETURNING *`;

    await audit(tx, {
      entityType: 'VENDOR', entityId: id, action: 'UPDATE',
      before: current, after: v, userId: actor.principal.userId, ip: actor.ip,
    });

    return vendor;
  });
}

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * Every status change goes through the declared transition table, so the arrow
 * must exist and the caller must hold its permission.
 *
 * Vendors are group-wide, so the site is null: holding VENDOR.APPROVE anywhere
 * is enough. A vendor is not "at" a site, and requiring the permission at one
 * would mean a Functional Head could approve a vendor only if they happened to
 * hold a role at whichever site the record was imagined to belong to.
 */
async function transitionVendor(
  actor: Actor,
  id: number,
  to: string,
  patch: Record<string, unknown>,
  remarks?: string,
): Promise<Row> {
  return inTransaction(async tx => {
    const [current] = await tx<Row[]>`SELECT * FROM vendors WHERE id = ${id} FOR UPDATE`;
    if (!current) throw notFound('That vendor no longer exists.');

    const from = String(current.status);
    await assertTransition({ entityType: 'VENDOR', from, to, principal: actor.principal, siteId: null }, tx);

    const [vendor] = await tx<Row[]>`
      UPDATE vendors SET
        status            = ${to}::vendor_status,
        tally_ledger_ref  = ${(patch.tally_ledger_ref as string) ?? (current.tally_ledger_ref as string | null)},
        approved_by       = ${(patch.approved_by as number) ?? (current.approved_by as number | null)},
        approved_at       = ${(patch.approved_at as string) ?? (current.approved_at as string | null)},
        blocked_reason    = ${'blocked_reason' in patch ? (patch.blocked_reason as string | null) : (current.blocked_reason as string | null)},
        blocked_from      = ${'blocked_from' in patch ? (patch.blocked_from as string | null) : (current.blocked_from as string | null)}
      WHERE id = ${id}
      RETURNING *`;

    await audit(tx, {
      entityType: 'VENDOR', entityId: id, action: 'TRANSITION',
      fromStatus: from, toStatus: to, before: current, after: patch,
      userId: actor.principal.userId, ip: actor.ip, remarks,
    });

    return vendor;
  });
}

export const submitVendor = (actor: Actor, id: number) => transitionVendor(actor, id, 'VENDOR_PENDING', {});

export async function approveVendor(actor: Actor, id: number, tallyLedgerRef?: string): Promise<Row> {
  const [current] = await sql<Row[]>`SELECT * FROM vendors WHERE id = ${id}`;
  if (!current) throw notFound('That vendor no longer exists.');

  // `vendors_approved_needs_ledger` would catch this, but the CHECK cannot say
  // which field is missing.
  const ledgerRef = tallyLedgerRef?.trim() || (current.tally_ledger_ref as string | null);
  if (!ledgerRef) {
    throw badRequest('This vendor cannot be approved until their Tally ledger reference is recorded.', 'tally_ledger_ref');
  }

  // Segregation of duty. The schema has no CHECK for this on vendors, but the
  // same principle applies as everywhere else: whoever created the record does
  // not sign it off.
  if (Number(current.created_by) === actor.principal.userId) {
    throw forbidden('You created this vendor, so you cannot approve it. Someone else must check it.');
  }

  return transitionVendor(actor, id, 'VENDOR_APPROVED', {
    tally_ledger_ref: ledgerRef,
    approved_by: actor.principal.userId,
    approved_at: new Date().toISOString(),
  });
}

export async function blockVendor(actor: Actor, id: number, reason: string): Promise<Row> {
  const text = normaliseText(reason ?? '');
  if (!text) throw badRequest('Blocking a vendor requires a reason.', 'blocked_reason');

  return transitionVendor(
    actor, id, 'VENDOR_BLOCKED',
    { blocked_reason: text, blocked_from: new Date().toISOString().slice(0, 10) },
    text,
  );
}

export const unblockVendor = (actor: Actor, id: number) =>
  transitionVendor(actor, id, 'VENDOR_APPROVED', { blocked_reason: null, blocked_from: null });

export const deactivateVendor = (actor: Actor, id: number) => transitionVendor(actor, id, 'VENDOR_INACTIVE', {});

/**
 * `check_po_vendor()` refuses an unapproved vendor on a purchase order, but it
 * raises a message built for a developer. This is the same check, ahead of the
 * insert, phrased for a buyer.
 */
export async function assertVendorOrderable(vendorId: number): Promise<Row> {
  const [vendor] = await sql<Row[]>`SELECT * FROM vendors WHERE id = ${vendorId}`;
  if (!vendor) throw notFound('That vendor no longer exists.');

  if (vendor.status !== 'VENDOR_APPROVED') {
    const reason =
      vendor.status === 'VENDOR_BLOCKED'
        ? `blocked${vendor.blocked_reason ? ` — ${vendor.blocked_reason}` : ''}`
        : String(vendor.status).replace('VENDOR_', '').toLowerCase();
    throw badRequest(
      `This purchase order cannot be created because ${vendor.legal_name} is ${reason}, not approved.`,
      'vendor_id',
    );
  }
  return vendor;
}

// =============================================================================
// Bank accounts — maker-checker
// =============================================================================

export interface BankInput {
  vendorId: number;
  accountNumber: string;
  ifsc: string;
  beneficiaryName: string;
}

/**
 * Propose bank details. Stored PENDING; a different person must approve.
 * The account number is encrypted; only the last four digits stay readable.
 */
export async function proposeBankAccount(actor: Actor, input: BankInput): Promise<Row> {
  if (!can(actor.principal, 'VENDOR.BANK_PROPOSE', null)) {
    throw forbidden('You do not have permission to propose bank details.');
  }

  const accountNumber = validateBankAccountNumber(input.accountNumber);
  const ifsc = validateIfsc(input.ifsc);
  const beneficiary = normaliseText(input.beneficiaryName);
  if (!beneficiary) throw badRequest('Beneficiary name is required.', 'beneficiary_name');

  return inTransaction(async tx => {
    const [vendor] = await tx<Row[]>`SELECT id FROM vendors WHERE id = ${input.vendorId} FOR UPDATE`;
    if (!vendor) throw notFound('That vendor no longer exists.');

    const [pending] = await tx<Row[]>`
      SELECT id FROM vendor_bank_accounts WHERE vendor_id = ${input.vendorId} AND state = 'PENDING'`;
    if (pending) {
      throw conflict(
        'There is already a bank change waiting for approval on this vendor. It must be approved or rejected first.',
      );
    }

    const [account] = await tx<Row[]>`
      INSERT INTO vendor_bank_accounts (vendor_id, account_number_enc, account_last4, ifsc,
                                        beneficiary_name, state, proposed_by)
      VALUES (${input.vendorId}, ${Buffer.from(encryptSecret(accountNumber), 'utf8')},
              ${last4(accountNumber)}, ${ifsc}, ${beneficiary}, 'PENDING', ${actor.principal.userId})
      RETURNING *`;

    await audit(tx, {
      entityType: 'VENDOR_BANK', entityId: Number(account.id), action: 'CREATE',
      // Never the account number, not even encrypted — see lib/audit.ts.
      after: { vendor_id: input.vendorId, account_last4: last4(accountNumber), ifsc, beneficiary_name: beneficiary },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Bank details proposed, awaiting a second approver',
    });

    return stripCiphertext(account);
  });
}

/**
 * Approve proposed bank details.
 *
 * `vba_maker_checker` (approver <> proposer) and `vba_one_live` (one APPROVED
 * row per vendor) are both database constraints now. The live account is
 * retired in the same transaction, so the partial unique index is never
 * momentarily violated.
 */
export async function approveBankAccount(actor: Actor, bankAccountId: number): Promise<Row> {
  if (!can(actor.principal, 'VENDOR.BANK_APPROVE', null)) {
    throw forbidden('You do not have permission to approve bank details.');
  }

  return inTransaction(async tx => {
    const [account] = await tx<Row[]>`
      SELECT * FROM vendor_bank_accounts WHERE id = ${bankAccountId} FOR UPDATE`;
    if (!account) throw notFound('Those bank details no longer exist.');

    if (account.state !== 'PENDING') {
      throw conflict(`These bank details are already ${String(account.state).toLowerCase()}.`);
    }
    if (Number(account.proposed_by) === actor.principal.userId) {
      throw forbidden(
        'You proposed these bank details, so you cannot approve them. Someone else in Accounts or Finance must check them.',
      );
    }

    await tx`
      UPDATE vendor_bank_accounts SET state = 'REJECTED'
       WHERE vendor_id = ${account.vendor_id as number} AND state = 'APPROVED'`;

    const [approved] = await tx<Row[]>`
      UPDATE vendor_bank_accounts
         SET state = 'APPROVED', approved_by = ${actor.principal.userId}, approved_at = now()
       WHERE id = ${bankAccountId}
      RETURNING *`;

    await audit(tx, {
      entityType: 'VENDOR_BANK', entityId: bankAccountId, action: 'TRANSITION',
      fromStatus: 'PENDING', toStatus: 'APPROVED',
      after: { account_last4: account.account_last4, ifsc: account.ifsc },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Approved by a different user from the proposer (${account.proposed_by})`,
    });

    return stripCiphertext(approved);
  });
}

export async function rejectBankAccount(actor: Actor, bankAccountId: number, reason: string): Promise<Row> {
  if (!can(actor.principal, 'VENDOR.BANK_APPROVE', null)) {
    throw forbidden('You do not have permission to approve bank details.');
  }

  return inTransaction(async tx => {
    const [account] = await tx<Row[]>`
      SELECT * FROM vendor_bank_accounts WHERE id = ${bankAccountId} FOR UPDATE`;
    if (!account) throw notFound('Those bank details no longer exist.');

    if (account.state !== 'PENDING') {
      throw conflict(`These bank details are already ${String(account.state).toLowerCase()}.`);
    }
    if (Number(account.proposed_by) === actor.principal.userId) {
      throw forbidden('You proposed these bank details, so someone else must decide on them.');
    }

    const [rejected] = await tx<Row[]>`
      UPDATE vendor_bank_accounts
         SET state = 'REJECTED', approved_by = ${actor.principal.userId}, approved_at = now()
       WHERE id = ${bankAccountId}
      RETURNING *`;

    await audit(tx, {
      entityType: 'VENDOR_BANK', entityId: bankAccountId, action: 'TRANSITION',
      fromStatus: 'PENDING', toStatus: 'REJECTED',
      userId: actor.principal.userId, ip: actor.ip, remarks: normaliseText(reason),
    });

    return stripCiphertext(rejected);
  });
}

/** The ciphertext never leaves this module. */
function stripCiphertext(row: Row): Row {
  const { account_number_enc: _omitted, ...rest } = row;
  return rest;
}

/** Bank accounts for a vendor. Account numbers are never returned. */
export async function listBankAccounts(actor: Actor, vendorId: number): Promise<Row[]> {
  if (!can(actor.principal, 'VENDOR.BANK_VIEW', null)) {
    throw forbidden('You do not have permission to view bank details.');
  }
  const rows = await sql<Row[]>`
    SELECT id, vendor_id, account_last4, ifsc, beneficiary_name, state,
           proposed_by, approved_by, approved_at, created_at
      FROM vendor_bank_accounts
     WHERE vendor_id = ${vendorId}
     ORDER BY created_at DESC`;
  return rows;
}

// =============================================================================
// Categories and sites
// =============================================================================

export async function setVendorCategories(actor: Actor, vendorId: number, itemClassIds: number[]): Promise<void> {
  if (!can(actor.principal, 'VENDOR.EDIT', null)) throw forbidden('You do not have permission to edit vendors.');

  await inTransaction(async tx => {
    const [vendor] = await tx<Row[]>`SELECT id FROM vendors WHERE id = ${vendorId}`;
    if (!vendor) throw notFound('That vendor no longer exists.');

    // Replace the set wholesale — simple, and atomic because it is one
    // transaction. A join table has no history worth preserving.
    await tx`DELETE FROM vendor_categories WHERE vendor_id = ${vendorId}`;
    if (itemClassIds.length > 0) {
      await tx`
        INSERT INTO vendor_categories ${tx(
          itemClassIds.map(item_class_id => ({ vendor_id: vendorId, item_class_id })),
          'vendor_id',
          'item_class_id',
        )}`;
    }

    await audit(tx, {
      entityType: 'VENDOR', entityId: vendorId, action: 'UPDATE',
      after: { categories: itemClassIds }, userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Vendor categories updated',
    });
  });
}

export async function setVendorSites(actor: Actor, vendorId: number, siteIds: number[]): Promise<void> {
  if (!can(actor.principal, 'VENDOR.EDIT', null)) throw forbidden('You do not have permission to edit vendors.');

  await inTransaction(async tx => {
    const [vendor] = await tx<Row[]>`SELECT id FROM vendors WHERE id = ${vendorId}`;
    if (!vendor) throw notFound('That vendor no longer exists.');

    await tx`DELETE FROM vendor_sites WHERE vendor_id = ${vendorId}`;
    if (siteIds.length > 0) {
      await tx`
        INSERT INTO vendor_sites ${tx(
          siteIds.map(site_id => ({ vendor_id: vendorId, site_id })),
          'vendor_id',
          'site_id',
        )}`;
    }

    await audit(tx, {
      entityType: 'VENDOR', entityId: vendorId, action: 'UPDATE',
      after: { sites: siteIds }, userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Vendor sites updated',
    });
  });
}

// =============================================================================
// Reads
// =============================================================================

export async function listVendors(filters: { status?: string; search?: string } = {}): Promise<Row[]> {
  const search = filters.search?.trim() ? `%${filters.search.trim().toUpperCase()}%` : null;

  return sql<Row[]>`
    SELECT * FROM vendors
     WHERE (${filters.status ?? null}::text IS NULL OR status = ${filters.status ?? null}::vendor_status)
       AND (${search}::text IS NULL
            OR upper(legal_name) LIKE ${search}
            OR upper(vendor_code) LIKE ${search}
            OR upper(pan) LIKE ${search}
            OR upper(coalesce(gstin, '')) LIKE ${search})
     ORDER BY legal_name`;
}

/**
 * Vendors that may appear on a purchase order for a site and item class:
 * approved, and matching the category and site where those are configured.
 * An unrestricted vendor (no categories, no sites) is available everywhere.
 */
export function orderableVendors(siteId: number, itemClassId?: number): Promise<Row[]> {
  return sql<Row[]>`
    SELECT v.* FROM vendors v
     WHERE v.status = 'VENDOR_APPROVED'
       AND (NOT EXISTS (SELECT 1 FROM vendor_sites vs WHERE vs.vendor_id = v.id)
            OR EXISTS (SELECT 1 FROM vendor_sites vs WHERE vs.vendor_id = v.id AND vs.site_id = ${siteId}))
       AND (${itemClassId ?? null}::bigint IS NULL
            OR NOT EXISTS (SELECT 1 FROM vendor_categories vc WHERE vc.vendor_id = v.id)
            OR EXISTS (SELECT 1 FROM vendor_categories vc
                        WHERE vc.vendor_id = v.id AND vc.item_class_id = ${itemClassId ?? null}))
     ORDER BY v.legal_name`;
}

export async function getVendor(id: number): Promise<Row> {
  const [vendor] = await sql<Row[]>`SELECT * FROM vendors WHERE id = ${id}`;
  if (!vendor) throw notFound('That vendor no longer exists.');
  return vendor;
}
