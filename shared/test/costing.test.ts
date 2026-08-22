import { describe, expect, it } from 'vitest'

import { UnitError } from '../src/brand.js'
import { costOutCents, receiptLineValueCents, unitCostFromBasis } from '../src/costing.js'
import { TrackingMode } from '../src/enums.js'
import { WEIGHT } from '../src/quantity.js'

describe('receiptLineValueCents — EACH', () => {
  it.each([
    [12, 250, 3000],
    [1, 1999, 1999],
    [0, 500, 0],
    [6, 0, 0],
  ])('%i items at %i cents === %i', (quantity, unitCost, expected) => {
    expect(receiptLineValueCents(TrackingMode.EACH, quantity, unitCost)).toBe(expected)
  })
})

describe('receiptLineValueCents — WEIGHT', () => {
  // Unit cost is per GRAM, quantity is in MILLIGRAMS. Multiplying without the /1000 gives
  // 1000x the real figure, which is the entire reason this function exists.
  it.each([
    [WEIGHT.GRAM, 400, 400],
    [WEIGHT.OUNCE, 400, 11_200],
    [WEIGHT.POUND, 400, 179_200],
    [WEIGHT.EIGHTH, 400, 1400],
  ])('%img at %i cents/g === %i cents', (quantity, unitCost, expected) => {
    expect(receiptLineValueCents(TrackingMode.WEIGHT, quantity, unitCost)).toBe(expected)
  })

  it('rounds half away from zero rather than truncating', () => {
    // 1500mg at 1 cent/g is 1.5 cents, which must land on 2 — truncation here would leak a
    // half cent out of the basis on every single flower line.
    expect(receiptLineValueCents(TrackingMode.WEIGHT, 1500, 1)).toBe(2)
    expect(receiptLineValueCents(TrackingMode.WEIGHT, 1499, 1)).toBe(1)
  })

  it('a pound at a realistic wholesale rate is a plausible number', () => {
    // Sanity check against the 1000x mistake: a pound at $4/g is $1,792, not $1.79m.
    expect(receiptLineValueCents(TrackingMode.WEIGHT, WEIGHT.POUND, 400)).toBe(179_200)
  })
})

describe('receiptLineValueCents — refusals', () => {
  it.each([
    [-1, 100],
    [3.5, 100],
    [10, -1],
    [10, 1.5],
  ])('refuses quantity %s at cost %s', (quantity, unitCost) => {
    expect(() => receiptLineValueCents(TrackingMode.EACH, quantity, unitCost)).toThrow(UnitError)
  })
})

describe('unitCostFromBasis', () => {
  it('inverts an EACH line', () => {
    const value = receiptLineValueCents(TrackingMode.EACH, 12, 250)
    expect(unitCostFromBasis(TrackingMode.EACH, value, 12)).toBe(250)
  })

  it('inverts a WEIGHT line back to cents per gram', () => {
    const value = receiptLineValueCents(TrackingMode.WEIGHT, WEIGHT.OUNCE, 400)
    expect(unitCostFromBasis(TrackingMode.WEIGHT, value, WEIGHT.OUNCE)).toBe(400)
  })

  it('blends two receipts at different costs', () => {
    // 28g at $4/g then 28g at $6/g is 56g valued at $5/g.
    const basis =
      receiptLineValueCents(TrackingMode.WEIGHT, WEIGHT.OUNCE, 400) +
      receiptLineValueCents(TrackingMode.WEIGHT, WEIGHT.OUNCE, 600)
    expect(unitCostFromBasis(TrackingMode.WEIGHT, basis, WEIGHT.OUNCE * 2)).toBe(500)
  })

  it.each([
    [null, 100],
    [5000, 0],
    [5000, -1],
  ])('returns null for basis %s over quantity %s', (basis, quantity) => {
    expect(unitCostFromBasis(TrackingMode.EACH, basis, quantity)).toBeNull()
  })

  it('does not floor a flower rate to zero', () => {
    // The basis in cents is far smaller than the milligram count, so dividing before
    // scaling to grams would round every realistic rate down to 0.
    expect(unitCostFromBasis(TrackingMode.WEIGHT, 11_200, WEIGHT.OUNCE)).toBe(400)
  })
})

describe('costOutCents', () => {
  it('takes a proportional share', () => {
    // Half the pool leaving takes half the value.
    expect(costOutCents(11_200, WEIGHT.OUNCE, WEIGHT.HALF_OUNCE)).toBe(5600)
  })

  it('takes the whole basis when the pool empties, leaving no residual', () => {
    expect(costOutCents(11_201, WEIGHT.OUNCE, WEIGHT.OUNCE)).toBe(11_201)
  })

  it('takes the whole basis when more is removed than is on hand', () => {
    // The service refuses to oversell, but the arithmetic must not leave a stranded basis
    // behind a zero quantity — that would read as an infinite unit cost on the next receive.
    expect(costOutCents(11_200, WEIGHT.OUNCE, WEIGHT.POUND)).toBe(11_200)
  })

  it('never returns more than the basis', () => {
    for (let out = 1; out <= 100; out += 1) {
      expect(costOutCents(101, 100, out)).toBeLessThanOrEqual(101)
    }
  })

  it.each([
    [null, 100, 10],
    [0, 100, 10],
    [5000, 0, 10],
  ])('returns 0 for basis %s, on hand %s, out %s', (basis, onHand, out) => {
    expect(costOutCents(basis, onHand, out)).toBe(0)
  })

  it('round-trips a full receive-then-sell cycle to exactly zero', () => {
    // Plain numbers here on purpose: `-=` on a branded Cents loses the brand, which is
    // exactly the arithmetic the house rules routes through helpers in real code.
    let remaining: number = receiptLineValueCents(TrackingMode.WEIGHT, WEIGHT.POUND, 437)
    let onHand: number = WEIGHT.POUND

    // Sell it down in gram increments, the way flower actually leaves the shelf.
    while (onHand > 0) {
      const out = Math.min(WEIGHT.GRAM, onHand)
      remaining -= costOutCents(remaining, onHand, out)
      onHand -= out
    }

    expect(onHand).toBe(0)
    expect(remaining).toBe(0)
  })
})
