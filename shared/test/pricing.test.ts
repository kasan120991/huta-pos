import { describe, expect, it } from 'vitest'

import { UnitError, baseQuantity, cents, centsPerGram, unsafe } from '../src/brand.js'
import {
  allocateProportional,
  clampToZero,
  derivePerGramRate,
  extendPerGram,
  extendTier,
} from '../src/pricing.js'
import { WEIGHT } from '../src/quantity.js'

/** The placeholder tier table from the house rules. Real numbers pending. */
const TIERS = [
  { minQuantityBase: baseQuantity(WEIGHT.GRAM), totalPriceCents: cents(1000) },
  { minQuantityBase: baseQuantity(WEIGHT.EIGHTH), totalPriceCents: cents(3000) },
  { minQuantityBase: baseQuantity(WEIGHT.QUARTER), totalPriceCents: cents(5500) },
  { minQuantityBase: baseQuantity(WEIGHT.OUNCE), totalPriceCents: cents(20_000) },
] as const

describe('extendPerGram', () => {
  it.each([
    [857, 3500, 3000],
    [857, 5000, 4285],
    [1000, 1000, 1000],
    [857, 1, 1],
    [857, 0, 0],
  ])('extendPerGram(%i, %i) === %i', (rate, quantity, expected) => {
    expect(extendPerGram(centsPerGram(rate), baseQuantity(quantity))).toBe(expected)
  })

  it('matches the documented worked example — 5g at the eighth rate is $42.85', () => {
    expect(extendPerGram(centsPerGram(857), baseQuantity(5000))).toBe(4285)
  })
})

describe('derivePerGramRate', () => {
  it.each([
    [3000, 3500, 857],
    [5500, 7000, 786],
    [20_000, 28_000, 714],
    [1000, 1000, 1000],
  ])('derivePerGramRate(%i, %i) === %i', (total, threshold, expected) => {
    expect(derivePerGramRate(cents(total), baseQuantity(threshold))).toBe(expected)
  })

  it('rejects a zero or negative threshold', () => {
    expect(() => derivePerGramRate(cents(3000), baseQuantity(0))).toThrow()
  })
})

describe('extendTier', () => {
  // The bug this branch fixes. Deriving a whole-cent rate and multiplying back does not
  // round-trip: only the eighth happens to reconcile, which is why the the house rules worked
  // example looked correct. An admin who types $200 must see $200.
  it.each([
    [WEIGHT.GRAM, 1000],
    [WEIGHT.EIGHTH, 3000],
    [WEIGHT.QUARTER, 5500],
    [WEIGHT.OUNCE, 20_000],
  ])('charges the typed total exactly at threshold %i', (threshold, total) => {
    const tier = { minQuantityBase: baseQuantity(threshold), totalPriceCents: cents(total) }
    expect(extendTier(tier, baseQuantity(threshold))).toBe(total)
  })

  it('would have been wrong without the exact-match branch', () => {
    // Documents the actual failure mode, so nobody "simplifies" the branch away.
    const quarter = TIERS[2]
    const ounce = TIERS[3]
    const naiveQuarter = extendPerGram(
      derivePerGramRate(quarter.totalPriceCents, quarter.minQuantityBase),
      quarter.minQuantityBase,
    )
    const naiveOunce = extendPerGram(
      derivePerGramRate(ounce.totalPriceCents, ounce.minQuantityBase),
      ounce.minQuantityBase,
    )
    expect(naiveQuarter).toBe(5502) // $55.02, not $55.00
    expect(naiveOunce).toBe(19_992) // $199.92, not $200.00
    expect(extendTier(quarter, quarter.minQuantityBase)).toBe(5500)
    expect(extendTier(ounce, ounce.minQuantityBase)).toBe(20_000)
  })

  it('uses the derived rate above the threshold', () => {
    const eighth = TIERS[1]
    expect(extendTier(eighth, baseQuantity(5000))).toBe(4285)
  })

  it.each(TIERS.map((t) => [t.minQuantityBase, t.totalPriceCents] as const))(
    'is well-defined at threshold %i, and either side of it',
    (threshold, total) => {
      const tier = { minQuantityBase: baseQuantity(threshold), totalPriceCents: cents(total) }
      const below = extendTier(tier, baseQuantity(threshold - 10))
      const at = extendTier(tier, baseQuantity(threshold))
      const above = extendTier(tier, baseQuantity(threshold + 10))
      expect(below).toBeLessThanOrEqual(at)
      expect(at).toBeLessThanOrEqual(above)
    },
  )

  it('is monotonic — more weight never costs less', () => {
    for (const tier of TIERS) {
      let previous = -1
      // `q` is a plain number on purpose: incrementing a BaseQuantity loses the brand,
      // which is exactly what the brand is for. Re-brand at the call.
      for (let q: number = tier.minQuantityBase; q <= tier.minQuantityBase + 20_000; q += 10) {
        const price = extendTier(tier, baseQuantity(q))
        expect(price).toBeGreaterThanOrEqual(previous)
        previous = price
      }
    }
  })
})

