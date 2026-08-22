/**
 * Weighted-average inventory costing.
 *
 * the house rules settles the costing method as WEIGHTED AVERAGE, scoped per store: each store's
 * on-hand stock carries its own cost basis, so a store that bought a variant at $4/g and
 * one that bought it at $5/g each report an honest margin rather than a blend neither of
 * them paid.
 *
 * What is stored is the POOL'S TOTAL VALUE (`StockLevel.costBasisCents`), never the
 * average. Storing an average means re-rounding it on every receive and compounding the
 * error indefinitely; storing the total rounds once per receipt line and derives the
 * average for display.
 *
 * THIS MODULE IS THE ONLY PLACE THE MILLIGRAM/GRAM FACTOR APPEARS IN COSTING. A WEIGHT
 * variant's cost is quoted per GRAM while its quantity counts MILLIGRAMS, so multiplying
 * the two directly overstates cost by 1000x — and a margin that is wrong by three orders
 * of magnitude still looks like a number, which is what makes it dangerous. the house rules
 * forbids an inline `* 1000` for exactly this reason.
 */

import { type BaseQuantity, type Cents, UnitError, unsafe } from './brand.js'
import { type TrackingMode, TrackingMode as TrackingModes } from './enums.js'
import { divRoundHalfUp } from './math.js'
import { MG_PER_GRAM } from './quantity.js'

/**
 * What one delivery line adds to the cost basis.
 *
 * `EACH`   — unit cost is per item, so the value is a plain product.
 * `WEIGHT` — unit cost is per gram against a milligram quantity, so it divides by 1000.
 *            Rounded half away from zero once, here, rather than at every later read.
 */
export function receiptLineValueCents(
  trackingMode: TrackingMode,
  quantityBase: BaseQuantity | number,
  unitCostCents: number,
): Cents {
  if (!Number.isInteger(quantityBase) || quantityBase < 0) {
    throw new UnitError(`receiptLineValueCents requires a non-negative quantity, got ${quantityBase}`)
  }
  if (!Number.isInteger(unitCostCents) || unitCostCents < 0) {
    throw new UnitError(`receiptLineValueCents requires a non-negative unit cost, got ${unitCostCents}`)
  }

  if (trackingMode === TrackingModes.EACH) {
    return unsafe.cents(quantityBase * unitCostCents)
  }
  return unsafe.cents(divRoundHalfUp(quantityBase * unitCostCents, MG_PER_GRAM))
}

/**
 * The average unit cost implied by a pool — per item for `EACH`, per GRAM for `WEIGHT`.
 *
 * Null rather than zero when there is nothing to divide by or no basis recorded. An
 * uncosted pool and a free one are different facts, and only one of them is ever true.
 */
export function unitCostFromBasis(
  trackingMode: TrackingMode,
  costBasisCents: number | null,
  quantityBase: BaseQuantity | number,
): number | null {
  if (costBasisCents === null || quantityBase <= 0) return null

  if (trackingMode === TrackingModes.EACH) {
    return divRoundHalfUp(costBasisCents, quantityBase)
  }
  // Scale to grams BEFORE dividing: at typical flower weights the basis is far smaller
  // than the milligram count, so dividing first would floor almost every rate to zero.
  return divRoundHalfUp(costBasisCents * MG_PER_GRAM, quantityBase)
}

/**
 * What leaves the basis when stock leaves the shelf.
 *
 * Proportional to the fraction of the pool being removed, which is what "weighted average"
 * means on the way out. Two guards matter:
 *
 *   * The whole pool leaving takes the whole basis, exactly — no residual cent survives a
 *     variant going to zero, where it would otherwise reappear as an infinite unit cost the
 *     next time one unit was received.
 *   * The result never exceeds the basis, so the column cannot be driven negative by
 *     rounding and trip its CHECK constraint.
 */
export function costOutCents(
  costBasisCents: number | null,
  previousQuantityBase: number,
  quantityOutBase: number,
): Cents {
  if (costBasisCents === null || costBasisCents === 0) return unsafe.cents(0)
  if (previousQuantityBase <= 0) return unsafe.cents(0)

  if (quantityOutBase >= previousQuantityBase) return unsafe.cents(costBasisCents)

  const out = divRoundHalfUp(costBasisCents * quantityOutBase, previousQuantityBase)
  return unsafe.cents(Math.min(out, costBasisCents))
}
