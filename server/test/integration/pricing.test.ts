import { DiscountType, PromotionScope, TrackingMode, WEIGHT } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { priceLadder } from '../../src/pricing/price-group.service.js'
import { quote } from '../../src/pricing/pricing.service.js'
import {
  makeCategory,
  makePriceGroup,
  makeProduct,
  makePromotion,
  makeStore,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'
import { findCostKeys } from '../setup/cost-keys.js'

/**
 * PricingService against a real database.
 *
 * House rule: "PricingService gets a table-driven test suite: every tier boundary exactly on
 * the threshold and one milligram either side, weights between tiers, weights above the top
 * tier, promo precedence across all four scopes, expired and future-dated promos, and
 * stackable vs non-stackable. Tier boundaries are where money quietly goes wrong."
 */

/** The placeholder ladder from the house rules. Real numbers still pending. */
const TIERS = [
  { minQuantityBase: WEIGHT.GRAM, totalPriceCents: 1000 },
  { minQuantityBase: WEIGHT.EIGHTH, totalPriceCents: 3000 },
  { minQuantityBase: WEIGHT.QUARTER, totalPriceCents: 5500 },
  { minQuantityBase: WEIGHT.OUNCE, totalPriceCents: 20_000 },
]

let storeA: { id: string }
let storeB: { id: string }
let inhalables: { id: string }
let flowerCategory: { id: string }
let group: { id: string }
let strain: Awaited<ReturnType<typeof makeWeightProduct>>
let variantId: string

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Alpha Store', 'alpha')
  storeB = await makeStore('Beta Store', 'beta')

  inhalables = await makeCategory('Inhalables', 'inhalables')
  flowerCategory = await makeCategory('Flower', 'flower', inhalables.id)

  group = await makePriceGroup('Flower', 'flower', 1000, TIERS)
  strain = await makeWeightProduct({
    name: 'Blue Dream',
    categoryId: flowerCategory.id,
    priceGroupId: group.id,
  })
  variantId = strain.variants[0]!.id
})

async function priceWeight(quantityBase: number, storeId = storeA.id) {
  const result = await quote({ storeId, lines: [{ variantId, quantityBase }] })
  return result.lines[0]!
}

