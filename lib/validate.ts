/**
 * Field validation — the CHECK constraints, in code.
 *
 * PostgreSQL rejected a malformed PAN outright. With Sheets as the store there
 * is nothing behind the service layer, so every regex the schema declared lives
 * here and is applied on the way in.
 *
 * Two rules shape this module:
 *
 *   1. NORMALISE BEFORE VALIDATING (conflict register C-03). The schema's
 *      patterns accept only upper-case, unspaced values — `vendors_pan_uq`
 *      indexes `upper(btrim(pan))`, but `vendors_pan_format` would have
 *      rejected a lower-case PAN before it ever reached that index. So a user
 *      typing "aabcu 9603r" should get a saved vendor, not a format error.
 *      The prototype's own gate-inward field ships "WB 11 C 4821", which the
 *      schema's vehicle pattern rejects; normalising is what makes both work.
 *
 *   2. Say what is wrong and what good looks like. "Invalid GSTIN" tells a
 *      storekeeper nothing.
 */
import { AppError } from '@/lib/errors';

// --- Normalisation ----------------------------------------------------------------

/**
 * Upper-case, strip every space AND hyphen.
 *
 * For values where a separator is decoration a human added: PAN, GSTIN, IFSC,
 * vehicle registrations, account numbers. "aabcu 9603r" and "AABCU-9603-R" are
 * both the PAN AABCU9603R.
 *
 * NOT for business codes — see `normaliseIdentifier`.
 */
export function normaliseCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Upper-case and strip whitespace, but KEEP hyphens.
 *
 * For codes a human chose, where the hyphen carries meaning: item codes like
 * `CC-EVP-220` and `PL-HDPE-12`, budget codes, site codes. The prototype uses
 * hyphenated item codes throughout.
 *
 * Splitting this out fixed a real bug: `validateCode` used `normaliseCode`, so
 * entering `PL-HDPE-12` silently stored `PLHDPE12`. Rewriting an identifier
 * without saying so is the same class of mistake as silently adjusting a
 * quantity (brief §35) — the user goes looking for a code that no longer
 * exists.
 */
export function normaliseIdentifier(value: string): string {
  return value.toUpperCase().replace(/\s/g, '');
}

/** Collapse runs of whitespace and trim. For names and addresses. */
export function normaliseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// --- Patterns, straight from the schema ----------------------------------------------

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const VEHICLE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/;

/**
 * GST state codes in use. The schema constrains `state_code` to char(2) and
 * requires the GSTIN to start with it, but never says which codes exist —
 * so "99" would have passed in PostgreSQL. It does not here.
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

export function stateName(code: string): string {
  return GST_STATE_CODES[code] ?? code;
}

// --- Validators ------------------------------------------------------------------------
// Each returns the NORMALISED value, so callers store what was validated.

export function validatePan(raw: string, field = 'pan'): string {
  const pan = normaliseCode(raw ?? '');
  if (!pan) throw new AppError('VALIDATION', 'PAN is required.', { field });
  if (!PAN_RE.test(pan)) {
    throw new AppError(
      'VALIDATION',
      'That PAN is not valid. It is ten characters: five letters, four digits, then one letter — for example ABCDE1234F.',
      { field },
    );
  }
  return pan;
}

export function validateGstin(raw: string, field = 'gstin'): string {
  const gstin = normaliseCode(raw ?? '');
  if (!gstin) throw new AppError('VALIDATION', 'GSTIN is required.', { field });
  if (gstin.length !== 15) {
    throw new AppError('VALIDATION', `A GSTIN is 15 characters; that one is ${gstin.length}.`, { field });
  }
  if (!GSTIN_RE.test(gstin)) {
    throw new AppError(
      'VALIDATION',
      'That GSTIN is not valid. It is two state digits, a ten-character PAN, then three more characters.',
      { field },
    );
  }
  const state = gstin.slice(0, 2);
  if (!GST_STATE_CODES[state]) {
    throw new AppError('VALIDATION', `"${state}" is not a GST state code.`, { field });
  }
  return gstin;
}

/** `sites_gstin_state`: the first two digits of a GSTIN are its state code. */
export function assertGstinMatchesState(gstin: string, stateCode: string, field = 'gstin') {
  const gstinState = gstin.slice(0, 2);
  if (gstinState !== stateCode) {
    throw new AppError(
      'VALIDATION',
      `This GSTIN belongs to ${stateName(gstinState)} (${gstinState}), but the state selected is ${stateName(stateCode)} (${stateCode}).`,
      { field },
    );
  }
}

/** `vendors_gstin_pan`: characters 3 to 12 of a GSTIN are the PAN. */
export function assertGstinMatchesPan(gstin: string, pan: string, field = 'gstin') {
  const embedded = gstin.slice(2, 12);
  if (embedded !== pan) {
    throw new AppError(
      'VALIDATION',
      `This GSTIN contains the PAN ${embedded}, which does not match the PAN entered (${pan}). One of the two is wrong.`,
      { field },
    );
  }
}

