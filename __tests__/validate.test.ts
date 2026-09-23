/**
 * Field validation — the CHECK constraints, in code.
 *
 * These carry rules PostgreSQL used to enforce, so a gap here is a bad row in
 * the workbook with nothing behind it to object.
 */
import {
  assertGstinMatchesPan,
  assertGstinMatchesState,
  assertTemperatureBand,
  formatVehicleNo,
  normaliseCode,
  normaliseText,
  stateName,
  validateBankAccountNumber,
  validateCode,
  normaliseIdentifier,
  validateFinancialYear,
  validateGstin,
  validateIfsc,
  validatePan,
  validatePhone,
  validateStateCode,
  validateVehicleNo,
} from '@/lib/validate';
import { encryptSecret, decryptSecret, last4, maskAccount } from '@/lib/crypto';

describe('normalisation (conflict C-03)', () => {
  it('upper-cases and strips separators from codes', () => {
    expect(normaliseCode('  aabcu 9603r ')).toBe('AABCU9603R');
    expect(normaliseCode('wb-11-c-4821')).toBe('WB11C4821');
  });

  it('collapses whitespace in free text', () => {
    expect(normaliseText('  Northern   Polymers \n & Packaging ')).toBe('Northern Polymers & Packaging');
  });
});

describe('PAN', () => {
  it('accepts a valid PAN', () => {
    expect(validatePan('AABCU9603R')).toBe('AABCU9603R');
  });

  it('normalises before validating, so lower case and spaces are accepted', () => {
    // The schema's unique index normalised with upper(btrim(pan)), but its
    // format CHECK would have rejected the value first. Normalising here is
    // what makes that index's intent reachable.
    expect(validatePan('  aabcu 9603r  ')).toBe('AABCU9603R');
  });

  it('rejects a malformed PAN with a message that shows the shape', () => {
    expect(() => validatePan('ABCD1234E')).toThrow(/five letters, four digits, then one letter/);
    expect(() => validatePan('12345ABCDE')).toThrow(/not valid/);
    expect(() => validatePan('')).toThrow(/required/);
  });
});

describe('GSTIN', () => {
  it('accepts a valid GSTIN', () => {
    expect(validateGstin('19AABCU9603R1ZX')).toBe('19AABCU9603R1ZX');
  });

  it('reports the wrong length plainly', () => {
    expect(() => validateGstin('19AABCU9603R1')).toThrow(/15 characters; that one is 13/);
  });

  it('rejects an unknown state prefix', () => {
    expect(() => validateGstin('99AABCU9603R1ZX')).toThrow(/"99" is not a GST state code/);
  });

  it('checks the GSTIN against the state selected', () => {
    // sites_gstin_state
    expect(() => assertGstinMatchesState('19AABCU9603R1ZX', '27')).toThrow(
      /belongs to West Bengal \(19\), but the state selected is Maharashtra \(27\)/,
    );
    expect(() => assertGstinMatchesState('19AABCU9603R1ZX', '19')).not.toThrow();
  });

  it('checks the embedded PAN against the PAN entered', () => {
    // vendors_gstin_pan
    expect(() => assertGstinMatchesPan('19AABCU9603R1ZX', 'AAACU9603R')).toThrow(
      /contains the PAN AABCU9603R, which does not match the PAN entered \(AAACU9603R\)/,
    );
    expect(() => assertGstinMatchesPan('19AABCU9603R1ZX', 'AABCU9603R')).not.toThrow();
  });
});

describe('state codes', () => {
  it('names known states', () => {
    expect(stateName('19')).toBe('West Bengal');
    expect(stateName('27')).toBe('Maharashtra');
  });

  it('rejects a code that is not a GST state', () => {
    // The schema only constrained this to char(2), so "99" would have passed.
    expect(() => validateStateCode('99')).toThrow(/not a GST state code/);
    expect(validateStateCode('19')).toBe('19');
  });
});

describe('IFSC', () => {
  it('accepts a valid IFSC and rejects a malformed one', () => {
    expect(validateIfsc('hdfc0001234')).toBe('HDFC0001234');
    expect(() => validateIfsc('HDFC1001234')).toThrow(/four letters, a zero, then six more/);
    expect(() => validateIfsc('HDFC000123')).toThrow(/not valid/);
  });
});

describe('vehicle number (conflict C-03)', () => {
  it('accepts the spaced form the prototype ships and stores it unspaced', () => {
    // The prototype's gate-inward field ships "WB 11 C 4821", which the schema's
    // gi_vehicle_format pattern rejects outright.
    expect(validateVehicleNo('WB 11 C 4821')).toBe('WB11C4821');
    expect(validateVehicleNo('wb11c4821')).toBe('WB11C4821');
  });

  it('formats back to the spaced form for display', () => {
    expect(formatVehicleNo('WB11C4821')).toBe('WB 11 C 4821');
    expect(formatVehicleNo(null)).toBe('—');
  });

  it('rejects something that is not a registration', () => {
    expect(() => validateVehicleNo('LORRY-2')).toThrow(/not valid/);
  });
});

