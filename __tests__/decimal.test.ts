/**
 * Fixed-point decimal arithmetic.
 *
 * postgres.js hands back `numeric` as a string so it never passes through a JS
 * float. Where the application does arithmetic on money — a live total while
 * someone types, a variance check — it does it here. A float bug in this file
 * is a wrong GST figure on a real invoice, so it is tested hard.
 */
import { Decimal, money, qty, pct, sum } from '@/lib/pg/decimal';

describe('Decimal', () => {
  it('parses and renders at a fixed scale', () => {
    expect(money('123.4').toString()).toBe('123.40');
    expect(money('123').toString()).toBe('123.00');
    expect(money('').toString()).toBe('0.00');
    expect(money(null).toString()).toBe('0.00');
    expect(qty('12.5').toString()).toBe('12.500');
    expect(pct('18').toString()).toBe('18.00');
  });

  it('strips thousands separators typed into a form', () => {
    expect(money('1,82,000').toString()).toBe('182000.00');
    expect(money('2,150.50').toString()).toBe('2150.50');
  });

  it('rounds half-up when the input carries more precision than the column', () => {
    expect(money('1.005').toString()).toBe('1.01');
    expect(money('1.004').toString()).toBe('1.00');
    expect(money('-1.005').toString()).toBe('-1.01');
    expect(qty('1.0005').toString()).toBe('1.001');
  });

  it('does not suffer binary floating point error', () => {
    // The reason this class exists: 0.1 + 0.2 === 0.30000000000000004 in JS.
    expect(money('0.1').add(money('0.2')).toString()).toBe('0.30');
    expect(money('0.1').add(money('0.2')).eq(money('0.3'))).toBe(true);

    // 100 additions of 0.01 must be exactly 1.00
    let acc = money('0');
    for (let i = 0; i < 100; i++) acc = acc.add(money('0.01'));
    expect(acc.toString()).toBe('1.00');
  });

  it('adds and subtracts exactly', () => {
    expect(money('2150.75').add(money('1849.25')).toString()).toBe('4000.00');
    expect(money('1000').sub(money('999.99')).toString()).toBe('0.01');
    expect(money('10').sub(money('25')).toString()).toBe('-15.00');
  });

  it('computes GST as a percentage, rounded to paise', () => {
    // 500 pallets x 2150.00 = 1,075,000.00; 18% = 193,500.00
    const taxable = money('2150').mul(qty('500').rescale(2), 2);
    expect(taxable.toString()).toBe('1075000.00');
    expect(taxable.percent(pct('18')).toString()).toBe('193500.00');
  });

  it('rounds GST half-up on awkward values', () => {
    // 1234.55 x 18% = 222.219 -> 222.22
    expect(money('1234.55').percent(pct('18')).toString()).toBe('222.22');
    // 1234.51 x 18% = 222.2118 -> 222.21
    expect(money('1234.51').percent(pct('18')).toString()).toBe('222.21');
    // 5% on 10.10 = 0.505 -> 0.51
    expect(money('10.10').percent(pct('5')).toString()).toBe('0.51');
  });

  it('handles GST rates with decimals', () => {
    // 12.5% on 1000.00 = 125.00
    expect(money('1000').percent(pct('12.5')).toString()).toBe('125.00');
    // 2.5% on 999.99 = 24.99975 -> 25.00
    expect(money('999.99').percent(pct('2.5')).toString()).toBe('25.00');
  });

  it('multiplies quantity by rate at full precision, rounding only the result', () => {
    // 12.345 x 2150.75 = 26551.00875 exactly -> 26551.01
    expect(qty('12.345').mul(money('2150.75'), 2).toString()).toBe('26551.01');
  });

  it('loses precision if a value is rescaled BEFORE multiplying', () => {
    // Documents a real hazard: rescale() rounds, so narrowing a 3-dp quantity to
    // 2 dp first turns 12.345 into 12.35 and the line total drifts by ~11 rupees.
    // Always multiply first and round the result — never the operands.
    const wrong = qty('12.345').rescale(2).mul(money('2150.75'), 2);
    const right = qty('12.345').mul(money('2150.75'), 2);
    expect(wrong.toString()).toBe('26561.76');
    expect(right.toString()).toBe('26551.01');
    expect(wrong.eq(right)).toBe(false);
  });

  it('compares without coercion', () => {
    expect(money('100').gt(money('99.99'))).toBe(true);
    expect(money('100').gte(money('100.00'))).toBe(true);
    expect(money('0').isZero).toBe(true);
    expect(money('-0.01').isNegative).toBe(true);
    expect(qty('500.000').eq(qty('500'))).toBe(true);
  });

  it('sums a list at a fixed scale', () => {
    expect(sum([money('1.11'), money('2.22'), money('3.33')], 2).toString()).toBe('6.66');
    expect(sum([], 2).toString()).toBe('0.00');
  });

  it('rejects values that are not numbers', () => {
    expect(() => money('abc')).toThrow(/not a valid number/);
    expect(() => money('1.2.3')).toThrow(/not a valid number/);
    expect(() => money('-')).toThrow(/not a valid number/);
  });

  it('survives a value at the top of numeric(14,2)', () => {
    // 12 digits before the point, 2 after — the widest the schema allows.
    const big = money('999999999999.99');
    expect(big.toString()).toBe('999999999999.99');
    expect(big.add(money('0.01')).toString()).toBe('1000000000000.00');
  });

  it('round-trips through the string form PostgreSQL returns', () => {
    // numeric(14,2) comes back from postgres.js as a string; parsing and
    // re-rendering it must be lossless.
    const original = money('182000.45');
    expect(money(original.toString()).eq(original)).toBe(true);
    expect(money('182000.45').toString()).toBe('182000.45');
  });

  it('negates without drift', () => {
    expect(money('182000.45').neg().toString()).toBe('-182000.45');
    expect(money('0').neg().toString()).toBe('0.00');
  });
});
