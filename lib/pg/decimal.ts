/**
 * Fixed-point decimal arithmetic.
 *
 * postgres.js returns `numeric` as a STRING precisely so it never passes
 * through a JS float, and every money and quantity value in this system stays
 * that way end to end. Where the application genuinely has to do arithmetic —
 * a live total while someone types, a variance check — it does it here, not
 * with `+`.
 *
 * `0.1 + 0.2 !== 0.3` is a curiosity in most code and a wrong GST figure on a
 * real invoice here.
 *
 * The database remains authoritative for anything that gets stored: PR totals
 * and landed cost come from `v_pr_totals` and `v_quotation_landed_cost`
 * (brief §10). This class is for display and for checks, never a second
 * implementation of a view.
 */
import { AppError } from '@/lib/errors';

/** Scale (decimal places) per numeric type in the schema. */
export const SCALE: Record<'money' | 'qty' | 'pct' | 'temp', number> = { money: 2, qty: 3, pct: 2, temp: 1 };

// --- Fixed-point decimal ---------------------------------------------------------

/**
 * A decimal held as a scaled bigint: Decimal(12345n, 2) is 123.45.
 *
 * Only addition, subtraction, multiplication and half-up rounding are needed for
 * this domain, so this is deliberately small rather than a general library.
 */
export class Decimal {
  constructor(
    readonly units: bigint,
    readonly scale: number,
  ) {}

  static parse(value: string | number | null | undefined, scale: number): Decimal {
    if (value === null || value === undefined || value === '') return new Decimal(0n, scale);

    const s = String(value).trim().replace(/,/g, '');
    if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '-' || s === '.') {
      throw new AppError('VALIDATION', `"${value}" is not a valid number.`);
    }

    const negative = s.startsWith('-');
    const body = negative ? s.slice(1) : s;
    const [whole = '0', frac = ''] = body.split('.');

    // Round half-up if the input carries more precision than the column holds.
    const kept = frac.slice(0, scale).padEnd(scale, '0');
    const nextDigit = frac.charCodeAt(scale) - 48;
    let units = BigInt(`${whole}${kept}` || '0');
    if (nextDigit >= 5 && nextDigit <= 9) units += 1n;

    return new Decimal(negative ? -units : units, scale);
  }

  static zero(scale: number): Decimal {
    return new Decimal(0n, scale);
  }

  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    const a = this.units * 10n ** BigInt(scale - this.scale);
    const b = other.units * 10n ** BigInt(scale - other.scale);
    return [a, b, scale];
  }

  add(other: Decimal): Decimal {
    const [a, b, scale] = this.align(other);
    return new Decimal(a + b, scale);
  }

  sub(other: Decimal): Decimal {
    const [a, b, scale] = this.align(other);
    return new Decimal(a - b, scale);
  }

  /** Multiply, then round half-up to `scale` (default: this value's scale). */
  mul(other: Decimal, scale = this.scale): Decimal {
    const raw = this.units * other.units; // scale = this.scale + other.scale
    return rescale(raw, this.scale + other.scale, scale);
  }

  /** Percentage of this value, e.g. gst = taxable.percent(18) */
  percent(pct: Decimal, scale = this.scale): Decimal {
    const raw = this.units * pct.units; // scale = this.scale + pct.scale
    return rescale(raw, this.scale + pct.scale + 2, scale);
  }

  /** Same magnitude, opposite sign. */
  neg(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  rescale(scale: number): Decimal {
    return rescale(this.units, this.scale, scale);
  }

  cmp(other: Decimal): number {
    const [a, b] = this.align(other);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  eq(other: Decimal): boolean {
    return this.cmp(other) === 0;
  }
  lt(other: Decimal): boolean {
    return this.cmp(other) < 0;
  }
  lte(other: Decimal): boolean {
    return this.cmp(other) <= 0;
  }
  gt(other: Decimal): boolean {
    return this.cmp(other) > 0;
  }
  gte(other: Decimal): boolean {
    return this.cmp(other) >= 0;
  }

  get isZero(): boolean {
    return this.units === 0n;
  }
  get isNegative(): boolean {
    return this.units < 0n;
  }

  /** Canonical string, always with `scale` decimal places. This is what is stored. */
  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const frac = this.scale > 0 ? `.${digits.slice(digits.length - this.scale)}` : '';
    return `${negative ? '-' : ''}${whole}${frac}`;
  }

  /** For display only — never feed this back into a calculation. */
  toNumber(): number {
    return Number(this.toString());
  }
}

/** Round a scaled bigint to a new scale, half-up. */
function rescale(units: bigint, from: number, to: number): Decimal {
  if (to === from) return new Decimal(units, to);
  if (to > from) return new Decimal(units * 10n ** BigInt(to - from), to);

  const divisor = 10n ** BigInt(from - to);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const quotient = abs / divisor;
  const remainder = abs % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return new Decimal(negative ? -rounded : rounded, to);
}

export const money = (v: string | number | null | undefined) => Decimal.parse(v, SCALE.money);
export const qty = (v: string | number | null | undefined) => Decimal.parse(v, SCALE.qty);
export const pct = (v: string | number | null | undefined) => Decimal.parse(v, SCALE.pct);
export const temp = (v: string | number | null | undefined) => Decimal.parse(v, SCALE.temp);

export function sum(values: Decimal[], scale: number): Decimal {
  return values.reduce((a, b) => a.add(b), Decimal.zero(scale)).rescale(scale);
}
