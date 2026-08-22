import {
  type BaseQuantity,
  type Cents,
  DiscountType,
  type PriceTierLike,
  TrackingMode,
  allocateProportional,
  applyBps,
  clampToZero,
  derivePerGramRate,
  extendPerGram,
  extendTier,
  formatCents,
  formatQuantity,
  subCents,
  sumCents,
  unsafe,
} from '@huta/shared'
import type {
  AppliedPromotion,
  ManualDiscountInput,
  Quote,
  QuoteLineInput,
  QuotedLine,
  RejectedPromotion,
} from '@huta/shared/schemas'

import { prisma } from '../db/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import { ConflictError, NotFoundError } from '../errors/index.js'
import {
  type PromotionCandidate,
  resolveDiscounts,
  selectOverride,
} from './promotion.resolver.js'

/** Read-compatible client: the root client or a caller's transaction. */
type Db = Prisma.TransactionClient | typeof prisma

/**
 * The ONE place a price is decided.
 *
 * House rule: "Pricing is computed in exactly one place; the client never derives a price
 * from a rate and a weight, it renders what the server returns." Everything that needs a
 * number — the register, the catalog, a refund — asks this.
 *
 * Resolution order, per the house rules:
 *   1. Variant price, else the matching price-group tier, else the group's base rate.
 *   2. Promotions: rate override first, then percent/amount by the best-outcome policy.
 *   3. Manual line discounts, then an order discount allocated across lines.
 */

export interface QuoteRequest {
  readonly storeId: string
  readonly lines: readonly QuoteLineInput[]
  readonly orderDiscount?: ManualDiscountInput | undefined
  readonly at?: Date | undefined
}

/** Everything needed to price one variant, fetched in a single query for the whole cart. */
const VARIANT_SHAPE = {
  id: true,
  sku: true,
  label: true,
  trackingMode: true,
  priceCents: true,
  taxable: true,
  active: true,
  minSaleBase: true,
  maxSaleBase: true,
  product: {
    select: {
      id: true,
      name: true,
      categoryId: true,
      category: { select: { id: true, parentId: true } },
    },
  },
  priceGroup: {
    select: {
      id: true,
      name: true,
      basePricePerGramCents: true,
      tiers: {
        select: { id: true, minQuantityBase: true, totalPriceCents: true },
        orderBy: { minQuantityBase: 'asc' as const },
      },
    },
  },
} as const

/**
 * The tier that governs a weight: the greatest threshold at or below it.
 *
 * Returns null below the lowest tier, where the group's base rate applies. Tiers arrive
 * ordered ascending, so this walks backwards to the first one that fits.
 */
export function tierFor<T extends { minQuantityBase: number }>(
  tiers: readonly T[],
  quantityBase: number,
): T | null {
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    const tier = tiers[i] as T
    if (quantityBase >= tier.minQuantityBase) return tier
  }
  return null
}

/**
 * Every ancestor of a category, so a promotion on `Inhalables` reaches a `Flower` product.
 *
 * Takes the parent map rather than querying, because this is called once per line and a
 * `findMany` inside it would run the same 21-row query for every item in the cart.
 */
function categoryAncestry(parentOf: ReadonlyMap<string, string | null>, categoryId: string): string[] {
  const chain: string[] = []
  let current: string | null | undefined = categoryId
  // Bounded by the tree depth; the guard is against a cycle a bad edit could introduce.
  while (current && chain.length < 32) {
    chain.push(current)
    current = parentOf.get(current) ?? null
  }
  return chain
}

async function categoryParentMap(db: Db): Promise<Map<string, string | null>> {
  const all = await db.category.findMany({ select: { id: true, parentId: true } })
  return new Map(all.map((c) => [c.id, c.parentId]))
}

function manualDiscountCents(discount: ManualDiscountInput | undefined, base: Cents): Cents {
  if (!discount) return unsafe.cents(0)
  if (discount.discountType === DiscountType.PERCENT_OFF) {
    return applyBps(base, unsafe.bps(discount.value))
  }
  return discount.value > base ? base : unsafe.cents(discount.value)
}

