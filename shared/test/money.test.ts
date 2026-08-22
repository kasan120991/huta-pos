import { describe, expect, it } from 'vitest'

import { bps, cents, unsafe } from '../src/brand.js'
import {
  addCents,
  applyBps,
  clampCents,
  formatCents,
  negateCents,
  parseDollarsToCents,
  subCents,
  subtractBps,
  sumCents,
} from '../src/money.js'
import { unwrapOrThrow } from '../src/result.js'

describe('applyBps', () => {
  it('rounds the canonical tax case up', () => {
    // 8.25% of $10.00 is exactly 82.5 cents; half-up makes it 83.
    expect(applyBps(cents(1000), bps(825))).toBe(83)
  })

  it('is symmetric across zero, so a refund returns exactly what was charged', () => {
    // Negating through 0 rather than writing `-x`, because the implementation
    // deliberately normalises -0 to 0 and Object.is would flag the difference.
    const negate = (n: number): number => (n === 0 ? 0 : -n)
    for (let amount = 0; amount <= 50_000; amount += 37) {
      expect(applyBps(unsafe.cents(-amount), bps(825))).toBe(
        negate(applyBps(cents(amount), bps(825))),
      )
    }
  })

  it.each([
    [1000, 0, 0],
    [1000, 10_000, 1000],
    [1999, 825, 165],
    [1, 5000, 1],
    [1, 4999, 0],
  ])('applyBps(%i, %i) === %i', (amount, rate, expected) => {
    expect(applyBps(cents(amount), bps(rate))).toBe(expected)
  })

  it('subtractBps leaves the remainder consistent with the discount shown', () => {
    const gross = cents(1999)
    const discount = applyBps(gross, bps(1500))
    expect(subtractBps(gross, bps(1500))).toBe(gross - discount)
  })
})

describe('arithmetic', () => {
  it('sums an empty collection to zero, not NaN', () => {
    expect(sumCents([])).toBe(0)
  })

  it('handles a large collection without blowing the stack', () => {
    const many = Array.from({ length: 50_000 }, () => cents(3))
    expect(sumCents(many)).toBe(150_000)
  })

  it('addCents / subCents / negateCents', () => {
    expect(addCents(cents(100), cents(250))).toBe(350)
    expect(subCents(cents(350), cents(100))).toBe(250)
    expect(Object.is(negateCents(cents(0)), 0)).toBe(true)
    expect(negateCents(cents(500))).toBe(-500)
  })

  it('clampCents bounds both ways', () => {
    expect(clampCents(cents(500), cents(100), cents(300))).toBe(300)
    expect(clampCents(cents(50), cents(100), cents(300))).toBe(100)
    expect(clampCents(cents(200), cents(100), cents(300))).toBe(200)
  })
})

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [50, '$0.50'],
    [1999, '$19.99'],
    [-1999, '-$19.99'],
    [100_000, '$1,000.00'],
    [123_456_789, '$1,234,567.89'],
  ])('formats %i as %s', (amount, expected) => {
    expect(formatCents(unsafe.cents(amount))).toBe(expected)
  })

  it('can omit the symbol', () => {
    expect(formatCents(cents(1999), { showSymbol: false })).toBe('19.99')
  })
})

describe('parseDollarsToCents', () => {
  it.each([
    ['19.99', 1999],
    ['$1,234.56', 123_456],
    ['.5', 50],
    ['0', 0],
    ['-5.00', -500],
    ['  12.30  ', 1230],
    ['7', 700],
  ])('parses %s to %i', (input, expected) => {
    expect(unwrapOrThrow(parseDollarsToCents(input))).toBe(expected)
  })

  // These specific values break under `parseFloat(s) * 100`, which is why the parser
  // works on the decimal digits instead.
  it.each([
    ['1.15', 115],
    ['8.15', 815],
    ['1.005', null],
  ])('float-trap regression: %s', (input, expected) => {
    const result = parseDollarsToCents(input)
    if (expected === null) {
      expect(result.ok).toBe(false)
    } else {
      expect(unwrapOrThrow(result)).toBe(expected)
    }
  })

  it.each([
    ['', 'EMPTY'],
    ['1.005', 'TOO_PRECISE'],
    ['19.999', 'TOO_PRECISE'],
    ['abc', 'MALFORMED'],
    ['1e3', 'MALFORMED'],
    ['Infinity', 'MALFORMED'],
    ['NaN', 'MALFORMED'],
    ['1.2.3', 'MALFORMED'],
  ])('rejects %s with code %s', (input, code) => {
    const result = parseDollarsToCents(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(code)
  })
})

describe('constructors', () => {
  it('reject non-integers', () => {
    expect(() => cents(1.5)).toThrow()
    expect(() => bps(-1)).toThrow()
    expect(() => bps(10_001)).toThrow()
  })
})
