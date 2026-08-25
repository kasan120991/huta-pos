import { describe, expect, it } from 'vitest'

import {
  dayKey,
  dayRange,
  weekStartDateOf,
  weeksBetween,
  zonedStartOfDay,
  zonedStartOfWeek,
} from '../src/lib/business-day.js'

/**
 * `business-day.ts` had no direct test until payroll needed it — its coverage was incidental,
 * through `shift-list.test.ts` and `timeclock.test.ts`. That was a real gap for a module whose
 * whole purpose is a rule that has been got wrong four times.
 *
 * ⚠️ Every timezone assertion here uses a zone the test runner CANNOT be in. A test that
 * passes because the server happens to sit in the same zone as the store proves nothing —
 * that is exactly how the bug this module was extracted for survived.
 */

const NY = 'America/New_York'
/** UTC+14 and UTC−10: 24 hours apart, so one instant lands on two different calendar days. */
const KIRITIMATI = 'Pacific/Kiritimati'
const HONOLULU = 'Pacific/Honolulu'

describe('zonedStartOfWeek', () => {
  it('resolves every day of a week to the same Sunday instant', () => {
    // 23 Aug 2026 is a Sunday; 29 Aug is the Saturday that closes that week.
    const sunday = zonedStartOfWeek('2026-08-23', NY)
    for (const date of [
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
    ]) {
      expect(zonedStartOfWeek(date, NY).toISOString()).toBe(sunday.toISOString())
    }
    // …and the next day starts the next week, not the same one.
    expect(zonedStartOfWeek('2026-08-30', NY).toISOString()).not.toBe(sunday.toISOString())
  })

  it('starts the week at local midnight, not UTC midnight', () => {
    // Eastern is UTC−4 in August, so Sunday 00:00 local is 04:00Z.
    expect(zonedStartOfWeek('2026-08-23', NY).toISOString()).toBe('2026-08-23T04:00:00.000Z')
  })

  it('agrees with zonedStartOfDay when the date IS the week start', () => {
    expect(zonedStartOfWeek('2026-08-23', NY).getTime()).toBe(
      zonedStartOfDay('2026-08-23', NY).getTime(),
    )
  })

  /**
   * ⚠️ THE assertion that kills every naive implementation.
   *
   * A fortnight is not 14 × 24h. US daylight saving lands at 02:00 on a SUNDAY — i.e. inside
   * the opening hours of a workweek — so `start + 14 * 86_400_000` is an hour off in March
   * and an hour off the other way in November. An hour of error at a period boundary puts a
   * 00:30 Sunday entry in the wrong fortnight.
   */
  it('spans a real fortnight across DST, not 14 × 24 hours', () => {
    const springStart = zonedStartOfWeek('2026-03-08', NY)
    const springEnd = zonedStartOfWeek('2026-03-08', NY, 2)
    expect(springStart.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(springEnd.toISOString()).toBe('2026-03-22T04:00:00.000Z')
    // Thirteen days and twenty-three hours.
    expect(springEnd.getTime() - springStart.getTime()).toBe((13 * 24 + 23) * 3_600_000)
    expect(springEnd.getTime() - springStart.getTime()).not.toBe(14 * 86_400_000)

    const fallStart = zonedStartOfWeek('2026-11-01', NY)
    const fallEnd = zonedStartOfWeek('2026-11-01', NY, 2)
    // Fourteen days and one hour, the other way.
    expect(fallEnd.getTime() - fallStart.getTime()).toBe((14 * 24 + 1) * 3_600_000)
  })

  it('walks backwards as well as forwards', () => {
    expect(zonedStartOfWeek('2026-08-23', NY, -1).toISOString()).toBe(
      zonedStartOfWeek('2026-08-16', NY).toISOString(),
    )
  })
})

describe('weekStartDateOf', () => {
  /**
   * One instant, two workweeks — an assertion no server-zone implementation can satisfy,
   * wherever the runner happens to be.
   */
  it('reads one instant into different weeks under different store zones', () => {
    // 2026-08-23T06:00Z is Sunday 20:00 in Kiritimati (UTC+14) and Saturday 20:00 in
    // Honolulu (UTC−10) — different days, and therefore different workweeks.
    const at = new Date('2026-08-23T06:00:00.000Z')
    expect(dayKey(at, KIRITIMATI)).toBe('2026-08-23')
    expect(dayKey(at, HONOLULU)).toBe('2026-08-22')

    expect(weekStartDateOf(at, KIRITIMATI)).toBe('2026-08-23')
    expect(weekStartDateOf(at, HONOLULU)).toBe('2026-08-16')
  })

  it('puts every day of a week on its Sunday', () => {
    for (const [iso, expected] of [
      ['2026-08-23T12:00:00.000Z', '2026-08-23'],
      ['2026-08-26T12:00:00.000Z', '2026-08-23'],
      ['2026-08-29T12:00:00.000Z', '2026-08-23'],
      ['2026-08-30T12:00:00.000Z', '2026-08-30'],
    ] as const) {
      expect(weekStartDateOf(new Date(iso), NY)).toBe(expected)
    }
  })

  it('reads an evening entry into the store day, not the UTC one', () => {
    // 21:16 Eastern on Saturday 29 Aug is 01:16Z on Sunday 30 Aug. UTC would call that the
    // next week; the store calls it the end of this one. This is the exact shape of the bug
    // that hid people's hours.
    const at = new Date('2026-08-30T01:16:00.000Z')
    expect(weekStartDateOf(at, NY)).toBe('2026-08-23')
  })
})

describe('weeksBetween', () => {
  it('counts whole weeks', () => {
    expect(weeksBetween('2026-08-23', '2026-08-23')).toBe(0)
    expect(weeksBetween('2026-08-23', '2026-08-30')).toBe(1)
    expect(weeksBetween('2026-08-23', '2026-09-06')).toBe(2)
    expect(weeksBetween('2026-09-06', '2026-08-23')).toBe(-2)
  })

  it('is unaffected by DST — these are calendar dates, not instants', () => {
    // A naive (to - from) / 604800000 on ZONED instants would give 1.99 here and round wrong
    // in a language less forgiving than this one.
    expect(weeksBetween('2026-03-08', '2026-03-22')).toBe(2)
    expect(weeksBetween('2026-11-01', '2026-11-15')).toBe(2)
  })

  it('keeps biweekly periods aligned to the anchor forever', () => {
    // Every real pay period is an EVEN number of weeks from the anchor. Odd means the caller
    // has drifted onto an off-cycle Sunday.
    for (const date of ['2026-08-23', '2026-09-06', '2026-09-20', '2026-10-04']) {
      expect(weeksBetween('2026-08-23', date) % 2).toBe(0)
    }
    for (const date of ['2026-08-30', '2026-09-13']) {
      expect(weeksBetween('2026-08-23', date) % 2).toBe(1)
    }
  })
})

describe('dayRange', () => {
  it('is half-open, so the last day is not truncated to its first instant', () => {
    const range = dayRange('2026-08-23', '2026-08-24', NY)
    expect(range?.gte?.toISOString()).toBe('2026-08-23T04:00:00.000Z')
    // Exclusive END is the START of the day after `to` — an `lte` here would drop everything
    // rung after midnight on the 24th, which is almost all of it.
    expect(range?.lt?.toISOString()).toBe('2026-08-25T04:00:00.000Z')
  })

  it('is undefined when unfiltered', () => {
    expect(dayRange(undefined, undefined, NY)).toBeUndefined()
  })
})