describe('tier boundaries', () => {
  // Exactly on the threshold, and one MILLIGRAM either side. This is the table the house rules
  // asks for, and the numbers are hand-derived from the ladder above.
  it.each([
    // below the lowest tier — the group's base rate of $10.00/g
    [500, 500, null],
    [999, 999, null],
    // 1g tier: $10.00
    [1_000, 1_000, '1.00g'],
    [1_001, 1_001, '1.00g'],
    [2_000, 2_000, '1.00g'],
    [3_499, 3_499, '1.00g'],
    // 3.5g tier: $30.00 -> 857 c/g
    [3_500, 3_000, '3.50g'],
    [3_501, 3_000, '3.50g'],
    [5_000, 4_285, '3.50g'],
    [6_999, 5_998, '3.50g'],
    // 7g tier: $55.00 -> 786 c/g
    [7_000, 5_500, '7.00g'],
    [7_001, 5_503, '7.00g'],
    [14_000, 11_004, '7.00g'],
    [27_999, 22_007, '7.00g'],
    // 28g tier: $200.00 -> 714 c/g
    [28_000, 20_000, '28.00g'],
    [28_001, 20_000, '28.00g'],
    [56_000, 39_984, '28.00g'],
  ])('%i base units costs %i cents under tier %s', async (quantityBase, expected, tierLabel) => {
    const line = await priceWeight(quantityBase)
    expect(line.grossCents).toBe(expected)
    // The tier is asserted too: a right total under the wrong tier means the snapshot on
    // the eventual SaleLine explains the receipt incorrectly.
    expect(line.appliedTierLabel?.split(' — ')[0] ?? null).toBe(tierLabel)
  })

  it('charges exactly the total the admin typed, at every threshold', async () => {
    // The first extendTier guard. Deriving a whole-cent rate and multiplying back does not
    // round-trip: the quarter would ring $55.02 and the ounce $199.92.
    for (const tier of TIERS) {
      const line = await priceWeight(tier.minQuantityBase)
      expect(line.grossCents).toBe(tier.totalPriceCents)
    }
  })

  it('never costs less as the weight goes up WITHIN a tier', async () => {
    // The second extendTier guard, and the one that produced a real bug: 28.01g once cost
    // a cent LESS than 28.00g.
    //
    // Deliberately scoped to within a tier. Crossing INTO a tier is supposed to drop the
    // price — that is what a bulk break is — so a global "price only ever rises" assertion
    // would be asserting that tiered pricing does not work.
    const withinTier = [
      [1_000, 1_001, 2_000, 3_499],
      [3_500, 3_501, 5_000, 6_999],
      [7_000, 7_001, 14_000, 27_999],
      [28_000, 28_001, 56_000],
    ]

    for (const points of withinTier) {
      let previous = -1
      for (const quantityBase of points) {
        const line = await priceWeight(quantityBase)
        expect(line.grossCents).toBeGreaterThanOrEqual(previous)
        previous = line.grossCents
      }
    }
  })

  it('makes every tier break a saving', async () => {
    // The property a customer would actually notice: stepping up to a break always costs
    // less than the milligram below it. 3.499g is $34.99 and 3.500g is $30.00 — buying more
    // is cheaper outright, which is what a bulk break IS rather than a bug. It is also why
    // staff should round a near-miss weight up to the break.
    for (const tier of TIERS.slice(1)) {
      const below = await priceWeight(tier.minQuantityBase - 1)
      const at = await priceWeight(tier.minQuantityBase)
      expect(at.grossCents).toBeLessThan(below.grossCents)
    }
  })

  it('derives a strictly cheaper per-gram rate at each step up the ladder', async () => {
    const rates: number[] = []
    for (const tier of TIERS) {
      const line = await priceWeight(tier.minQuantityBase + 1)
      rates.push(line.pricePerGramCents!)
    }
    expect(rates).toEqual([1000, 857, 786, 714])
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]!).toBeLessThan(rates[i - 1]!)
    }
  })

  it('has a sub-cent per-gram wobble at a threshold, and that is the guard working', async () => {
    // Charging the typed total AT the threshold means 7.000g rings $55.00 — an effective
    // 785.71 c/g — while 14.000g rings $110.04 at the derived 786 c/g. So two sevens cost
    // 4c less than one fourteen.
    //
    // Documented rather than fixed. The alternative is charging $55.02 for a quarter an
    // admin entered as $55.00, which is the worse of the two surprises: one is four cents
    // across half an ounce, the other is every receipt disagreeing with the price list.
    const sevenTwice = (await priceWeight(WEIGHT.QUARTER)).grossCents * 2
    const fourteen = (await priceWeight(WEIGHT.QUARTER * 2)).grossCents
    expect(sevenTwice).toBe(11_000)
    expect(fourteen).toBe(11_004)
    expect(fourteen - sevenTwice).toBe(4)
  })

  it('names the tier that applied, because staff get asked', async () => {
    const line = await priceWeight(5_000)
    expect(line.appliedTierLabel).toBe('3.50g — $30.00')
    expect(line.appliedTierId).not.toBeNull()
    expect(line.explain).toContain('Tier 3.50g — $30.00')
  })

  it('falls back to the base rate below the lowest tier, with no tier recorded', async () => {
    const line = await priceWeight(500)
    expect(line.grossCents).toBe(500)
    expect(line.appliedTierId).toBeNull()
    expect(line.pricePerGramCents).toBe(1000)
  })

  it('does NOT let the snapshotted rate reproduce the charge on a tiered line', async () => {
    // Pinned deliberately. extendTier charges the typed total at the threshold, so the
    // rate is a rounded description of the charge rather than its input. Anything that
    // recomputes a line total from pricePerGramCents is wrong, and this proves it.
    const line = await priceWeight(WEIGHT.OUNCE)
    expect(line.grossCents).toBe(20_000)
    expect(line.pricePerGramCents).toBe(714)
    const naive = Math.round((line.pricePerGramCents! * WEIGHT.OUNCE) / 1000)
    expect(naive).toBe(19_992)
    expect(naive).not.toBe(line.grossCents)
  })
})

