import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { parseGramsToBase, receiptLineValueCents } from '@huta/shared'
import { parseDollars } from './money'

/**
 * Parsing and line arithmetic for an order being composed.
 *
 * Pure and reactivity-free on purpose: the supplier shelf calls these once per row on every
 * keystroke, and they have to stay unit-testable away from a component.
 *
 * The non-negotiable both parsers exist for: quantities and money are typed STRINGS parsed to
 * integers, never floats. `3.53 * 1000` is `3530.0000000000005`, which is why
 * `parseGramsToBase` reads digits rather than multiplying.
 */

/** The suffix a quantity carries — grams for WEIGHT, a count for EACH. */
export const unitOf = (mode: TrackingMode): string => (mode === 'WEIGHT' ? 'g' : 'ct')

/**
 * What a quantity box holds when a line is first added deliberately.
 *
 * An order's count starts at one; grams are keyed. Receiving's blank-count rule is about what
 * ARRIVED and must never be rubber-stamped — an order line is what's being ASKED for, which is
 * a different question.
 *
 * ⚠️ This applies to adding a line, NOT to rendering a shelf row. Every row on a supplier
 * shelf opens blank, because a seeded `1` down 41 rows would mean "order one of everything".
 */
export const qtySeed = (mode: TrackingMode): string => (mode === 'EACH' ? '1' : '')

/**
 * Grams or a count → base units (milligrams or items). Null for blank, zero, or malformed.
 *
 * Takes `undefined` because the shelf keys quantities in a map and an untouched row has no
 * entry at all. Zero returning null is load-bearing twice over: it rejects a nonsense line,
 * and it is what keeps 38 blank rows of a 41-row shelf out of the request body for free.
 */
export function parseQty(raw: string | undefined, mode: TrackingMode): number | null {
  const value = (raw ?? '').trim()
  if (value === '') return null
  if (mode === 'WEIGHT') {
    const parsed = parseGramsToBase(value)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null
}

/**
 * Dollars → cents. Blank is LEGAL — the server takes `unitCostCents` as optional, and an
 * uncosted line lands in the receiving desk's costing queue. Malformed is `'invalid'`, which
 * is a different answer from "not given yet" and blocks the save.
 */
export function parseUnitCost(raw: string | undefined): number | null | 'invalid' {
  const value = (raw ?? '').trim()
  if (value === '') return null
  return parseDollars(value) ?? 'invalid'
}

/**
 * What one line is worth — the SAME `receiptLineValueCents` the server runs, so the figure on
 * screen cannot disagree with the one that lands on the order.
 */
export function lineValueCents(
  mode: TrackingMode,
  qtyRaw: string | undefined,
  costRaw: string | undefined,
): number | null {
  const base = parseQty(qtyRaw, mode)
  const cost = parseUnitCost(costRaw)
  if (base === null || cost === null || cost === 'invalid') return null
  return receiptLineValueCents(mode, base as BaseQuantity, cost as Cents)
}
