import { TrackingMode, divRoundHalfUp, receiptLineValueCents, unitCostFromBasis } from '@huta/shared'
import type { ProductInsights, WeightVarianceRow } from '@huta/shared/schemas'

import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { NotFoundError } from '../errors/index.js'
import { levelsForVariant } from '../inventory/inventory.service.js'
import { weightVarianceForVariant } from '../inventory/reconcile.service.js'
import { resolveStoreIds } from './catalog.service.js'

/**
 * Admin-only product economics, aggregated here so the client never computes money.
 *
 * Everything in the payload is cost-derived, so the ROUTE gates the whole endpoint on
 * `cost.view` — there is no per-field stripping to get subtly wrong. Three rules carried
 * over from the costing module:
 *
 *   * Margin never reads `ProductVariant.costCents` — that is a reference figure. Margin
 *     comes from the weighted-average basis each store actually paid.
 *   * A null basis means "cost unknown", never zero. Stock with unknown cost is EXCLUDED
 *     from the blended margin rather than dragging it toward 100%.
 *   * The mg↔g factor lives in `shared/src/costing.ts` — retail value of weighed stock goes
 *     through `receiptLineValueCents`, which owns the division.
 */
export async function productInsights(
  principal: Principal,
  productId: string,
  storeId?: string,
): Promise<ProductInsights> {
  const stores = await resolveStoreIds(principal, storeId)
  const inScope = new Set(stores.map((s) => s.id))

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      variants: {
        select: {
          id: true,
          trackingMode: true,
          priceCents: true,
          priceGroup: { select: { basePricePerGramCents: true } },
        },
      },
    },
  })
  if (!product) throw new NotFoundError('That product does not exist.')

  let productBasisKnown: number | null = null
  let retailOfCosted = 0
  let costOfCosted = 0
  let receivedBase = 0
  let lostBase = 0
  let hasWeight = false

  const variants = await Promise.all(
    product.variants.map(async (v) => {
      const trackingMode = v.trackingMode as TrackingMode
      const levels = (await levelsForVariant(principal, v.id)).filter((l) =>
        inScope.has(l.storeId),
      )

      // The retail rate this stock would sell at today: per item for EACH, per gram for
      // WEIGHT (through the group). Null when the variant is unpriced.
      const rate =
        trackingMode === TrackingMode.EACH
          ? v.priceCents
          : (v.priceGroup?.basePricePerGramCents ?? null)

      // Blend only over stock whose cost is known — quantity and basis must describe the
      // same pool or the average is a fiction.
      let costedQty = 0
      let basisKnown: number | null = null
      let vRetailOfCosted = 0
      let vCostOfCosted = 0

      for (const level of levels) {
        const basis = level.costBasisCents
        if (basis === null || basis === undefined) continue
        basisKnown = (basisKnown ?? 0) + basis
        productBasisKnown = (productBasisKnown ?? 0) + basis
        if (level.quantityBase > 0) {
          costedQty += level.quantityBase
          if (rate !== null) {
            const retail = receiptLineValueCents(trackingMode, level.quantityBase, rate)
            vRetailOfCosted += retail
            vCostOfCosted += basis
            retailOfCosted += retail
            costOfCosted += basis
          }
        }
      }

      const avgUnitCostCents = unitCostFromBasis(trackingMode, basisKnown, costedQty)
      const marginBps =
        vRetailOfCosted > 0
          ? divRoundHalfUp((vRetailOfCosted - vCostOfCosted) * 10_000, vRetailOfCosted)
          : null

      let variance: WeightVarianceRow[] | undefined
      if (trackingMode === TrackingMode.WEIGHT) {
        hasWeight = true
        variance = (await weightVarianceForVariant(principal, v.id)).filter((r) =>
          inScope.has(r.storeId),
        )
        for (const row of variance) {
          receivedBase += row.receivedBase
          lostBase += row.lostBase
        }
      }

      return {
        variantId: v.id,
        avgUnitCostCents,
        marginBps,
        levels,
        ...(variance ? { variance } : {}),
      }
    }),
  )

  return {
    valueAtCostCents: productBasisKnown,
    marginBps:
      retailOfCosted > 0
        ? divRoundHalfUp((retailOfCosted - costOfCosted) * 10_000, retailOfCosted)
        : null,
    lossRate90d: hasWeight
      ? {
          receivedBase,
          lostBase,
          lossRateBps: receivedBase > 0 ? divRoundHalfUp(lostBase * 10_000, receivedBase) : null,
        }
      : null,
    variants,
  }
}
