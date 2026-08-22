import { describe, expect, it } from 'vitest'

import { divRoundHalfUp, roundHalfUp } from '../src/math.js'

describe('roundHalfUp', () => {
  it.each([
    [0.5, 1],
    [1.5, 2],
    [2.5, 3],
    [1.4, 1],
    [1.6, 2],
    [0, 0],
  ])('rounds %f up to %i', (input, expected) => {
    expect(roundHalfUp(input)).toBe(expected)
  })

  // Math.round(-2.5) is -2. Half-away-from-zero is what makes a refund return exactly
  // what was charged, so these cases are the whole reason this function exists.
  it.each([
    [-0.5, -1],
    [-1.5, -2],
    [-2.5, -3],
    [-1.4, -1],
  ])('rounds %f away from zero to %i', (input, expected) => {
    expect(roundHalfUp(input)).toBe(expected)
  })

  it('never returns -0', () => {
    expect(Object.is(roundHalfUp(-0.2), 0)).toBe(true)
    expect(Object.is(roundHalfUp(-0.4), 0)).toBe(true)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws on %p',
    (input) => {
      expect(() => roundHalfUp(input)).toThrow()
    },
  )
})

describe('divRoundHalfUp', () => {
  it.each([
    [1, 2, 1],
    [3, 2, 2],
    [5, 2, 3],
    [2_999_500, 1000, 3000],
    [0, 1000, 0],
    [999, 1000, 1],
    [499, 1000, 0],
    [500, 1000, 1],
  ])('divRoundHalfUp(%i, %i) === %i', (n, d, expected) => {
    expect(divRoundHalfUp(n, d)).toBe(expected)
  })

  it.each([
    [-1, 2, -1],
    [-3, 2, -2],
    [-5, 2, -3],
    [-500, 1000, -1],
  ])('divRoundHalfUp(%i, %i) === %i (symmetric across zero)', (n, d, expected) => {
    expect(divRoundHalfUp(n, d)).toBe(expected)
  })

  it('never returns -0', () => {
    expect(Object.is(divRoundHalfUp(-1, 1000), 0)).toBe(true)
  })

  it('rejects non-integers and non-positive denominators', () => {
    expect(() => divRoundHalfUp(1.5, 2)).toThrow()
    expect(() => divRoundHalfUp(5, 0)).toThrow()
    expect(() => divRoundHalfUp(5, -2)).toThrow()
  })

  it('throws rather than silently losing precision on overflow', () => {
    expect(() => divRoundHalfUp(2 ** 53, 1000)).toThrow(/exceeds Number.MAX_SAFE_INTEGER/)
  })

  // The reason this function exists instead of Math.round(n / d). BigInt is the
  // reference implementation: exact by construction, too slow to use in production.
  //
  // Mismatches are COLLECTED and asserted once rather than calling expect() inside the
  // loop. Same 68,576 comparisons, but expect() carries real per-call overhead in vitest
  // and the in-loop version took 1.8s idle — 36% of the default 5s timeout, which tipped
  // over into a failure whenever the full monorepo suite ran the server's integration
  // tests alongside it. A test that fails under load and passes on its own teaches people
  // to re-run rather than to look.
  it('matches an exact BigInt reference across the realistic range', () => {
    const reference = (n: bigint, d: bigint): number => {
      const negative = n < 0n
      const abs = negative ? -n : n
      const q = (abs * 2n + d) / (d * 2n)
      return Number(negative ? -q : q)
    }

    const mismatches: string[] = []
    let compared = 0

    for (let n = 0; n <= 60_000; n += 7) {
      for (const d of [1000, 10_000, 3500, 28_000]) {
        for (const signed of [n, -n]) {
          const actual = divRoundHalfUp(signed, d)
          const expected = reference(BigInt(signed), BigInt(d))
          compared += 1
          if (actual !== expected) {
            mismatches.push(`divRoundHalfUp(${signed}, ${d}) = ${actual}, expected ${expected}`)
          }
        }
      }
    }

    expect(mismatches).toEqual([])
    expect(compared).toBe(68_576)
  })
})