export function validateStateCode(raw: string, field = 'state_code'): string {
  const code = normaliseCode(raw ?? '');
  if (!GST_STATE_CODES[code]) {
    throw new AppError('VALIDATION', `"${raw}" is not a GST state code. Use a two-digit code such as 19 for West Bengal.`, { field });
  }
  return code;
}

export function validateIfsc(raw: string, field = 'ifsc'): string {
  const ifsc = normaliseCode(raw ?? '');
  if (!ifsc) throw new AppError('VALIDATION', 'IFSC is required.', { field });
  if (!IFSC_RE.test(ifsc)) {
    throw new AppError(
      'VALIDATION',
      'That IFSC is not valid. It is eleven characters: four letters, a zero, then six more — for example HDFC0001234.',
      { field },
    );
  }
  return ifsc;
}

/**
 * Vehicle registration (conflict register C-03).
 *
 * Stored unspaced because the schema's pattern demands it; displayed spaced
 * because that is how everyone writes it. `formatVehicleNo` is the inverse.
 */
export function validateVehicleNo(raw: string, field = 'vehicle_no'): string {
  const vehicle = normaliseCode(raw ?? '');
  if (!vehicle) throw new AppError('VALIDATION', 'Vehicle number is required.', { field });
  if (!VEHICLE_RE.test(vehicle)) {
    throw new AppError(
      'VALIDATION',
      'That vehicle number is not valid. Enter the registration as it appears on the plate — for example WB 11 C 4821.',
      { field },
    );
  }
  return vehicle;
}

/** "WB11C4821" -> "WB 11 C 4821" */
export function formatVehicleNo(stored: string | null | undefined): string {
  if (!stored) return '—';
  const m = /^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{1,4})$/.exec(stored);
  if (!m) return stored;
  return [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ');
}

export function validateBankAccountNumber(raw: string, field = 'account_number'): string {
  const account = (raw ?? '').replace(/[\s-]/g, '');
  if (!account) throw new AppError('VALIDATION', 'Account number is required.', { field });
  if (!/^[0-9]{6,20}$/.test(account)) {
    throw new AppError('VALIDATION', 'An account number is 6 to 20 digits.', { field });
  }
  return account;
}

export function validateEmail(raw: string, field = 'email'): string {
  const email = (raw ?? '').trim().toLowerCase();
  if (!email) throw new AppError('VALIDATION', 'Email is required.', { field });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('VALIDATION', 'That email address is not valid.', { field });
  }
  return email;
}

export function validatePhone(raw: string, field = 'contact_phone'): string {
  const phone = (raw ?? '').replace(/[\s-()]/g, '');
  if (!phone) throw new AppError('VALIDATION', 'Phone number is required.', { field });
  if (!/^(\+91)?[6-9][0-9]{9}$/.test(phone)) {
    throw new AppError('VALIDATION', 'That phone number is not valid. Enter a ten-digit Indian mobile number.', { field });
  }
  return phone;
}

/** Financial year, e.g. FY26-27. */
export function validateFinancialYear(raw: string, field = 'financial_year'): string {
  const fy = normaliseCode(raw ?? '');
  const m = /^FY([0-9]{2})([0-9]{2})$/.exec(fy);
  if (!m) {
    throw new AppError('VALIDATION', 'Enter the financial year as FY26-27.', { field });
  }
  const [, start, end] = m;
  if ((Number(start) + 1) % 100 !== Number(end)) {
    throw new AppError('VALIDATION', `FY${start}-${end} is not a consecutive pair of years.`, { field });
  }
  return `FY${start}-${end}`;
}

/**
 * A business code: site codes, item codes, class codes, budget codes.
 *
 * Hyphens are preserved, because they are part of the code — `CC-EVP-220` is
 * not `CCEVP220`. Only whitespace is removed, and the value is upper-cased.
 */
export function validateCode(raw: string, field: string, opts: { min?: number; max?: number } = {}): string {
  const code = normaliseIdentifier(raw ?? '');
  const min = opts.min ?? 2;
  const max = opts.max ?? 24;

  if (!code) throw new AppError('VALIDATION', `${humanise(field)} is required.`, { field });
  if (code.length < min || code.length > max) {
    throw new AppError('VALIDATION', `${humanise(field)} must be between ${min} and ${max} characters.`, { field });
  }
  if (!/^[A-Z0-9][A-Z0-9_/-]*$/.test(code)) {
    throw new AppError(
      'VALIDATION',
      `${humanise(field)} may contain only letters, digits, hyphens, underscores and slashes, and must start with a letter or digit.`,
      { field },
    );
  }
  return code;
}

/** Temperature band on a cold-chain item class (`item_classes_temp`). */
export function assertTemperatureBand(isColdChain: boolean, minC: string | null, maxC: string | null) {
  if (!isColdChain) return;
  if (minC === null || maxC === null) {
    throw new AppError('VALIDATION', 'A cold-chain item class needs both a minimum and a maximum temperature.', {
      field: 'temp_min_c',
    });
  }
  if (Number(minC) >= Number(maxC)) {
    throw new AppError('VALIDATION', 'The minimum temperature must be below the maximum.', { field: 'temp_min_c' });
  }
}

function humanise(field: string): string {
  return field.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
