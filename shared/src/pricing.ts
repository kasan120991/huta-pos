/**
 * Weight-pricing arithmetic.
 *
 * This is the ONLY module that legitimately touches both money and quantity, which is why
 * it exists rather than living in either — `money.ts` stays free of unit concepts and
 * `quantity.ts` stays free of money concepts.
 *
 * These are pure primitives. Deciding WHICH tier or promotion applies is `PricingService`
 * on the server: the house rules are explicit that the client never derives a price, so the
 * resolution logic must not be importable from the browser.
 */

import { type BaseQuantity, type Cents, type CentsPerGram, UnitError, unsafe } from './brand.js'
import { divRoundHalfUp } from './math.js'
import { MG_PER_GRAM } from './quantity.js'

/** Never let a discount drive a line below zero. */
export function clampToZero(amount: Cents): Cents {
  return amount < 0 ? unsafe.cents(0) : amount
}

/**
 * Split a total across weights so the parts sum to EXACTLY the total.
 *
 * Used for an order-level discount spread over lines. The naive approach — round each
 * line's share independently — loses or gains pennies against the order total, so a $10.00
 * order discount comes out as $9.99 or $10.01 on the receipt. Over a day that is drift the
 * shift reconciliation has to explain.
 *
 * Largest-remainder: floor every share, then hand the leftover cents to the lines with the
 * largest discarded fractions, ties going to the earlier line so the result is
 * deterministic and a re-quote of the same cart never moves a penny between lines.
 */
export function allocateProportional(total: Cents, weights: readonly Cents[]): Cents[] {
  if (total < 0) throw new UnitError(`Cannot allocate a negative total, got ${total}`)
  if (weights.some((w) => w < 0)) throw new UnitError('Allocation weights must not be negative')
  if (weights.length === 0) return []
  if (total === 0) return weights.map(() => unsafe.cents(0))

  const weightSum = weights.reduce((sum, w) => sum + w, 0)
  if (weightSum === 0) {
    // Every line is already free. There is nothing to take a discount off, and spreading
    // it evenly would invent money that was never charged.
    throw new UnitError('Cannot allocate proportionally across zero-value lines')
  }

  const floors: number[] = []
  const remainders: Array<{ index: number; fraction: number }> = []
  let allocated = 0

  weights.forEach((weight, index) => {
    const exact = total * weight
    const floor = Math.floor(exact / weightSum)
    floors.push(floor)
    allocated += floor
    remainders.push({ index, fraction: exact - floor * weightSum })
  })

  let leftover = total - allocated
  remainders.sort((a, b) => b.fraction - a.fraction || a.index - b.index)

  for (const { index } of remainders) {
    if (leftover <= 0) break
    floors[index] = (floors[index] as number) + 1
    leftover -= 1
  }

  return floors.map((c) => unsafe.cents(c))
}

/** Extend a per-gram rate over a weight. `extendPerGram(857, 3500)` is 3000 ($30.00). */
export function extendPerGram(rate: CentsPerGram, quantity: BaseQuantity): Cents {
  return unsafe.cents(divRoundHalfUp(rate * quantity, MG_PER_GRAM))
}

/**
 * Derive the per-gram rate a tier implies. `derivePerGramRate(3000, 3500)` is 857 —
 * "$30 for an eighth" becomes $8.57/g.
 */
export function derivePerGramRate(
  totalPriceCents: Cents,
  minQuantityBase: BaseQuantity,
): CentsPerGram {
  if (minQuantityBase <= 0) {
    throw new UnitError(`Tier threshold must be positive, got ${minQuantityBase}`)
  }
  return unsafe.centsPerGram(divRoundHalfUp(totalPriceCents * MG_PER_GRAM, minQuantityBase))
}

export interface PriceTierLike {
  readonly minQuantityBase: BaseQuantity
  readonly totalPriceCents: Cents
}

/**
 * Price a weight against a tier.
 *
 * Two corrections to the naive "derive a rate and multiply" approach, both of which are
 * bugs that show up as wrong money on a receipt:
 *
 * 1. AT the threshold, charge the total the admin actually typed. Deriving a whole-cent
 *    rate and multiplying back does not round-trip: a 28g tier entered as $200.00 derives
 *    714 c/g and rings up 714 x 28 = $199.92; a 7g tier entered as $55.00 derives 786 c/g
 *    and rings up $55.02. Only the eighth happens to reconcile (857 x 3.5 = 2999.5, which
 *    rounds to exactly 3000), which is why the worked example in the house rules looked fine.
 *    An admin who types $200 must see $200.
 *
 * 2. ABOVE the threshold, never charge less than the tier total. Because the derived rate
 *    is rounded, `rate x quantity` can dip below it: at 28.01g the ounce rate yields
 *    $199.99, one cent LESS than the 28.00g price. Adding weight must never reduce the
 *    price — a customer finding that is a refund request, and staff cannot explain it.
 *
 * The result is monotonic across the whole tier, with a flat spot of at most a few
 * milligrams just above the threshold.
 */
export function extendTier(tier: PriceTierLike, quantity: BaseQuantity): Cents {
  if (quantity === tier.minQuantityBase) return tier.totalPriceCents

  const extended = extendPerGram(
    derivePerGramRate(tier.totalPriceCents, tier.minQuantityBase),
    quantity,
  )

  if (quantity > tier.minQuantityBase && extended < tier.totalPriceCents) {
    return tier.totalPriceCents
  }
  return extended
}