describe('allocateProportional', () => {
  it('returns parts that sum to exactly the total', () => {
    // The reason this function exists. Rounding each share independently gives
    // 33 + 33 + 33 = 99 against a $1.00 order discount, so the receipt is a cent light.
    const parts = allocateProportional(cents(100), [cents(1000), cents(1000), cents(1000)])
    expect(parts).toEqual([34, 33, 33])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('splits in proportion to the weights', () => {
    const parts = allocateProportional(cents(1000), [cents(7500), cents(2500)])
    expect(parts).toEqual([750, 250])
  })

  it('hands leftover cents to the largest remainders, earliest line first on a tie', () => {
    // 10c across 3 equal lines: 3 each, one left over, and it goes to line 0.
    expect(allocateProportional(cents(10), [cents(1), cents(1), cents(1)])).toEqual([4, 3, 3])
  })

  it.each([
    [1, [cents(1), cents(1), cents(1)]],
    [7, [cents(333), cents(333), cents(334)]],
    [9999, [cents(1), cents(99_999)]],
    [12_345, [cents(4001), cents(4002), cents(4003), cents(1)]],
  ])('sums to the total for %i across %j', (total, weights) => {
    const parts = allocateProportional(cents(total), weights)
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
    expect(parts.every((p) => p >= 0)).toBe(true)
  })

  it('never allocates more to a line than the line is worth in the degenerate case', () => {
    // A 100% order discount must take each line to exactly zero, not overshoot one.
    const weights = [cents(999), cents(1), cents(500)]
    const parts = allocateProportional(cents(1500), weights)
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1500)
    parts.forEach((part, i) => expect(part).toBeLessThanOrEqual(weights[i]!))
  })

  it('returns zeros for a zero total and an empty array for no lines', () => {
    expect(allocateProportional(cents(0), [cents(10), cents(20)])).toEqual([0, 0])
    expect(allocateProportional(cents(100), [])).toEqual([])
  })

  it('refuses to allocate across lines that are all already free', () => {
    // Spreading a discount over zero-value lines would invent money never charged.
    expect(() => allocateProportional(cents(100), [cents(0), cents(0)])).toThrow(UnitError)
  })

  it('refuses a negative total or negative weights', () => {
    expect(() => allocateProportional(unsafe.cents(-1), [cents(10)])).toThrow(UnitError)
    expect(() => allocateProportional(cents(10), [unsafe.cents(-5)])).toThrow(UnitError)
  })
})

describe('clampToZero', () => {
  it.each([
    [50, 50],
    [0, 0],
    [-1, 0],
    [-999, 0],
  ])('clamps %i to %i', (input, expected) => {
    expect(clampToZero(unsafe.cents(input))).toBe(expected)
  })
})
