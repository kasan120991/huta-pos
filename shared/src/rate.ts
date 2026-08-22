/**
 * Basis points. Tax rates, percentage discounts, and cannabinoid potency all use them.
 * 825 == 8.25%. Integers only, so no percentage is ever a float.
 */

import { type Bps, UnitError, bps, unsafe } from './brand.js'
import { roundHalfUp } from './math.js'

export const MAX_BPS = 10_000
export const BPS_PER_PERCENT = 100

/** `percentToBps(8.25)` is 825. Rounds half-up to the nearest basis point. */
export function percentToBps(percent: number): Bps {
  if (!Number.isFinite(percent)) {
    throw new UnitError(`Percent must be finite, got ${percent}`)
  }
  return bps(roundHalfUp(percent * BPS_PER_PERCENT))
}

/** `bpsToPercent(825)` is 8.25. For display and reporting only — never for math. */
export function bpsToPercent(rate: Bps): number {
  return rate / BPS_PER_PERCENT
}

/** `formatBps(825)` is `"8.25%"`. */
export function formatBps(rate: Bps): string {
  const negative = rate < 0
  const abs = Math.abs(rate)
  const whole = Math.trunc(abs / BPS_PER_PERCENT)
  const fraction = String(abs % BPS_PER_PERCENT).padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}%`
}

export const ZERO_BPS = unsafe.bps(0)
export const FULL_BPS = unsafe.bps(MAX_BPS)
