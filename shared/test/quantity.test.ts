import { describe, expect, it } from 'vitest'

import { baseDelta, baseQuantity, unsafe } from '../src/brand.js'
import { TrackingMode } from '../src/enums.js'
import {
  WEIGHT,
  baseToGrams,
  formatGrams,
  formatQuantity,
  gramsToBase,
  parseGramsToBase,
  sumBase,
} from '../src/quantity.js'
import { unwrapOrThrow } from '../src/result.js'

describe('WEIGHT constants', () => {
  // Pins the decision that a "pound" here is 16 retail ounces (448.00g), NOT the
  // avoirdupois pound of 453.592g. Mixing the two conventions puts a 5.592g gap into
  // every flower reconciliation as phantom shrinkage.
  it('is internally consistent — a pound is exactly 16 ounces', () => {
    expect(WEIGHT.OUNCE * 16).toBe(WEIGHT.POUND)
    expect(WEIGHT.OUNCE / 2).toBe(WEIGHT.HALF_OUNCE)
    expect(WEIGHT.QUARTER * 2).toBe(WEIGHT.HALF_OUNCE)
    expect(WEIGHT.EIGHTH * 2).toBe(WEIGHT.QUARTER)
  })
})

describe('parseGramsToBase', () => {
  it.each([
    ['0', 0],
    ['1', 1000],
    ['3.5', 3500],
    ['3.50', 3500],
    ['3.05', 3050],
    ['0.01', 10],
    ['.5', 500],
    ['03.50', 3500],
    ['  3.5  ', 3500],
    ['28', 28_000],
  ])('parses %s to %i', (input, expected) => {
    expect(unwrapOrThrow(parseGramsToBase(input))).toBe(expected)
  })

  // 3.53 * 1000 is 3530.0000000000005 in IEEE 754. The parser reads decimal digits
  // instead of multiplying, so these are exact.
  it.each([
    ['3.53', 3530],
    ['0.07', 70],
    ['0.29', 290],
    ['8.15', 8150],
  ])('float-trap regression: %s parses to exactly %i', (input, expected) => {
    expect(unwrapOrThrow(parseGramsToBase(input))).toBe(expected)
  })

  it.each([
    ['', 'EMPTY'],
    ['3.456', 'TOO_PRECISE'],
    ['3.4567', 'TOO_PRECISE'],
    // Documents a real consequence of the 2-decimal rule: an avoirdupois pound is not
    // enterable. It does not need to be — WEIGHT.POUND is 448g, which is.
    ['453.592', 'TOO_PRECISE'],
    ['3.', 'MALFORMED'],
    ['-1', 'MALFORMED'],
    ['1,5', 'MALFORMED'],
    ['3.5g', 'MALFORMED'],
    ['abc', 'MALFORMED'],
    ['1e3', 'MALFORMED'],
    ['Infinity', 'MALFORMED'],
    ['NaN', 'MALFORMED'],
    ['０.５', 'MALFORMED'],
  ])('rejects %s with code %s', (input, code) => {
    const result = parseGramsToBase(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(code)
  })

  // The core guarantee: no drift anywhere in the range a person can actually enter.
  // Collects mismatches rather than asserting 100k times — an assertion per iteration is
  // orders of magnitude slower than the arithmetic being tested.
  it('round-trips every enterable 2-decimal weight with zero drift', () => {
    const mismatches: string[] = []

    for (let hundredths = 0; hundredths <= 99_999; hundredths++) {
      const whole = Math.trunc(hundredths / 100)
      const fraction = String(hundredths % 100).padStart(2, '0')
      const input = `${whole}.${fraction}`

      const parsed = parseGramsToBase(input)
      if (!parsed.ok) {
        mismatches.push(`${input} failed to parse: ${parsed.code}`)
        continue
      }
      if (parsed.value !== hundredths * 10) {
        mismatches.push(`${input} parsed to ${parsed.value}, expected ${hundredths * 10}`)
      }
      const formatted = formatGrams(parsed.value, { suffix: false })
      const expected = `${whole.toLocaleString('en-US')}.${fraction}`
      if (formatted !== expected) {
        mismatches.push(`${input} formatted as ${formatted}, expected ${expected}`)
      }
    }

    expect(mismatches.slice(0, 10)).toEqual([])
    expect(mismatches).toHaveLength(0)
  })
})

describe('gramsToBase / baseToGrams', () => {
  it.each([
    [1, 1000],
    [3.5, 3500],
    [0.01, 10],
    [28, 28_000],
    [3.53, 3530],
  ])('gramsToBase(%f) === %i', (grams, expected) => {
    expect(gramsToBase(grams)).toBe(expected)
  })

  it('baseToGrams inverts for display', () => {
    expect(baseToGrams(baseQuantity(3500))).toBe(3.5)
    expect(baseToGrams(baseQuantity(10))).toBe(0.01)
  })
})

describe('formatGrams', () => {
  it.each([
    [3500, '3.50g'],
    [1000, '1.00g'],
    [0, '0.00g'],
    [28_000, '28.00g'],
    [448_000, '448.00g'],
    [5, '0.01g'],
    [4, '0.00g'],
  ])('formats %i as %s', (base, expected) => {
    expect(formatGrams(unsafe.baseQuantity(base))).toBe(expected)
  })

  // Movement deltas are negative for SALE / TRANSFER_OUT / SHRINKAGE. A naive
  // Math.trunc(-50 / 100) is -0, which would silently drop the sign on sub-gram deltas.
  it.each([
    [-3500, '-3.50g'],
    [-50, '-0.05g'],
    [-5, '-0.01g'],
  ])('keeps the sign on negative delta %i -> %s', (base, expected) => {
    expect(formatGrams(unsafe.baseQuantity(base))).toBe(expected)
  })

  it('is lossy above the display step, by design', () => {
    // 3456 mg is finer than the scale reads; it displays rounded and does not round-trip.
    expect(formatGrams(baseQuantity(3456))).toBe('3.46g')
    expect(unwrapOrThrow(parseGramsToBase('3.46'))).toBe(3460)
  })
})

describe('formatQuantity', () => {
  it('renders EACH as a bare count and WEIGHT as grams', () => {
    expect(formatQuantity(baseQuantity(2), TrackingMode.EACH)).toBe('2')
    expect(formatQuantity(baseQuantity(3500), TrackingMode.EACH)).toBe('3,500')
    expect(formatQuantity(baseQuantity(3500), TrackingMode.WEIGHT)).toBe('3.50g')
    expect(formatQuantity(baseDelta(-1), TrackingMode.EACH)).toBe('-1')
  })
})

describe('base arithmetic', () => {
  it('sums an empty collection to zero', () => {
    expect(sumBase([])).toBe(0)
  })

  it('rejects a negative non-delta quantity', () => {
    expect(() => baseQuantity(-1)).toThrow()
    expect(baseDelta(-1)).toBe(-1)
  })
})