describe('financial year', () => {
  it('accepts a consecutive pair', () => {
    expect(validateFinancialYear('fy26-27')).toBe('FY26-27');
    expect(validateFinancialYear('FY2627')).toBe('FY26-27');
  });

  it('rejects a non-consecutive pair', () => {
    expect(() => validateFinancialYear('FY26-28')).toThrow(/not a consecutive pair/);
  });

  it('handles the century roll', () => {
    expect(validateFinancialYear('FY99-00')).toBe('FY99-00');
  });
});

describe('other fields', () => {
  it('validates bank account numbers', () => {
    expect(validateBankAccountNumber('5011 2233 4455')).toBe('501122334455');
    expect(() => validateBankAccountNumber('12345')).toThrow(/6 to 20 digits/);
  });

  it('validates Indian mobile numbers', () => {
    expect(validatePhone('+91 98300 12345')).toBe('+919830012345');
    expect(validatePhone('9830012345')).toBe('9830012345');
    expect(() => validatePhone('1234567890')).toThrow(/not valid/);
  });

  it('validates business codes and KEEPS hyphens', () => {
    // A real bug: validateCode used to strip hyphens, so entering the
    // prototype's own item code PL-HDPE-12 silently stored PLHDPE12.
    expect(validateCode(' dhu ', 'code')).toBe('DHU');
    expect(validateCode('cc-evp-220', 'code')).toBe('CC-EVP-220');
    expect(validateCode('PL-HDPE-12', 'code')).toBe('PL-HDPE-12');
    expect(validateCode('MAINT/CAPEX-01', 'code')).toBe('MAINT/CAPEX-01');

    expect(() => validateCode('D', 'code')).toThrow(/between 2 and 24/);
    expect(() => validateCode('DHU!', 'code')).toThrow(/only letters, digits/);
    expect(() => validateCode('-LEADING', 'code')).toThrow(/must start with a letter or digit/);
  });

  it('keeps the two normalisers distinct', () => {
    // normaliseCode strips hyphens (a PAN typed with separators);
    // normaliseIdentifier keeps them (a code someone chose).
    expect(normaliseCode('aabcu-9603-r')).toBe('AABCU9603R');
    expect(normaliseIdentifier('cc-evp-220')).toBe('CC-EVP-220');
  });

  it('requires a temperature band on a cold-chain class', () => {
    // item_classes_temp
    expect(() => assertTemperatureBand(true, null, null)).toThrow(/both a minimum and a maximum/);
    expect(() => assertTemperatureBand(true, '-15', '-20')).toThrow(/minimum temperature must be below/);
    expect(() => assertTemperatureBand(true, '-20', '-15')).not.toThrow();
    expect(() => assertTemperatureBand(false, null, null)).not.toThrow();
  });
});

describe('bank account encryption', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env.BANK_ENC_KEY;
    process.env.BANK_ENC_KEY = KEY;
  });
  afterAll(() => {
    process.env.BANK_ENC_KEY = previous;
  });

  it('round-trips an account number', () => {
    const account = '501122334455';
    const stored = encryptSecret(account);
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(account); // the plaintext never appears
    expect(decryptSecret(stored)).toBe(account);
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per encryption; otherwise two vendors sharing an account
    // number would be visibly identical in the workbook.
    expect(encryptSecret('501122334455')).not.toBe(encryptSecret('501122334455'));
  });

  it('refuses a tampered ciphertext rather than returning rubbish', () => {
    const stored = encryptSecret('501122334455');
    const parts = stored.split('.');
    parts[2] = Buffer.from('tampered-payload').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow(/could not be decrypted/);
  });

  it('refuses a ciphertext written under a different key', () => {
    const stored = encryptSecret('501122334455');
    process.env.BANK_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(() => decryptSecret(stored)).toThrow(/could not be decrypted/);
    process.env.BANK_ENC_KEY = KEY;
  });

  it('rejects a key of the wrong length with actionable advice', () => {
    process.env.BANK_ENC_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptSecret('x')).toThrow(/openssl rand -base64 32/);
    process.env.BANK_ENC_KEY = KEY;
  });

  it('keeps only the last four digits readable', () => {
    expect(last4('501122334455')).toBe('4455');
    expect(maskAccount('4455')).toBe('•••• 4455');
  });
});
