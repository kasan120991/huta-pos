import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, ValidationError } from '../../src/errors/index.js'
import { correctEntry, listEntries } from '../../src/people/timeclock.service.js'
import {
  PAY_PERIOD_ANCHOR_SUNDAY,
  commitRun,
  getRun,
  listRuns,
  previewRun,
  reverseRun,
} from '../../src/people/payroll.service.js'
import { recordPayout, reversePayout } from '../../src/people/payout.service.js'
import { setWageRate } from '../../src/people/wage.service.js'
import { closeShift, openShift } from '../../src/sales/shift.service.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/**
 * Payroll.
 *
 * The arithmetic here is what somebody is paid from, so the cases that matter are the ones
 * where a plausible-but-wrong implementation still produces a number: overtime pooled across
 * the fortnight, an estimated entry folded into a total, a truncated query, a rate resolved
 * against the wrong week.
 */

/** A fortnight well in the past, so `commitRun`'s "not finished yet" guard never fires. */
const PERIOD = '2026-08-09'
const WEEK_1 = '2026-08-09'
const WEEK_2 = '2026-08-16'

describe('payroll', () => {
  let storeId: string
  let terminalId: string
  let staffId: string
  let staff: StaffPrincipal
  let admin: AdminPrincipal
  let adminId: string

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    storeId = store.id
    await prisma.store.update({ where: { id: storeId }, data: { timezone: 'America/New_York' } })
    const terminal = await makeTerminal(storeId, 'device-token-payroll')
    terminalId = terminal.id
    const person = await makeStaff(storeId, '1111')
    staffId = person.id
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId }
    const a = await makeAdmin()
    adminId = a.id
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  /** Write a finished entry directly — the service only ever clocks "now". */
  async function workedOn(dayIso: string, minutes: number, userId = staffId, status = 'CLOCKED') {
    const start = new Date(dayIso)
    return prisma.timeEntry.create({
      data: {
        userId,
        storeId,
        clockedInAt: start,
        clockedOutAt: new Date(start.getTime() + minutes * 60_000),
        status: status as 'CLOCKED',
        // TimeEntry_reason_check: a CORRECTED or VOIDED row must carry a reason.
        ...(status === 'VOIDED' || status === 'CORRECTED' ? { note: 'test fixture' } : {}),
      },
      select: { id: true },
    })
  }

  const wage = (cents: number, from = WEEK_1) =>
    setWageRate(admin, staffId, { ratePerHourCents: cents, effectiveFrom: from }, adminId)

  describe('overtime is per WORKWEEK, not per period', () => {
    /**
     * ⚠️ THE test. Eighty hours split 45/35 owes five hours of overtime; the same eighty as
     * 40/40 owes none. No implementation that pools the fortnight can pass both halves.
     */
    it('charges overtime on a 45-hour week even when the fortnight averages forty', async () => {
      await wage(2000) // $20.00/hr

      // Week 1: 45 hours across five nine-hour days.
      for (const day of ['10', '11', '12', '13', '14']) {
        await workedOn(`2026-08-${day}T13:00:00.000Z`, 9 * 60)
      }
      // Week 2: 35 hours across five seven-hour days.
      for (const day of ['17', '18', '19', '20', '21']) {
        await workedOn(`2026-08-${day}T13:00:00.000Z`, 7 * 60)
      }

      const preview = await previewRun(admin, PERIOD)
      expect(preview.payable).toBe(true)
      expect(preview.lines).toHaveLength(1)

      const line = preview.lines[0]!
      expect(line.totalMinutes).toBe(80 * 60)
      expect(line.overtimeMinutes).toBe(5 * 60)

      // 75 regular hours at $20 = $1,500; 5 overtime hours at $30 = $150.
      expect(line.regularCents).toBe(150_000)
      expect(line.overtimeCents).toBe(15_000)
      expect(line.grossCents).toBe(165_000)
    })

    it('charges nothing extra for the same eighty hours split evenly', async () => {
      await wage(2000)
      for (const day of ['10', '11', '12', '13', '14']) {
        await workedOn(`2026-08-${day}T13:00:00.000Z`, 8 * 60)
      }
      for (const day of ['17', '18', '19', '20', '21']) {
        await workedOn(`2026-08-${day}T13:00:00.000Z`, 8 * 60)
      }

      const line = (await previewRun(admin, PERIOD)).lines[0]!
      expect(line.totalMinutes).toBe(80 * 60)
      expect(line.overtimeMinutes).toBe(0)
      expect(line.grossCents).toBe(160_000)
    })

    it('splits exactly at forty hours, and one minute past it', async () => {
      await wage(1500)
      await workedOn('2026-08-10T12:00:00.000Z', 40 * 60)

      let line = (await previewRun(admin, PERIOD)).lines[0]!
      expect(line.overtimeMinutes).toBe(0)
      expect(line.grossCents).toBe(60_000)

      await workedOn('2026-08-12T12:00:00.000Z', 1)
      line = (await previewRun(admin, PERIOD)).lines[0]!
      expect(line.overtimeMinutes).toBe(1)
      // One minute at 1.5 × $15.00/hr = 37.5¢, rounded half away from zero.
      expect(line.overtimeCents).toBe(38)
    })
  })

  describe('the gate on unfinished and estimated time', () => {
    /**
     * The OPEN case has to be tested in the CURRENT period, not a historical one: an entry
     * backdated past the twelve-hour cutoff is auto-closed to AUTO by `resolveAbandoned`
     * before the preview counts anything — correctly. An OPEN entry is by definition recent.
     */
    it('blocks on an OPEN entry and names the person', async () => {
      await wage(2000, PAY_PERIOD_ANCHOR_SUNDAY)
      await prisma.timeEntry.create({
        data: { userId: staffId, storeId, clockedInAt: new Date(), status: 'OPEN' },
      })

      const preview = await previewRun(admin, PAY_PERIOD_ANCHOR_SUNDAY)
      expect(preview.payable).toBe(false)
      expect(preview.blockers.map((b) => b.kind)).toContain('OPEN_ENTRY')
      expect(preview.blockers[0]?.userName).toContain('Staff')
    })

    it('blocks on an AUTO entry — nobody is paid from a number the system guessed', async () => {
      await wage(2000)
      await workedOn('2026-08-10T13:00:00.000Z', 12 * 60, staffId, 'AUTO')

      const preview = await previewRun(admin, PERIOD)
      expect(preview.payable).toBe(false)
      expect(preview.blockers.map((b) => b.kind)).toEqual(['ESTIMATED_ENTRY'])
      // …and its minutes are nowhere in the figures.
      expect(preview.totalMinutes).toBe(0)
    })

    it('pays once the estimate has been corrected', async () => {
      await wage(2000)
      const auto = await workedOn('2026-08-10T13:00:00.000Z', 12 * 60, staffId, 'AUTO')
      await prisma.timeEntry.update({
        where: { id: auto.id },
        data: {
          status: 'CORRECTED',
          clockedOutAt: new Date('2026-08-10T21:00:00.000Z'),
          note: 'Went home at five.',
        },
      })

      const preview = await previewRun(admin, PERIOD)
      expect(preview.payable).toBe(true)
      expect(preview.lines[0]?.totalMinutes).toBe(8 * 60)
    })

    it('excludes a VOIDED entry silently — a discarded entry is not a problem to fix', async () => {
      await wage(2000)
      await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)
      await workedOn('2026-08-11T13:00:00.000Z', 8 * 60, staffId, 'VOIDED')

      const preview = await previewRun(admin, PERIOD)
      expect(preview.payable).toBe(true)
      expect(preview.blockers).toEqual([])
      expect(preview.lines[0]?.totalMinutes).toBe(8 * 60)
    })

    it('blocks when nobody has set a wage, rather than paying zero', async () => {
      await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)

      const preview = await previewRun(admin, PERIOD)
      expect(preview.payable).toBe(false)
      expect(preview.blockers.map((b) => b.kind)).toEqual(['NO_WAGE_RATE'])
      expect(preview.grossCents).toBe(0)
    })
  })

  describe('agreement with the timesheet', () => {
    it('reports the same minutes the Hours tab does', async () => {
      await wage(1800)
      await workedOn('2026-08-10T13:00:00.000Z', 7 * 60 + 23)
      await workedOn('2026-08-11T13:00:00.000Z', 6 * 60 + 47)

      const preview = await previewRun(admin, PERIOD)
      const hours = await listEntries(admin, { userId: staffId, from: WEEK_1, to: '2026-08-22' })
      expect(preview.lines[0]?.totalMinutes).toBe(hours.totalMinutes)
    })

    /**
     * ⚠️ The regression this feature exists to avoid. `listEntries` caps at 500 rows and
     * aggregates in JS over what it fetched, so its totals truncate — and under-reporting
     * pays somebody less than they earned. This can only pass if payroll does not reuse it.
     */
    it('counts every entry past listEntries\' 500-row cap', async () => {
      await wage(1200)
      // 600 six-minute entries, all inside week 1 and all on distinct starts.
      const base = new Date('2026-08-10T04:00:00.000Z').getTime()
      await prisma.timeEntry.createMany({
        data: Array.from({ length: 600 }, (_, i) => ({
          userId: staffId,
          storeId,
          clockedInAt: new Date(base + i * 10 * 60_000),
          clockedOutAt: new Date(base + i * 10 * 60_000 + 6 * 60_000),
          status: 'CLOCKED' as const,
        })),
      })

      const preview = await previewRun(admin, PERIOD)
      expect(preview.lines[0]?.totalMinutes).toBe(600 * 6)

      // …while the list surface truncates, which is correct THERE and disqualifying here.
      const hours = await listEntries(admin, { userId: staffId, from: WEEK_1, to: '2026-08-22' })
      expect(hours.entries.length).toBe(500)
      expect(hours.totalMinutes).toBeLessThan(600 * 6)
    })
  })

  describe('committing and reversing', () => {
    async function payableFortnight() {
      await wage(2000)
      await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)
      await workedOn('2026-08-17T13:00:00.000Z', 8 * 60)
    }

    it('writes a run with its lines and weeks', async () => {
      await payableFortnight()
      const run = await commitRun(admin, PERIOD, 'August second half', adminId)

      expect(run.status).toBe('COMMITTED')
      expect(run.grossCents).toBe(32_000)
      expect(run.lineCount).toBe(1)

      const detail = await getRun(admin, run.id)
      expect(detail.lines[0]?.weeks).toHaveLength(2)
      expect(detail.lines[0]?.weeks.map((w) => w.weekStartDate)).toEqual([WEEK_1, WEEK_2])
      expect(detail.lines[0]?.outstandingCents).toBe(32_000)
    })

    it('refuses a second live run for the same fortnight', async () => {
      await payableFortnight()
      await commitRun(admin, PERIOD, undefined, adminId)
      await expect(commitRun(admin, PERIOD, undefined, adminId)).rejects.toBeInstanceOf(ConflictError)
    })

    it('refuses a period that has not finished', async () => {
      await wage(2000)
      // The fortnight containing today.
      const soon = PAY_PERIOD_ANCHOR_SUNDAY
      await expect(commitRun(admin, soon, undefined, adminId)).rejects.toBeInstanceOf(ConflictError)
    })

    it('refuses a Sunday that is not on the fortnightly cycle', async () => {
      await expect(previewRun(admin, '2026-08-16')).rejects.toBeInstanceOf(ValidationError)
    })

    /**
     * Reversing and re-committing an unchanged period must produce identical totals. That is
     * the property that makes reversal safe: it proves the computation is a pure function of
     * (entries, rates, period) rather than of when it happened to run.
     */
    it('reverses, then re-commits to byte-identical totals', async () => {
      await payableFortnight()
      const first = await commitRun(admin, PERIOD, undefined, adminId)

      const reversed = await reverseRun(admin, first.id, 'Wrong rate on file.', adminId)
      expect(reversed.status).toBe('REVERSED')
      expect(reversed.reversalNote).toBe('Wrong rate on file.')
      // The figures it was committed with survive untouched — that is what makes it a record.
      expect(reversed.grossCents).toBe(first.grossCents)

      const second = await commitRun(admin, PERIOD, undefined, adminId)
      expect(second.id).not.toBe(first.id)
      expect(second.grossCents).toBe(first.grossCents)
      expect(second.totalMinutes).toBe(first.totalMinutes)

      expect(await prisma.payRun.count({ where: { periodStartDate: PERIOD } })).toBe(2)
    })

    it('refuses to reverse a run that money has gone out against', async () => {
      await payableFortnight()
      const run = await commitRun(admin, PERIOD, undefined, adminId)
      const detail = await getRun(admin, run.id)
      await recordPayout(
        admin,
        detail.lines[0]!.id,
        { method: 'BANK', amountCents: 10_000, reference: 'TRF-1' },
        adminId,
      )

      await expect(reverseRun(admin, run.id, 'nope', adminId)).rejects.toBeInstanceOf(ConflictError)
    })

    describe('what a run has actually paid out', () => {
    /**
     * `listRuns` reports `paidCents` without loading lines, while `getRun` derives it per
     * line from the payouts it already holds. Two derivations of one fact, so the test that
     * matters is that they AGREE — and that both drop a reversed payout, since money that
     * came back must not read as money paid.
     */
    it('agrees with the per-line sum, and excludes a reversed payout', async () => {
      await payableFortnight()
      const run = await commitRun(admin, PERIOD, undefined, adminId)
      const detail = await getRun(admin, run.id)
      const lineId = detail.lines[0]!.id

      // Nothing paid yet: outstanding is the whole gross.
      const [before] = await listRuns(admin)
      expect(before!.paidCents).toBe(0)
      expect(before!.outstandingCents).toBe(run.grossCents)

      const kept = await recordPayout(
        admin,
        lineId,
        { method: 'BANK', amountCents: 4_000, reference: 'TRF-KEEP' },
        adminId,
      )
      const undone = await recordPayout(
        admin,
        lineId,
        { method: 'BANK', amountCents: 2_500, reference: 'TRF-OOPS' },
        adminId,
      )
      await reversePayout(admin, undone.id, 'keyed twice', adminId)

      const [after] = await listRuns(admin)
      expect(after!.paidCents).toBe(4_000)
      expect(after!.outstandingCents).toBe(run.grossCents - 4_000)

      // The two derivations must not drift.
      const fresh = await getRun(admin, run.id)
      const perLine = fresh.lines.reduce((n, l) => n + l.paidCents, 0)
      expect(after!.paidCents).toBe(perLine)
      expect(kept.id).not.toBe(undone.id)
    })

    it('reports every run in one call, newest period first', async () => {
      await payableFortnight()
      await commitRun(admin, PERIOD, undefined, adminId)

      const runs = await listRuns(admin)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.periodStartDate).toBe(PERIOD)
      expect(runs[0]!.lineCount).toBeGreaterThan(0)
      })
    })
  })

  describe('a paid fortnight is closed to timesheet edits', () => {
    /**
     * ⚠️ Added with editable start times, and it applies to the end time too — that was a gap
     * the moment payroll started paying from this table. Editing an entry inside a committed
     * run would leave the run no longer matching the timesheet it was computed from.
     */
    it('refuses to edit an entry inside a committed run', async () => {
      await wage(2000)
      const entry = await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)
      await commitRun(admin, PERIOD, undefined, adminId)

      await expect(
        correctEntry(
          admin,
          entry.id,
          { clockedOutAt: '2026-08-10T22:00:00.000Z', note: 'Stayed an extra hour.' },
          adminId,
        ),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    /** An entry dated by its START must not be MOVED into a paid fortnight either. */
    it('refuses to move an entry INTO a committed run', async () => {
      await wage(2000)
      await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)
      await commitRun(admin, PERIOD, undefined, adminId)

      // A later, unpaid entry. Both ends move together — shifting only the start would make
      // a twelve-day entry and trip the length guard instead, which is a different refusal.
      const later = await workedOn('2026-08-24T13:00:00.000Z', 8 * 60)
      await expect(
        correctEntry(
          admin,
          later.id,
          {
            clockedInAt: '2026-08-12T13:00:00.000Z',
            clockedOutAt: '2026-08-12T21:00:00.000Z',
            note: 'Wrong week.',
          },
          adminId,
        ),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('allows the edit again once the run is reversed', async () => {
      await wage(2000)
      const entry = await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)
      const run = await commitRun(admin, PERIOD, undefined, adminId)
      await reverseRun(admin, run.id, 'Timesheet was wrong.', adminId)

      const fixed = await correctEntry(
        admin,
        entry.id,
        { clockedOutAt: '2026-08-10T22:00:00.000Z', note: 'Stayed an extra hour.' },
        adminId,
      )
      expect(fixed.minutes).toBe(9 * 60)
    })
  })

  describe('payouts and the drawer', () => {
    async function committedRun() {
      await wage(2000)
      await workedOn('2026-08-10T13:00:00.000Z', 8 * 60)
      const run = await commitRun(admin, PERIOD, undefined, adminId)
      const detail = await getRun(admin, run.id)
      return { run, lineId: detail.lines[0]!.id, grossCents: detail.lines[0]!.grossCents }
    }

    /**
     * ⚠️ The test that proves the drawer link works with `shift.service.ts` untouched: a cash
     * payout writes a PAID_OUT, and `closeShift`'s existing arithmetic already subtracts it.
     */
    it('takes cash out of the open drawer, and the close accounts for it', async () => {
      const { lineId } = await committedRun()
      const shift = await openShift(admin, storeId, { openingCashCents: 100_00 })

      await recordPayout(admin, lineId, { method: 'CASH', amountCents: 60_00, storeId }, adminId)

      const closed = await closeShift(admin, shift.id, { countedCashCents: 40_00 })
      // $100 opened, $60 paid out, nothing sold — $40 expected, and it balances.
      expect(closed.expectedCashCents).toBe(40_00)
      expect(closed.varianceCents).toBe(0)
    })

    it('puts the money back on reversal', async () => {
      const { lineId } = await committedRun()
      const shift = await openShift(admin, storeId, { openingCashCents: 100_00 })
      const payout = await recordPayout(
        admin,
        lineId,
        { method: 'CASH', amountCents: 60_00, storeId },
        adminId,
      )

      await reversePayout(admin, payout.id, 'Paid by transfer instead.', adminId, storeId)

      const closed = await closeShift(admin, shift.id, { countedCashCents: 100_00 })
      expect(closed.expectedCashCents).toBe(100_00)
      expect(closed.varianceCents).toBe(0)
    })

    it('refuses cash when no drawer is open', async () => {
      const { lineId } = await committedRun()
      await expect(
        recordPayout(admin, lineId, { method: 'CASH', amountCents: 10_00, storeId }, adminId),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('moves no cash for a bank transfer', async () => {
      const { lineId } = await committedRun()
      const shift = await openShift(admin, storeId, { openingCashCents: 100_00 })

      await recordPayout(
        admin,
        lineId,
        { method: 'BANK', amountCents: 60_00, reference: 'TRF-9' },
        adminId,
      )

      expect(await prisma.cashMovement.count()).toBe(0)
      const closed = await closeShift(admin, shift.id, { countedCashCents: 100_00 })
      expect(closed.expectedCashCents).toBe(100_00)
    })

    it('refuses to pay more than the line is worth', async () => {
      const { lineId, grossCents } = await committedRun()
      await expect(
        recordPayout(admin, lineId, { method: 'BANK', amountCents: grossCents + 1 }, adminId),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('allows part payments up to the line total', async () => {
      const { lineId, grossCents } = await committedRun()
      await recordPayout(admin, lineId, { method: 'BANK', amountCents: 6_000 }, adminId)
      await recordPayout(admin, lineId, { method: 'CHECK', amountCents: grossCents - 6_000 }, adminId)

      const runs = await prisma.payLine.findUnique({
        where: { id: lineId },
        select: { payRunId: true },
      })
      const detail = await getRun(admin, runs!.payRunId)
      expect(detail.lines[0]?.paidCents).toBe(grossCents)
      expect(detail.lines[0]?.outstandingCents).toBe(0)
    })
  })
})
