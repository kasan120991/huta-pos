/**
 * Integer rounding primitives.
 *
 * Everything money- or quantity-shaped in this system ultimately routes through these two
 * functions, so they are the highest-leverage code in the package.
 */

import { UnitError } from './brand.js'

/**
 * Round half AWAY FROM ZERO. `roundHalfUp(2.5) === 3`, `roundHalfUp(-2.5) === -3`.
 *
 * Not `Math.round`, which rounds half toward +Infinity and so turns -2.5 into -2. That
 * asymmetry breaks refund symmetry: a refunded taxed line would return one cent less than
 * was charged. Not banker's rounding either — the house rules commits to half-up so totals
 * reconcile the way a cashier expects.
 *
 * Never returns -0, which would otherwise leak into comparisons and JSON.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) {
    throw new UnitError(`roundHalfUp requires a finite value, got ${value}`)
  }
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value)
  return rounded === 0 ? 0 : rounded
}

/**
 * Integer division rounding half away from zero, computed WITHOUT a float intermediate.
 *
 * `Math.round(a * b / d)` is the obvious spelling and is subtly unsafe: `a * b / d` is a
 * binary fraction that may not be exactly representable, so a value that is mathematically
 * exactly `x.5` can land at `x.4999999999` and round the wrong way. `floor((2n + d) / 2d)`
 * stays in integer space and is exact.
 *
 * Throws rather than silently losing precision if the intermediate would exceed
 * `Number.MAX_SAFE_INTEGER`. Realistic worst case here is a ~1e5 cents/g rate times a
 * ~5e5 mg weight, doubled — about 1e11 against a 9e15 ceiling, so the guard should never
 * fire in production. It exists to make sure that if it ever does, it fails loudly.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new UnitError(
      `divRoundHalfUp requires integers, got ${numerator}/${denominator}`,
    )
  }
  if (denominator <= 0) {
    throw new UnitError(`divRoundHalfUp requires a positive denominator, got ${denominator}`)
  }

  const negative = numerator < 0
  const abs = negative ? -numerator : numerator
  const scaled = abs * 2 + denominator

  if (!Number.isSafeInteger(scaled)) {
    throw new UnitError(
      `divRoundHalfUp overflowed: intermediate ${scaled} exceeds Number.MAX_SAFE_INTEGER`,
    )
  }

  const quotient = Math.floor(scaled / (denominator * 2))
  if (!negative) return quotient
  return quotient === 0 ? 0 : -quotient
}