/**
 * Price a cart. `db` lets a caller enlist the quote's reads in ITS transaction —
 * checkout re-prices inside the same transaction that writes the sale, so the numbers
 * on the receipt are the numbers that were true when stock moved.
 */
export async function quote(request: QuoteRequest, db: Db = prisma): Promise<Quote> {
  if (request.lines.length === 0) {
    throw new ConflictError('A quote needs at least one line.')
  }

  const pricedAt = request.at ?? new Date()
  const variantIds = [...new Set(request.lines.map((l) => l.variantId))]

  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: VARIANT_SHAPE,
  })
  const byId = new Map(variants.map((v) => [v.id, v]))

  for (const id of variantIds) {
    if (!byId.has(id)) throw new NotFoundError('That product variant does not exist.')
  }

  // One promotion query for the whole cart rather than one per line.
  const parentOf = await categoryParentMap(db)
  const ancestryByVariant = new Map(
    variants.map((v) => [v.id, new Set(categoryAncestry(parentOf, v.product.categoryId))]),
  )
  const categoryIds = [...new Set([...ancestryByVariant.values()].flatMap((s) => [...s]))]

  const promotions = await db.promotion.findMany({
    where: {
      active: true,
      startsAt: { lte: pricedAt },
      OR: [{ endsAt: null }, { endsAt: { gt: pricedAt } }],
      AND: [
        {
          OR: [
            { variantId: { in: variantIds } },
            { productId: { in: variants.map((v) => v.product.id) } },
            { categoryId: { in: categoryIds } },
            {
              priceGroupId: {
                in: variants
                  .map((v) => v.priceGroup?.id)
                  .filter((id): id is string => id !== undefined),
              },
            },
          ],
        },
        {
          // No PromotionStore rows means every store; rows mean only those stores.
          OR: [{ stores: { none: {} } }, { stores: { some: { storeId: request.storeId } } }],
        },
      ],
    },
    select: {
      id: true,
      name: true,
      scopeType: true,
      discountType: true,
      value: true,
      stackable: true,
      variantId: true,
      productId: true,
      categoryId: true,
      priceGroupId: true,
    },
  })

  const lines: QuotedLine[] = request.lines.map((input) => {
    const variant = byId.get(input.variantId)!
    const ancestry = ancestryByVariant.get(variant.id)!

    const candidates: PromotionCandidate[] = promotions
      .filter(
        (p) =>
          (p.variantId !== null && p.variantId === variant.id) ||
          (p.productId !== null && p.productId === variant.product.id) ||
          (p.categoryId !== null && ancestry.has(p.categoryId)) ||
          (p.priceGroupId !== null && p.priceGroupId === variant.priceGroup?.id),
      )
      .map((p) => ({
        id: p.id,
        name: p.name,
        scopeType: p.scopeType,
        discountType: p.discountType,
        value: p.value,
        stackable: p.stackable,
      }))

    return priceLine(variant, input, candidates)
  })

  // --- order-level discount ------------------------------------------------------------

  const afterLine = lines.map((l) => unsafe.cents(l.netCents))
  const subtotal = sumCents(lines.map((l) => unsafe.cents(l.grossCents)))
  const orderTotalBefore = sumCents(afterLine)

  let finalLines = lines
  if (request.orderDiscount && orderTotalBefore > 0) {
    const orderDiscount = manualDiscountCents(request.orderDiscount, orderTotalBefore)
    // Largest-remainder, so the per-line shares sum to EXACTLY the order discount rather
    // than drifting a penny against the receipt total.
    const shares = allocateProportional(orderDiscount, afterLine)

    finalLines = lines.map((line, i) => {
      const share = shares[i] as Cents
      return {
        ...line,
        orderDiscountCents: share,
        discountCents: line.discountCents + share,
        netCents: clampToZero(subCents(unsafe.cents(line.netCents), share)),
        explain:
          share > 0
            ? [...line.explain, `Order discount share −${formatCents(share)}`]
            : line.explain,
      }
    })
  }

  const netCents = sumCents(finalLines.map((l) => unsafe.cents(l.netCents)))

  // --- tax -----------------------------------------------------------------------------
  // Computed HERE, with the same math checkout persists, so the register's running total
  // can never disagree with the charge. One applyBps over the taxable net (per-line tax
  // would drift), then largest-remainder allocation so the line parts sum exactly.

  const store = await db.store.findUnique({
    where: { id: request.storeId },
    select: { taxRateBps: true },
  })
  if (!store) throw new NotFoundError('That store does not exist.')

  const taxableFlags = finalLines.map((l) => byId.get(l.variantId)!.taxable)
  const taxableNet = finalLines.reduce(
    (sum, l, i) => sum + (taxableFlags[i] ? l.netCents : 0),
    0,
  )
  const taxCents = applyBps(unsafe.cents(taxableNet), unsafe.bps(store.taxRateBps))
  const taxableWeights = finalLines
    .filter((_, i) => taxableFlags[i])
    .map((l) => unsafe.cents(l.netCents))
  const allocation =
    taxCents > 0 && taxableWeights.some((w) => w > 0)
      ? allocateProportional(taxCents, taxableWeights)
      : taxableWeights.map(() => unsafe.cents(0))
  let taxIndex = 0
  finalLines = finalLines.map((line, i) =>
    taxableFlags[i] ? { ...line, taxCents: allocation[taxIndex++] ?? 0 } : line,
  )

  return {
    storeId: request.storeId,
    lines: finalLines,
    subtotalCents: subtotal,
    discountCents: clampToZero(subCents(subtotal, netCents)),
    netCents,
    taxRateBps: store.taxRateBps,
    taxCents,
    totalCents: netCents + taxCents,
    pricedAt: pricedAt.toISOString(),
  }
}

