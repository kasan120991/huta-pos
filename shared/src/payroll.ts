import type { Cents, CentsPerHour } from './brand.js'
import { UnitError, unsafe } from './brand.js'
import { divRoundHalfUp } from './math.js'

/**
 * Payroll primitives — money against TIME, the way `pricing.ts` is money against quantity.
 *
 * This module holds arithmetic only. Which rate applies to a week, and which week an entry
 * falls in, stay on the server: both are timezone- and database-dependent, and the same rule
 * keeps tier and promotion resolution out of `PricingService`'s client-facing surface.
 *
 * ⚠️ GROSS PAY ONLY. Nothing here withholds tax, and nothing downstream should pretend to.
 * The figure these functions produce is what was earned before deductions — the part the
 * timeclock uniquely knows — and it is handed to a payroll provider to withhold and file.
 *
 * The design assumes HOURLY, NON-EXEMPT employees. There is no salary concept and no exempt
 * flag; anyone salaried must not be run through this.
 */

export const MINUTES_PER_HOUR = 60

/**
 * Forty hours, in minutes — the FLSA weekly overtime threshold (29 U.S.C. §207(a)).
 *
 * Per WORKWEEK, never per pay period. A fortnight of 45 + 35 hours owes five hours of
 * overtime; the same eighty hours as 40 + 40 owes none. Pooling the period would understate
 * it, which is a wage violation rather than a display bug.
 *
 * Georgia adds nothing to the federal rule — no daily overtime, no seventh-consecutive-day
 * rule. Do not helpfully add them.
 */
export const FLSA_WEEKLY_OVERTIME_MINUTES = 40 * MINUTES_PER_HOUR

/** The federal floor. Georgia defers to it. A figure to WARN against, never a hard CHECK —
 *  it changes, and a constraint would need a migration. */
export const FEDERAL_MINIMUM_WAGE_PER_HOUR_CENTS = 725

/**
 * Split a workweek's minutes at the forty-hour line.
 *
 * Straight arithmetic on integers, so there is nothing to round here — the rounding happens
 * once each when these two figures become money.
 */
export function splitWorkweekMinutes(minutes: number): {
  regularMinutes: number
  overtimeMinutes: number
} {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new UnitError(`Workweek minutes must be a non-negative integer, got ${minutes}`)
  }
  return {
    regularMinutes: Math.min(minutes, FLSA_WEEKLY_OVERTIME_MINUTES),
    overtimeMinutes: Math.max(0, minutes - FLSA_WEEKLY_OVERTIME_MINUTES),
  }
}

/**
 * Straight-time pay for a number of minutes at an hourly rate.
 *
 * `divRoundHalfUp` rather than a float divide, for the reason its own docblock gives: an
 * exact `.5` can land at `.4999999999` through a binary fraction and round the wrong way.
 */
export function extendPerHour(rate: CentsPerHour, minutes: number): Cents {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new UnitError(`Minutes must be a non-negative integer, got ${minutes}`)
  }
  return unsafe.cents(divRoundHalfUp(rate * minutes, MINUTES_PER_HOUR))
}

/**
 * Overtime pay — time and a half, in ONE rounding.
 *
 * ⚠️ Never derive an hourly overtime rate and extend that. It is the same round-trip trap
 * `extendTier` documents for weight tiers: at $17.55/hr for 30 overtime minutes, rounding
 * once gives 1316¢, while deriving the overtime rate first (2633¢) and extending it gives
 * 1317¢. Two roundings is one too many, and the cent lands against the employee at some
 * rates and against the employer at others.
 *
 * 1.5 is 3/2, so `rate × minutes × 1.5 / 60` is `rate × minutes × 3 / 120` — which stays in
 * integer space. `divRoundHalfUp` would throw on a fractional numerator anyway, so the
 * arithmetic cannot be written the wrong way by accident.
 */
export function extendOvertime(rate: CentsPerHour, minutes: number): Cents {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new UnitError(`Minutes must be a non-negative integer, got ${minutes}`)
  }
  return unsafe.cents(divRoundHalfUp(rate * minutes * 3, MINUTES_PER_HOUR * 2))
}

/**
 * `465` → `"7h 45m"`, `39` → `"39m"`, `0` → `"0m"`.
 *
 * Here rather than in a component because the Hours tab and the payroll screen must render
 * the same minutes identically — two copies would eventually disagree about "38h 20m", and a
 * payroll figure that does not match the timesheet it came from is unanswerable at the
 * counter.
 */
export function formatMinutesAsHours(minutes: number): string {
  const whole = Math.max(0, Math.trunc(minutes))
  const hours = Math.floor(whole / MINUTES_PER_HOUR)
  const rest = whole % MINUTES_PER_HOUR
  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h ${rest}m`
}
