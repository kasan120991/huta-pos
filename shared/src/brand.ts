/**
 * Branded numeric types.
 *
 * Every quantity and monetary value in this system is an integer, but they are integers
 * in units that are catastrophic to confuse. Plain `number` lets you pass grams where
 * milligrams are expected and be wrong by 1000x with no warning; branding makes that a
 * compile error.
 *
 * The cost is real: `a + b` on two branded values yields a plain `number` and loses the
 * brand. That is why the arithmetic helpers in `money.ts` and `quantity.ts` exist instead
 * of letting call sites use raw operators. The friction is the point — it keeps the unit
 * visible at every step.
 *
 * NOTE: brands are compile-time only and do not survive the wire. A `Cents` on an HTTP
 * response body is a claim, not a fact — parse it with Zod or an explicit `unsafe.*`
 * mapper on the way in. Never let `as Cents` on a `fetch()` result create false
 * confidence.
 */

// A declared unique symbol rather than a `{ __brand: string }` property: it cannot be
// accidentally satisfied by a hand-written object, never exists at runtime, and keeps
// error messages readable. It still emits correctly into .d.ts files.
declare const BRAND: unique symbol

export type Brand<T, K extends string> = T & { readonly [BRAND]: K }
export type Unbrand<T> = T extends Brand<infer U, string> ? U : T

/** Money, in whole cents. Never a float, never dollars. */
export type Cents = Brand<number, 'Cents'>

/**
 * A per-gram price, in cents. Deliberately a different brand from `Cents`.
 *
 * Both are "cents", so a shared brand would let `addCents(rate, subtotal)` typecheck and
 * silently produce garbage — precisely the bug class brands were adopted to prevent.
 */
export type CentsPerGram = Brand<number, 'CentsPerGram'>

/**
 * Stock, in a variant's base unit. The unit depends on `trackingMode`: items for `EACH`,
 * MILLIGRAMS for `WEIGHT`. 3.5g is 3500.
 */
export type BaseQuantity = Brand<number, 'BaseQuantity'>

/** Basis points. 825 == 8.25%, 10000 == 100%. */
export type Bps = Brand<number, 'Bps'>

export class UnitError extends RangeError {
  override readonly name = 'UnitError'
}

function assertSafeInteger(n: number, unit: string): void {
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new UnitError(`${unit} must be a number, got ${String(n)}`)
  }
  if (!Number.isFinite(n)) {
    throw new UnitError(`${unit} must be finite, got ${n}`)
  }
  if (!Number.isSafeInteger(n)) {
    throw new UnitError(`${unit} must be a safe integer, got ${n}`)
  }
}

/**
 * Validating constructors. These THROW, because reaching one with a bad value is a
 * programmer error. Values arriving from a human go through the parsers in `money.ts` /
 * `quantity.ts`, which return a `ParseResult` instead.
 */

export function cents(n: number): Cents {
  assertSafeInteger(n, 'Cents')
  return n as Cents
}

export function centsPerGram(n: number): CentsPerGram {
  assertSafeInteger(n, 'CentsPerGram')
  if (n < 0) throw new UnitError(`CentsPerGram must not be negative, got ${n}`)
  return n as CentsPerGram
}

/** Non-negative. For signed movement deltas use `baseDelta`. */
export function baseQuantity(n: number): BaseQuantity {
  assertSafeInteger(n, 'BaseQuantity')
  if (n < 0) throw new UnitError(`BaseQuantity must not be negative, got ${n}`)
  return n as BaseQuantity
}

/** A signed base quantity — inventory deltas are negative for SALE, TRANSFER_OUT, SHRINKAGE. */
export function baseDelta(n: number): BaseQuantity {
  assertSafeInteger(n, 'BaseQuantity')
  return n as BaseQuantity
}

export function bps(n: number): Bps {
  assertSafeInteger(n, 'Bps')
  if (n < 0 || n > 10_000) throw new UnitError(`Bps must be between 0 and 10000, got ${n}`)
  return n as Bps
}

/**
 * Unchecked casts, for values already known-good — a column read straight off a Prisma
 * row, where the database CHECK constraints have already enforced the invariant.
 *
 * These exist as named functions rather than inline `as Cents` so that trust boundaries
 * are greppable: `grep -rn 'as Cents' src/` should return nothing outside this file, and
 * `grep -rn 'unsafe\.' src/` is the audit list.
 */
export const unsafe = {
  cents: (n: number): Cents => n as Cents,
  centsPerGram: (n: number): CentsPerGram => n as CentsPerGram,
  baseQuantity: (n: number): BaseQuantity => n as BaseQuantity,
  bps: (n: number): Bps => n as Bps,
} as const

export const ZERO_CENTS = 0 as Cents
export const ZERO_BASE = 0 as BaseQuantity