describe('promotion scope precedence', () => {
  // Narrower wins: VARIANT > PRODUCT > CATEGORY > PRICE_GROUP.
  it.each([
    ['variant beats all', ['VARIANT', 'PRODUCT', 'CATEGORY', 'PRICE_GROUP'], 'v'],
    ['product beats category', ['PRODUCT', 'CATEGORY', 'PRICE_GROUP'], 'p'],
    ['category beats price group', ['CATEGORY', 'PRICE_GROUP'], 'c'],
    ['price group applies alone', ['PRICE_GROUP'], 'g'],
  ])('%s', async (_label, scopes) => {
    const targets: Record<string, Record<string, string>> = {
      VARIANT: { variantId },
      PRODUCT: { productId: strain.id },
      CATEGORY: { categoryId: flowerCategory.id },
      PRICE_GROUP: { priceGroupId: group.id },
    }
    const tag: Record<string, string> = {
      VARIANT: 'v',
      PRODUCT: 'p',
      CATEGORY: 'c',
      PRICE_GROUP: 'g',
    }

    for (const scope of scopes) {
      await makePromotion({
        name: tag[scope]!,
        scopeType: scope as PromotionScope,
        discountType: DiscountType.AMOUNT_OFF,
        value: 100,
        ...targets[scope],
      })
    }

    const line = await priceWeight(WEIGHT.EIGHTH)
    expect(line.appliedPromotions).toHaveLength(1)
    expect(line.appliedPromotions[0]!.name).toBe(tag[scopes[0]!]!)
    // The losers are reported, not silently dropped.
    expect(line.rejectedPromotions).toHaveLength(scopes.length - 1)
  })

  it('reaches a product through an ANCESTOR category', async () => {
    // The promo is on Inhalables; Blue Dream is filed on Flower, a child of it.
    await makePromotion({
      name: 'Inhalables 10%',
      scopeType: PromotionScope.CATEGORY,
      discountType: DiscountType.PERCENT_OFF,
      value: 1000,
      categoryId: inhalables.id,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    expect(line.appliedPromotions[0]!.name).toBe('Inhalables 10%')
    expect(line.netCents).toBe(2700)
  })
})

describe('promotion windows and flags', () => {
  const cases = [
    ['expired', { startsAt: new Date('2020-01-01'), endsAt: new Date('2020-06-01') }],
    ['future-dated', { startsAt: new Date('2099-01-01') }],
    ['inactive', { active: false }],
  ] as const

  it.each(cases)('a %s promotion does not apply', async (_label, overrides) => {
    await makePromotion({
      name: 'Nope',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
      ...overrides,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    expect(line.appliedPromotions).toHaveLength(0)
    expect(line.netCents).toBe(3000)
  })

  it('an open-ended promotion with no endsAt still applies', async () => {
    await makePromotion({
      name: 'Forever',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
      endsAt: null,
    })
    expect((await priceWeight(WEIGHT.EIGHTH)).netCents).toBe(2500)
  })

  it('honours an admin pricing at another instant', async () => {
    await makePromotion({
      name: 'Scheduled',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
      startsAt: new Date('2099-01-01'),
    })

    const now = await priceWeight(WEIGHT.EIGHTH)
    expect(now.netCents).toBe(3000)

    const later = await quote({
      storeId: storeA.id,
      lines: [{ variantId, quantityBase: WEIGHT.EIGHTH }],
      at: new Date('2099-06-01'),
    })
    expect(later.lines[0]!.netCents).toBe(2500)
  })
})

describe('store scope', () => {
  it('a promotion scoped to one store does not apply at another', async () => {
    await makePromotion({
      name: 'Alpha only',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
      storeIds: [storeA.id],
    })

    expect((await priceWeight(WEIGHT.EIGHTH, storeA.id)).netCents).toBe(2500)
    expect((await priceWeight(WEIGHT.EIGHTH, storeB.id)).netCents).toBe(3000)
  })

  it('a promotion with no store rows applies everywhere', async () => {
    await makePromotion({
      name: 'Chain-wide',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
    })

    expect((await priceWeight(WEIGHT.EIGHTH, storeA.id)).netCents).toBe(2500)
    expect((await priceWeight(WEIGHT.EIGHTH, storeB.id)).netCents).toBe(2500)
  })
})

describe('stacking — best outcome for the customer', () => {
  it('charges the single non-stackable when it beats the stack', async () => {
    await makePromotion({
      name: '10% off flower',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.PERCENT_OFF,
      value: 1000,
      priceGroupId: group.id,
      stackable: true,
    })
    await makePromotion({
      name: '$5 off Blue Dream',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
      stackable: false,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    // $30.00 -> single takes $5.00 = $25.00; stack takes 10% = $27.00. Single wins.
    expect(line.netCents).toBe(2500)
    expect(line.promotionStrategy).toBe('single-non-stackable')
    expect(line.appliedPromotions.map((p) => p.name)).toEqual(['$5 off Blue Dream'])
    expect(line.rejectedPromotions.map((p) => p.name)).toEqual(['10% off flower'])
  })

  it('charges the stack when the stack beats the single', async () => {
    await makePromotion({
      name: '25% off flower',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.PERCENT_OFF,
      value: 2500,
      priceGroupId: group.id,
      stackable: true,
    })
    await makePromotion({
      name: '$5 off Blue Dream',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 500,
      productId: strain.id,
      stackable: false,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    // Stack takes 25% = $22.50, which beats $25.00.
    expect(line.netCents).toBe(2250)
    expect(line.promotionStrategy).toBe('stacked')
    expect(line.rejectedPromotions.map((p) => p.name)).toEqual(['$5 off Blue Dream'])
  })

  it('applies several stackables sequentially, narrowest scope first', async () => {
    await makePromotion({
      name: '10% off flower',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.PERCENT_OFF,
      value: 1000,
      priceGroupId: group.id,
      stackable: true,
    })
    await makePromotion({
      name: '$3 off Blue Dream',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 300,
      productId: strain.id,
      stackable: true,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    // Product scope is narrower, so it runs first: $30.00 - $3.00 = $27.00, then 10% of
    // $27.00 = $2.70, giving $24.30. Sequential, not additive.
    expect(line.appliedPromotions.map((p) => p.name)).toEqual([
      '$3 off Blue Dream',
      '10% off flower',
    ])
    expect(line.appliedPromotions.map((p) => p.discountCents)).toEqual([300, 270])
    expect(line.netCents).toBe(2430)
  })

  it('ties go to the single promotion — fewer moving parts for the same money', async () => {
    await makePromotion({
      name: 'stackable 10%',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.PERCENT_OFF,
      value: 1000,
      priceGroupId: group.id,
      stackable: true,
    })
    await makePromotion({
      name: 'single $3',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.AMOUNT_OFF,
      value: 300,
      productId: strain.id,
      stackable: false,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    expect(line.netCents).toBe(2700)
    expect(line.promotionStrategy).toBe('single-non-stackable')
  })

  it('never drives a line below zero, however many promotions pile on', async () => {
    for (const [i, value] of [2000, 2000, 2000].entries()) {
      await makePromotion({
        name: `big ${i}`,
        scopeType: PromotionScope.PRICE_GROUP,
        discountType: DiscountType.AMOUNT_OFF,
        value,
        priceGroupId: group.id,
        stackable: true,
      })
    }
    const line = await priceWeight(WEIGHT.EIGHTH)
    expect(line.netCents).toBe(0)
    expect(line.discountCents).toBe(3000)
  })
})

describe('OVERRIDE_PRICE_PER_GRAM', () => {
  it('replaces the rate rather than discounting the result', async () => {
    await makePromotion({
      name: 'Strain deal $7/g',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.OVERRIDE_PRICE_PER_GRAM,
      value: 700,
      productId: strain.id,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    // 700 c/g over 3.5g, not the $30.00 tier.
    expect(line.grossCents).toBe(2450)
    expect(line.pricePerGramCents).toBe(700)
    expect(line.appliedTierId).toBeNull()
  })

  it('runs BEFORE a percentage, so the percentage applies to the overridden rate', async () => {
    await makePromotion({
      name: 'Strain deal $7/g',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.OVERRIDE_PRICE_PER_GRAM,
      value: 700,
      productId: strain.id,
      stackable: true,
    })
    await makePromotion({
      name: '10% off flower',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.PERCENT_OFF,
      value: 1000,
      priceGroupId: group.id,
      stackable: true,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    // $24.50 base after the override, then 10% off it = $22.05. Applying the percentage
    // to the pre-override $30.00 and then overriding would throw that number away.
    expect(line.grossCents).toBe(2450)
    expect(line.netCents).toBe(2205)
  })

  it('is reported as inapplicable on an EACH variant, not silently ignored', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const gummies = await makeProduct({
      name: 'Gummies',
      categoryId: edible.id,
      priceCents: 2000,
    })
    await makePromotion({
      name: 'Bad override',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.OVERRIDE_PRICE_PER_GRAM,
      value: 700,
      productId: gummies.id,
    })

    const result = await quote({
      storeId: storeA.id,
      lines: [{ variantId: gummies.variants[0]!.id, quantityBase: 1 }],
    })
    const line = result.lines[0]!
    expect(line.grossCents).toBe(2000)
    expect(line.appliedPromotions).toHaveLength(0)
    expect(line.rejectedPromotions).toEqual([
      expect.objectContaining({
        name: 'Bad override',
        reason: 'not-applicable-to-tracking-mode',
      }),
    ])
  })

  it('applies only the narrowest override when two compete', async () => {
    await makePromotion({
      name: 'group $9/g',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.OVERRIDE_PRICE_PER_GRAM,
      value: 900,
      priceGroupId: group.id,
      stackable: true,
    })
    await makePromotion({
      name: 'strain $7/g',
      scopeType: PromotionScope.PRODUCT,
      discountType: DiscountType.OVERRIDE_PRICE_PER_GRAM,
      value: 700,
      productId: strain.id,
      stackable: true,
    })

    const line = await priceWeight(WEIGHT.EIGHTH)
    expect(line.pricePerGramCents).toBe(700)
    expect(line.rejectedPromotions.map((p) => p.name)).toContain('group $9/g')
  })
})

describe('EACH pricing', () => {
  it('multiplies the unit price by the count', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const gummies = await makeProduct({
      name: 'Gummies',
      categoryId: edible.id,
      priceCents: 1999,
    })

    const result = await quote({
      storeId: storeA.id,
      lines: [{ variantId: gummies.variants[0]!.id, quantityBase: 3 }],
    })
    expect(result.lines[0]!.grossCents).toBe(5997)
    expect(result.lines[0]!.unitPriceCents).toBe(1999)
    expect(result.lines[0]!.pricePerGramCents).toBeNull()
  })
})

describe('manual discounts', () => {
  it('applies a line discount after promotions', async () => {
    await makePromotion({
      name: '10% off flower',
      scopeType: PromotionScope.PRICE_GROUP,
      discountType: DiscountType.PERCENT_OFF,
      value: 1000,
      priceGroupId: group.id,
    })

    const result = await quote({
      storeId: storeA.id,
      lines: [
        {
          variantId,
          quantityBase: WEIGHT.EIGHTH,
          manualDiscount: { discountType: DiscountType.AMOUNT_OFF, value: 200 },
        },
      ],
    })
    // $30.00 -> 10% = $27.00 -> $2.00 manual = $25.00.
    expect(result.lines[0]!.netCents).toBe(2500)
    expect(result.lines[0]!.manualDiscountCents).toBe(200)
  })

  it('splits an order discount across lines so the parts sum to exactly the discount', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const a = await makeProduct({ name: 'A', categoryId: edible.id, priceCents: 333 })
    const b = await makeProduct({ name: 'B', categoryId: edible.id, priceCents: 333 })
    const c = await makeProduct({ name: 'C', categoryId: edible.id, priceCents: 334 })

    const result = await quote({
      storeId: storeA.id,
      lines: [
        { variantId: a.variants[0]!.id, quantityBase: 1 },
        { variantId: b.variants[0]!.id, quantityBase: 1 },
        { variantId: c.variants[0]!.id, quantityBase: 1 },
      ],
      orderDiscount: { discountType: DiscountType.AMOUNT_OFF, value: 100 },
    })

    const shares = result.lines.map((l) => l.orderDiscountCents)
    expect(shares.reduce((x, y) => x + y, 0)).toBe(100)
    expect(result.netCents).toBe(900)
    expect(result.subtotalCents).toBe(1000)
    expect(result.discountCents).toBe(100)
  })

  it('caps a percentage order discount at the order total', async () => {
    const result = await quote({
      storeId: storeA.id,
      lines: [{ variantId, quantityBase: WEIGHT.EIGHTH }],
      orderDiscount: { discountType: DiscountType.PERCENT_OFF, value: 10_000 },
    })
    expect(result.netCents).toBe(0)
    expect(result.discountCents).toBe(3000)
  })
})

describe('cost visibility', () => {
  it('a quote carries no cost field anywhere in the payload', async () => {
    const withCost = await makeWeightProduct({
      name: 'Costly Strain',
      categoryId: flowerCategory.id,
      priceGroupId: group.id,
      costCents: 500,
    })

    const result = await quote({
      storeId: storeA.id,
      lines: [{ variantId: withCost.variants[0]!.id, quantityBase: WEIGHT.GRAM }],
    })

    // The quote is a customer-facing price. Cost has no business in it for ANY principal,
    // so unlike the catalog this is not role-dependent — it is simply never selected.
    expect(findCostKeys(result)).toEqual([])
  })
})

describe('line validation', () => {
  it('rejects a zero or negative quantity', async () => {
    await expect(
      quote({ storeId: storeA.id, lines: [{ variantId, quantityBase: 0 }] }),
    ).rejects.toThrow()
  })

  it('rejects an unknown variant', async () => {
    await expect(
      quote({ storeId: storeA.id, lines: [{ variantId: 'cmsu0000000000000000000a', quantityBase: 1 }] }),
    ).rejects.toThrow()
  })

  it('rejects an empty cart', async () => {
    await expect(quote({ storeId: storeA.id, lines: [] })).rejects.toThrow()
  })
})

describe('tracking mode is never mixed', () => {
  it('prices a cart holding both an EACH and a WEIGHT line', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const gummies = await makeProduct({
      name: 'Gummies',
      categoryId: edible.id,
      priceCents: 2000,
    })

    const result = await quote({
      storeId: storeA.id,
      lines: [
        { variantId, quantityBase: WEIGHT.EIGHTH },
        { variantId: gummies.variants[0]!.id, quantityBase: 2 },
      ],
    })

    expect(result.lines[0]!.trackingMode).toBe(TrackingMode.WEIGHT)
    expect(result.lines[0]!.grossCents).toBe(3000)
    expect(result.lines[1]!.trackingMode).toBe(TrackingMode.EACH)
    expect(result.lines[1]!.grossCents).toBe(4000)
    expect(result.subtotalCents).toBe(7000)
  })
})


/**
 * The price list behind /admin/pricing. It must agree with `quote` cent for cent on the
 * ladder itself, and must NOT apply promotions — a shelf price list that moved whenever a
 * promo ran would be unreadable, and would disagree with the printed tag.
 */
describe('the price ladder', () => {
  it('charges what the quote charges, at every tier and in between', async () => {
    const weights = [1_000, 3_500, 5_000, 7_000, 14_000, 28_000]
    const rows = await priceLadder(group.id, weights)

    for (const row of rows) {
      const line = await priceWeight(row.quantityBase)
      expect(
        { at: row.quantityBase, total: row.totalCents },
        `ladder and quote disagree at ${row.quantityBase}mg`,
      ).toEqual({ at: row.quantityBase, total: line.grossCents })
    }

    // The figures the house rules documents, pinned here so a refactor cannot quietly move them.
    const by = new Map(rows.map((r) => [r.quantityBase, r]))
    expect(by.get(1_000)!.totalCents).toBe(10_00)
    expect(by.get(3_500)!.totalCents).toBe(30_00) // the typed total at the threshold
    expect(by.get(5_000)!.totalCents).toBe(42_85)
    expect(by.get(7_000)!.totalCents).toBe(55_00)
    expect(by.get(14_000)!.totalCents).toBe(110_04) // derived rate, not 2 x $55.00
    expect(by.get(28_000)!.totalCents).toBe(200_00)
  })

  it('marks which rows are real tiers and which are illustrative', async () => {
    const rows = await priceLadder(group.id, [500, 1_000, 3_500, 7_000, 14_000, 28_000])
    const by = new Map(rows.map((r) => [r.quantityBase, r]))

    // Half a gram is below every tier in this ladder, so it prices at the group base rate
    // and carries no tier at all. This is the row the screen labels "base rate".
    expect(by.get(500)!.tierId).toBeNull()
    expect(by.get(500)!.isTierThreshold).toBe(false)
    expect(by.get(500)!.totalCents).toBe(5_00)

    // 1g IS a stored tier in this ladder, even though its rate equals the base rate —
    // which is exactly why the screen must read isTierThreshold rather than guess from
    // the price.
    expect(by.get(1_000)!.isTierThreshold).toBe(true)
    expect(by.get(1_000)!.tierId).not.toBeNull()
    expect(by.get(3_500)!.isTierThreshold).toBe(true)
    expect(by.get(28_000)!.isTierThreshold).toBe(true)

    // 14g sits INSIDE the quarter tier: same tier id, but not a threshold — which is what
    // lets the screen grey it out as illustrative rather than showing a Remove button.
    expect(by.get(14_000)!.tierId).toBe(by.get(7_000)!.tierId)
    expect(by.get(14_000)!.isTierThreshold).toBe(false)
    expect(by.get(7_000)!.isTierThreshold).toBe(true)
  })

  it('reports the saving against the base rate in basis points', async () => {
    const rows = await priceLadder(group.id, [1_000, 3_500, 28_000])
    const by = new Map(rows.map((r) => [r.quantityBase, r]))

    expect(by.get(1_000)!.savingBps).toBe(0) // the base rate is not a saving on itself
    // $8.57 against a $10.00 base is 14.3% off.
    expect(by.get(3_500)!.savingBps).toBe(1430)
    // $7.14 against $10.00 is 28.6% off.
    expect(by.get(28_000)!.savingBps).toBe(2860)
  })

  it('ignores promotions, so the shelf list never moves when a promo runs', async () => {
    await makePromotion({
      name: 'Half off flower',
      scopeType: PromotionScope.PRICE_GROUP,
      priceGroupId: group.id,
      discountType: DiscountType.PERCENT_OFF,
      value: 5000,
    })

    // The register genuinely charges half — that is the promo working.
    const line = await priceWeight(3_500)
    expect(line.netCents).toBe(15_00)

    // The price list still says $30.00, because that is what the shelf tag says.
    const rows = await priceLadder(group.id, [3_500])
    expect(rows[0]!.totalCents).toBe(30_00)
  })

  it('de-duplicates and sorts the weights it is asked for', async () => {
    const rows = await priceLadder(group.id, [28_000, 3_500, 3_500, 1_000])
    expect(rows.map((r) => r.quantityBase)).toEqual([1_000, 3_500, 28_000])
  })

  it('prices a group with no tiers at all against its base rate', async () => {
    const bare = await makePriceGroup('Shake', 'shake', 600, [])
    const rows = await priceLadder(bare.id, [1_000, 28_000])
    expect(rows[0]!.totalCents).toBe(6_00)
    expect(rows[1]!.totalCents).toBe(168_00)
    expect(rows.every((r) => r.tierId === null)).toBe(true)
  })
})
