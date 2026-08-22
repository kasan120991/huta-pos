/**
 * Quantities and units of measure.
 *
 * Every quantity in the system is an integer in a variant's base unit:
 *   - `EACH`   variants: 1 base unit == 1 item.
 *   - `WEIGHT` variants: 1 base unit == 1 MILLIGRAM. 3.5g is 3500.
 *
 * Grams exist only at the input boundary and the display layer, and only through the
 * functions here. Nothing else in the codebase may multiply or divide by 1000.
 */

import { type BaseQuantity, UnitError, ZERO_BASE, baseDelta, unsafe } from './brand.js'
import { type TrackingMode, TrackingMode as TrackingModes } from './enums.js'
import { divRoundHalfUp } from './math.js'
import { type ParseResult, fail, ok } from './result.js'

/** Milligrams per gram. The single definition of the WEIGHT base unit. */
export const MG_PER_GRAM = 1000

/** A retail scale reads to 0.01g, so that is what we accept and what we display. */
export const GRAM_DECIMALS = 2

/** 10 mg — the smallest weight the scale resolves and the display step. */
export const MG_PER_DISPLAY_STEP = MG_PER_GRAM / 10 ** GRAM_DECIMALS

/**
 * Common retail weights, in base units.
 *
 * NOTE ON THE POUND: this is 16 x the retail ounce (16 x 28.00g = 448.00g), NOT the
 * avoirdupois pound of 453.592g. They differ by 5.592g. Keeping both conventions in one
 * system means a clerk keying "1 lb" and a manager reckoning "16 oz" disagree on every
 * single transaction, and that gap lands in the flower reconciliation report as phantom
 * shrinkage. The whole table is internally consistent: OUNCE * 16 === POUND, and there is
 * a test pinning that.
 */
export const WEIGHT = {
  HALF_GRAM: 500,
  GRAM: 1_000,
  EIGHTH: 3_500,
  QUARTER: 7_000,
  HALF_OUNCE: 14_000,
  OUNCE: 28_000,
  POUND: 448_000,
} as const

export type WeightName = keyof typeof WEIGHT

// --- arithmetic, closed over the brand ------------------------------------------------

export function addBase(...values: readonly BaseQuantity[]): BaseQuantity {
  let total = 0
  for (const v of values) total += v
  return baseDelta(total)
}

export function subBase(a: BaseQuantity, b: BaseQuantity): BaseQuantity {
  return baseDelta(a - b)
}

export function sumBase(values: Iterable<BaseQuantity>): BaseQuantity {
  let total = 0
  for (const v of values) total += v
  return baseDelta(total)
}

export function negateBase(a: BaseQuantity): BaseQuantity {
  return baseDelta(a === 0 ? 0 : -a)
}

// --- conversion -----------------------------------------------------------------------

const TOO_PRECISE = /^\d*\.\d{3,}$/
const GRAMS = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/

/**
 * Parse a gram string typed at the register into base units.
 *
 * Takes a STRING and reads the decimal digits directly. Multiplying the float is not
 * safe: `3.53 * 1000` is `3530.0000000000005` in IEEE 754, which is exactly the class of
 * error this module exists to prevent.
 *
 * Rejects more than two decimal places. No scale in the store produces `3.4567g` — it is
 * a typo or a paste accident, and pricing a weight nobody intended is worse than making
 * someone retype it.
 */
export function parseGramsToBase(input: string): ParseResult<BaseQuantity> {
  const raw = input.trim()
  if (raw === '') return fail('EMPTY', 'Enter a weight in grams.')

  // Checked first so the message names the actual problem.
  if (TOO_PRECISE.test(raw)) {
    return fail(
      'TOO_PRECISE',
      'The scale reads to two decimal places — enter at most 3.45g.',
    )
  }
  if (!GRAMS.test(raw)) {
    return fail('MALFORMED', `"${input}" is not a weight in grams.`)
  }

  const [whole = '0', fraction = ''] = raw.split('.')
  const milligrams = Number(whole || '0') * MG_PER_GRAM + Number(fraction.padEnd(3, '0'))

  if (!Number.isSafeInteger(milligrams)) {
    return fail('OUT_OF_RANGE', 'That weight is too large.')
  }
  return ok(unsafe.baseQuantity(milligrams))
}

/**
 * Convert grams expressed as a number into base units.
 *
 * Prefer `parseGramsToBase` for anything a human typed. This is for constants and
 * computed values; it rounds to the nearest milligram to absorb float representation
 * error.
 */
export function gramsToBase(grams: number): BaseQuantity {
  if (!Number.isFinite(grams)) throw new UnitError(`Weight must be finite, got ${grams}`)
  return baseDelta(Math.round(grams * MG_PER_GRAM))
}

/** Convert base units back to grams as a number. Display only — never for math. */
export function baseToGrams(base: BaseQuantity): number {
  return base / MG_PER_GRAM
}

// --- formatting -----------------------------------------------------------------------

/**
 * Format base units as grams with two decimals: `3500` becomes `"3.50g"`.
 *
 * The sign is applied to the magnitude rather than computed from the whole part, because
 * `InventoryMovement.quantityBase` for a SALE is negative and `Math.trunc(-50 / 100)` is
 * `-0`, which would silently drop the minus on any delta smaller than a gram.
 */
export function formatGrams(base: BaseQuantity, options?: { suffix?: boolean }): string {
  const suffix = options?.suffix ?? true
  const negative = base < 0
  const abs = negative ? -base : base

  const hundredths = divRoundHalfUp(abs, MG_PER_DISPLAY_STEP)
  const whole = Math.trunc(hundredths / 100)
  const fraction = String(hundredths % 100).padStart(2, '0')

  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${fraction}${suffix ? 'g' : ''}`
}

/**
 * Format a quantity in the unit its variant is actually tracked in.
 *
 * Always prefer this to formatting a raw number — a quantity without its unit is how a
 * 2-item sale ends up displayed as 2 grams.
 */
export function formatQuantity(base: BaseQuantity, mode: TrackingMode): string {
  return mode === TrackingModes.WEIGHT
    ? formatGrams(base)
    : base.toLocaleString('en-US')
}

export { ZERO_BASE }
