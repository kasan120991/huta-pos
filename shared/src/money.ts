/**
 * Money. Integer cents, everywhere, always.
 *
 * Dollars exist only at the input boundary (`parseDollarsToCents`) and the display layer
 * (`formatCents`). Nothing else in the codebase converts between the two.
 */

import { type Bps, type Cents, UnitError, ZERO_CENTS, cents, unsafe } from './brand.js'
import { divRoundHalfUp } from './math.js'
import { type ParseResult, fail, ok } from './result.js'

export const CENTS_PER_DOLLAR = 100
export const BPS_DIVISOR = 10_000

// --- arithmetic, closed over the brand ------------------------------------------------
// These exist because `a + b` on two Cents produces a plain number. Without them every
// expression needs a cast, and a team that casts reflexively has thrown away the brands.

export function addCents(...values: readonly Cents[]): Cents {
  let total = 0
  for (const v of values) total += v
  return cents(total)
}

export function subCents(a: Cents, b: Cents): Cents {
  return cents(a - b)
}

/** Loops rather than spreading — a report summing 50k lines would blow the call stack. */
export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0
  for (const v of values) total += v
  return cents(total)
}

export function negateCents(a: Cents): Cents {
  return cents(a === 0 ? 0 : -a)
}

export const minCents = (a: Cents, b: Cents): Cents => (a <= b ? a : b)
export const maxCents = (a: Cents, b: Cents): Cents => (a >= b ? a : b)
export const clampCents = (v: Cents, lo: Cents, hi: Cents): Cents =>
  minCents(maxCents(v, lo), hi)

/**
 * Apply a basis-point rate and return the resulting portion, rounded half away from zero.
 * `applyBps(cents(1000), bps(825))` is 83 — $0.825 of tax on $10.00.
 *
 * Symmetric across zero, so refunding a taxed line returns exactly what was charged.
 */
export function applyBps(amount: Cents, rate: Bps): Cents {
  return unsafe.cents(divRoundHalfUp(amount * rate, BPS_DIVISOR))
}

/**
 * Subtract a basis-point discount, returning what remains. Rounds the discount and then
 * subtracts, so the discount displayed and the total always agree to the cent.
 */
export function subtractBps(amount: Cents, rate: Bps): Cents {
  return subCents(amount, applyBps(amount, rate))
}

// --- formatting -----------------------------------------------------------------------

/**
 * Hand-rolled rather than `Intl.NumberFormat`.
 *
 * Intl's currency output varies with ICU version and between Node and browsers — some
 * locales emit U+2212 MINUS and a non-breaking space. The house rules requires the server and
 * the register to format identically, and receipts to be byte-stable; this guarantees
 * both. Grouping still uses `toLocaleString`, which is stable for a bare integer.
 */
export function formatCents(amount: Cents, options?: { showSymbol?: boolean }): string {
  const showSymbol = options?.showSymbol ?? true
  const negative = amount < 0
  const abs = negative ? -amount : amount
  const dollars = Math.trunc(abs / CENTS_PER_DOLLAR)
  const remainder = String(abs % CENTS_PER_DOLLAR).padStart(2, '0')
  return `${negative ? '-' : ''}${showSymbol ? '$' : ''}${dollars.toLocaleString('en-US')}.${remainder}`
}

// --- parsing --------------------------------------------------------------------------

const TOO_PRECISE = /^-?\$?[\d,]*\.\d{3,}$/
const DOLLARS = /^(-)?(\d*)(?:\.(\d{1,2}))?$/

/**
 * Parse a user-typed dollar string into cents.
 *
 * Works on the decimal digits, never `parseFloat(s) * 100` — that turns "1.005" into
 * 100.49999999999999, and "8.15" into 814.9999999999999.
 */
export function parseDollarsToCents(input: string): ParseResult<Cents> {
  const raw = input.trim()
  if (raw === '') return fail('EMPTY', 'Enter an amount.')

  // Checked before the shape test so the message can be specific.
  if (TOO_PRECISE.test(raw)) {
    return fail('TOO_PRECISE', 'Amounts have at most two decimal places.')
  }

  const cleaned = raw.replace(/[$,\s]/g, '')
  const match = DOLLARS.exec(cleaned)
  if (!match || (match[2] === '' && match[3] === undefined)) {
    return fail('MALFORMED', `"${input}" is not an amount.`)
  }

  const whole = Number(match[2] || '0')
  const fraction = Number((match[3] ?? '').padEnd(2, '0'))
  const total = whole * CENTS_PER_DOLLAR + fraction

  if (!Number.isSafeInteger(total)) {
    return fail('OUT_OF_RANGE', 'That amount is too large.')
  }
  return ok(unsafe.cents(match[1] ? -total : total))
}

export { ZERO_CENTS, UnitError }