type VariantRow = Awaited<ReturnType<typeof prisma.productVariant.findMany<{
  select: typeof VARIANT_SHAPE
}>>>[number]

function priceLine(
  variant: VariantRow,
  input: QuoteLineInput,
  candidates: readonly PromotionCandidate[],
): QuotedLine {
  const quantityBase = input.quantityBase
  if (!Number.isInteger(quantityBase) || quantityBase <= 0) {
    throw new ConflictError('A line quantity must be a positive whole number of base units.')
  }
  if (!variant.active) {
    throw new ConflictError(`${variant.product.name} is no longer available.`)
  }
  if (variant.minSaleBase !== null && quantityBase < variant.minSaleBase) {
    throw new ConflictError(
      `Minimum sale quantity for ${variant.product.name} is ${formatQuantity(
        unsafe.baseQuantity(variant.minSaleBase),
        variant.trackingMode,
      )}.`,
    )
  }
  if (variant.maxSaleBase !== null && quantityBase > variant.maxSaleBase) {
    throw new ConflictError(
      `Maximum sale quantity for ${variant.product.name} is ${formatQuantity(
        unsafe.baseQuantity(variant.maxSaleBase),
        variant.trackingMode,
      )}.`,
    )
  }

  const explain: string[] = []
  const qty = unsafe.baseQuantity(quantityBase) as BaseQuantity

  // --- step 1: the rate override, which changes the BASE rather than discounting it -----
  const override = selectOverride(candidates, variant.trackingMode)
  const rejected: RejectedPromotion[] = [...override.rejected]

  // --- base amount ----------------------------------------------------------------------
  let grossCents: Cents
  let unitPriceCents: number | null = null
  let pricePerGramCents: number | null = null
  let appliedTierId: string | null = null
  let appliedTierLabel: string | null = null

  if (variant.trackingMode === TrackingMode.WEIGHT) {
    const group = variant.priceGroup
    if (!group) {
      // The CHECK constraint makes this unreachable, but a clear error beats a crash if a
      // future migration ever relaxes it.
      throw new ConflictError(`${variant.product.name} has no price group to price against.`)
    }

    if (override.override) {
      const rate = unsafe.centsPerGram(override.override.value)
      grossCents = extendPerGram(rate, qty)
      pricePerGramCents = override.override.value
      explain.push(
        `Promotion rate ${formatCents(unsafe.cents(override.override.value))}/g ` +
          `(${override.override.name})`,
      )
    } else {
      const tier = tierFor(group.tiers, quantityBase)
      if (tier) {
        const tierLike: PriceTierLike = {
          minQuantityBase: unsafe.baseQuantity(tier.minQuantityBase),
          totalPriceCents: unsafe.cents(tier.totalPriceCents),
        }
        grossCents = extendTier(tierLike, qty)
        appliedTierId = tier.id
        appliedTierLabel = `${formatQuantity(
          unsafe.baseQuantity(tier.minQuantityBase),
          TrackingMode.WEIGHT,
        )} — ${formatCents(unsafe.cents(tier.totalPriceCents))}`
        // The rate is recorded for the receipt, but grossCents above is authoritative:
        // extendTier charges the typed total at the threshold and floors just above it, so
        // rate x quantity does NOT reproduce it. Never multiply this back.
        pricePerGramCents = derivePerGramRate(
          unsafe.cents(tier.totalPriceCents),
          unsafe.baseQuantity(tier.minQuantityBase),
        )
        explain.push(`Tier ${appliedTierLabel}`)
      } else {
        const rate = unsafe.centsPerGram(group.basePricePerGramCents)
        grossCents = extendPerGram(rate, qty)
        pricePerGramCents = group.basePricePerGramCents
        explain.push(`${group.name} base rate ${formatCents(unsafe.cents(rate))}/g`)
      }
    }
    explain.push(
      `${formatQuantity(qty, TrackingMode.WEIGHT)} = ${formatCents(grossCents)}`,
    )
  } else {
    if (variant.priceCents === null) {
      throw new ConflictError(`${variant.product.name} has no price set.`)
    }
    unitPriceCents = variant.priceCents
    grossCents = unsafe.cents(variant.priceCents * quantityBase)
    explain.push(
      quantityBase === 1
        ? formatCents(grossCents)
        : `${quantityBase} × ${formatCents(unsafe.cents(variant.priceCents))} = ${formatCents(grossCents)}`,
    )
  }

  // --- step 2: percent and amount promotions, against the resolved gross ----------------
  const discounts = resolveDiscounts(override.remaining, grossCents)
  rejected.push(...discounts.rejected)

  const applied: AppliedPromotion[] = override.override
    ? [
        {
          promotionId: override.override.id,
          name: override.override.name,
          scopeType: override.override.scopeType,
          discountType: override.override.discountType,
          value: override.override.value,
          // Its effect is already inside grossCents as a replaced rate, so it subtracts
          // nothing here by construction.
          discountCents: 0,
        },
        ...discounts.applied,
      ]
    : [...discounts.applied]

  for (const promotion of discounts.applied) {
    explain.push(`${promotion.name} −${formatCents(unsafe.cents(promotion.discountCents))}`)
  }

  // --- step 3: manual line discount ------------------------------------------------------
  const afterPromotions = clampToZero(subCents(grossCents, discounts.discountCents))
  const manual = manualDiscountCents(input.manualDiscount, afterPromotions)
  if (manual > 0) {
    explain.push(
      `Manual discount −${formatCents(manual)}` +
        (input.manualDiscount?.reason ? ` (${input.manualDiscount.reason})` : ''),
    )
  }

  const netCents = clampToZero(subCents(afterPromotions, manual))

  return {
    variantId: variant.id,
    productName: variant.product.name,
    variantLabel: variant.label,
    sku: variant.sku,
    trackingMode: variant.trackingMode,
    quantityBase,
    unitPriceCents,
    pricePerGramCents,
    appliedTierId,
    appliedTierLabel,
    grossCents,
    appliedPromotions: applied,
    rejectedPromotions: rejected,
    promotionStrategy: override.override ? 'single-non-stackable' : discounts.strategy,
    promotionDiscountCents: discounts.discountCents,
    manualDiscountCents: manual,
    orderDiscountCents: 0,
    discountCents: discounts.discountCents + manual,
    netCents,
    // Filled in by `quote` once every discount has settled — tax is on the FINAL net.
    taxCents: 0,
    explain,
  }
}
