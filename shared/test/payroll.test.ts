import { describe, expect, it } from 'vitest'

import { UnitError, unsafe } from '../src/brand.js'
import { divRoundHalfUp } from '../src/math.js'
import {
  FLSA_WEEKLY_OVERTIME_MINUTES,
  extendOvertime,
  extendPerHour,
  formatMinutesAsHours,
  splitWorkweekMinutes,
} from '../src/payroll.js'

const rate = unsafe.centsPerHour

describe('splitWorkweekMinutes', () => {
  /**
   * The forty-hour line is this feature's tier boundary, and tier boundaries are where money
   * quietly goes wrong — so it is asserted ON the threshold and one minute either side, the
   * same way the pricing suite treats a weight break.
   */
  it('splits at exactly forty hours', () => {
    expect(FLSA_WEEKLY_OVERTIME_MINUTES).toBe(2400)

    expect(splitWorkweekMinutes(0)).toEqual({ regularMinutes: 0, overtimeMinutes: 0 })
    expect(splitWorkweekMinutes(2399)).toEqual({ regularMinutes: 2399, overtimeMinutes: 0 })
    expect(splitWorkweekMinutes(2400)).toEqual({ regularMinutes: 2400, overtimeMinutes: 0 })
    expect(splitWorkweekMinutes(2401)).toEqual({ regularMinutes: 2400, overtimeMinutes: 1 })
  })

  it('caps regular minutes however long the week', () => {
    // A full 168-hour week. Absurd, but the arithmetic must not invent regular hours.
    const week = splitWorkweekMinutes(168 * 60)
    expect(week.regularMinutes).toBe(2400)
    expect(week.overtimeMinutes).toBe(168 * 60 - 2400)
    expect(week.regularMinutes + week.overtimeMinutes).toBe(168 * 60)
  })

  it('refuses a negative or fractional week', () => {
    expect(() => splitWorkweekMinutes(-1)).toThrow(UnitError)
    expect(() => splitWorkweekMinutes(1.5)).toThrow(UnitError)
  })
})

describe('extendPerHour', () => {
  it('pays whole hours exactly', () => {
    expect(extendPerHour(rate(1750), 60)).toBe(1750)
    expect(extendPerHour(rate(1750), 2400)).toBe(70_000)
    expect(extendPerHour(rate(1750), 0)).toBe(0)
  })

  it('rounds half away from zero, once', () => {
    // 1750 × 3 / 60 = 87.5 → 88, not 87.
    expect(extendPerHour(rate(1750), 3)).toBe(88)
  })

  it('refuses fractional minutes', () => {
    expect(() => extendPerHour(rate(1750), 1.5)).toThrow(UnitError)
  })
})

describe('extendOvertime', () => {
  it('pays time and a half', () => {
    // An hour of overtime at $20.00 is $30.00.
    expect(extendOvertime(rate(2000), 60)).toBe(3000)
    expect(extendOvertime(rate(2000), 0)).toBe(0)
  })

  /**
   * ⚠️ The reason `extendOvertime` exists as one expression rather than two steps.
   *
   * This is `extendTier`'s round-trip trap in another costume: derive an intermediate rate,
   * round it, then extend it, and the second rounding lands the result a cent away. The test
   * asserts BOTH numbers so it documents the trap rather than merely pinning the answer.
   */
  it('rounds ONCE — deriving an overtime rate first gives a different cent', () => {
    const hourly = 1755 // $17.55
    const minutes = 30

    // One rounding: 1755 × 30 × 3 / 120 = 1316.25 → 1316.
    expect(extendOvertime(rate(hourly), minutes)).toBe(1316)

    // Two roundings: an overtime rate of 2632.5 → 2633, then 2633 × 30 / 60 = 1316.5 → 1317.
    const derivedOvertimeRate = divRoundHalfUp(hourly * 3, 2)
    expect(derivedOvertimeRate).toBe(2633)
    expect(divRoundHalfUp(derivedOvertimeRate * minutes, 60)).toBe(1317)
  })

  it('never disagrees with a BigInt reference', () => {
    // Collected and asserted ONCE — an expect() inside a hot loop is what made
    // divRoundHalfUp's own reference test take 1.8s and fail intermittently under load.
    const mismatches: string[] = []
    for (let cents = 725; cents <= 9000; cents += 37) {
      for (let minutes = 0; minutes <= 600; minutes += 7) {
        const actual = BigInt(extendOvertime(rate(cents), minutes))
        const n = BigInt(cents) * BigInt(minutes) * 3n
        const d = 120n
        // floor((2n + d) / 2d), the integer spelling of half-away-from-zero on non-negatives.
        const expected = (2n * n + d) / (2n * d)
        if (actual !== expected) mismatches.push(`${cents}¢ × ${minutes}m: ${actual} ≠ ${expected}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('overtime is worth more than straight time', () => {
  it('costs half as much again for the same minutes', () => {
    const straight = extendPerHour(rate(1800), 120)
    const over = extendOvertime(rate(1800), 120)
    expect(straight).toBe(3600)
    expect(over).toBe(5400)
    expect(over).toBe(straight * 1.5)
  })
})

describe('formatMinutesAsHours', () => {
  it('renders the way the Hours tab already does', () => {
    expect(formatMinutesAsHours(465)).toBe('7h 45m')
    expect(formatMinutesAsHours(39)).toBe('39m')
    expect(formatMinutesAsHours(120)).toBe('2h')
    expect(formatMinutesAsHours(0)).toBe('0m')
  })

  it('never renders a negative', () => {
    expect(formatMinutesAsHours(-5)).toBe('0m')
  })
})
