import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal, TerminalPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../src/errors/index.js'
import {
  AUTO_CLOSE_HOURS,
  clockIn,
  clockOut,
  correctEntry,
  currentEntry,
  listEntries,
  resolveAbandoned,
  voidEntry,
} from '../../src/people/timeclock.service.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/**
 * The timeclock.
 *
 * The arithmetic under test is what someone gets paid from, so the cases that matter are the
 * dishonest ones: an entry the system closed at a guess must be distinguishable from one a
 * person keyed, and it must never quietly join the same total.
 */
describe('timeclock', () => {
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
    const terminal = await makeTerminal(storeId, 'device-token-timeclock')
    terminalId = terminal.id
    const person = await makeStaff(storeId, '1111')
    staffId = person.id
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId }
    const a = await makeAdmin()
    adminId = a.id
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  it('clocks in, taking the store from the terminal', async () => {
    const entry = await clockIn(staff)
    expect(entry.status).toBe('OPEN')
    expect(entry.storeId).toBe(storeId)
    expect(entry.clockedOutAt).toBeNull()
    expect(entry.minutes).toBeNull() // nothing to measure yet

    const row = await prisma.timeEntry.findFirstOrThrow({ where: { userId: staffId } })
    expect(row.clockedInTerminalId).toBe(terminalId)
  })

  it('rounds a part-minute to the NEAREST, not down', async () => {
    // Kasan's call, 2026-08-24: this floored until payroll started paying from it, and a
    // floor loses up to 59 seconds per entry — always in the employer's direction.
    const entry = await clockIn(staff)
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        clockedInAt: new Date('2026-08-24T12:00:00.000Z'),
        // 90 minutes and 40 seconds — rounds UP to 91, where a floor gave 90.
        clockedOutAt: new Date('2026-08-24T13:30:40.000Z'),
        status: 'CLOCKED',
      },
    })
    const page = await listEntries(admin, { userId: staffId })
    expect(page.entries[0]?.minutes).toBe(91)
    expect(page.totalMinutes).toBe(91)
  })

  it('rounds a part-minute DOWN when it is under the half', async () => {
    const entry = await clockIn(staff)
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        clockedInAt: new Date('2026-08-24T12:00:00.000Z'),
        clockedOutAt: new Date('2026-08-24T13:30:20.000Z'),
        status: 'CLOCKED',
      },
    })
    const page = await listEntries(admin, { userId: staffId })
    expect(page.entries[0]?.minutes).toBe(90)
  })

  it('clocks out and derives the minutes', async () => {
    const opened = await clockIn(staff)
    // Reach past the service to age it — the alternative is a two-hour test.
    await prisma.timeEntry.update({
      where: { id: opened.id },
      data: { clockedInAt: new Date(Date.now() - 90 * 60_000) },
    })

    const closed = await clockOut(staff)
    expect(closed.status).toBe('CLOCKED')
    expect(closed.minutes).toBe(90)
    expect(closed.closedByName).toContain('Staff')
  })

  it('refuses a second clock-in, and says when the first was', async () => {
    await clockIn(staff)
    await expect(clockIn(staff)).rejects.toThrow(ConflictError)
    await expect(clockIn(staff)).rejects.toThrow(/clocked in at/i)
  })

  it('refuses a clock-out when they are not on the clock', async () => {
    await expect(clockOut(staff)).rejects.toThrow(ConflictError)
  })

  /**
   * The partial unique index, not a read-then-write. Two tills, two taps, one row — proven
   * by racing them rather than by trusting the check.
   */
  it('survives two simultaneous clock-ins', async () => {
    const results = await Promise.allSettled([clockIn(staff), clockIn(staff)])
    const ok = results.filter((r) => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)

    const open = await prisma.timeEntry.count({ where: { userId: staffId, status: 'OPEN' } })
    expect(open).toBe(1)
  })

  it('is staff only — an admin is not on a clock', async () => {
    await expect(clockIn(admin)).rejects.toThrow(ForbiddenError)
    await expect(clockIn(admin)).rejects.toThrow(/not on the clock/i)
  })

  it('refuses a bare terminal', async () => {
    const terminal: TerminalPrincipal = {
      kind: 'terminal', userId: null, role: null, storeId, terminalId,
    }
    await expect(clockIn(terminal)).rejects.toThrow(ForbiddenError)
  })

  describe('the abandoned entry', () => {
    it('closes at the CUTOFF, not at now — so the estimate cannot grow', async () => {
      const opened = await clockIn(staff)
      const inAt = new Date(Date.now() - 30 * 3600 * 1000) // 30 hours ago
      await prisma.timeEntry.update({ where: { id: opened.id }, data: { clockedInAt: inAt } })

      await resolveAbandoned(staffId)

      const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: opened.id } })
      expect(row.status).toBe('AUTO')
      // Exactly 12 hours after the start, NOT 30. Closing at read time would mean the same
      // abandoned shift was worth more hours every time someone opened the page.
      expect(row.clockedOutAt?.getTime()).toBe(inAt.getTime() + AUTO_CLOSE_HOURS * 3600 * 1000)
    })

    it('leaves a fresh entry alone', async () => {
      const opened = await clockIn(staff)
      await resolveAbandoned(staffId)
      const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: opened.id } })
      expect(row.status).toBe('OPEN')
    })

    it('lets the person clock in again afterwards', async () => {
      const opened = await clockIn(staff)
      await prisma.timeEntry.update({
        where: { id: opened.id },
        data: { clockedInAt: new Date(Date.now() - 30 * 3600 * 1000) },
      })
      // The stale row is resolved on the way in, so the unique index does not block them.
      const fresh = await clockIn(staff)
      expect(fresh.status).toBe('OPEN')
      expect(fresh.id).not.toBe(opened.id)
    })
  })

  describe('totals', () => {
    it('keeps estimated minutes OUT of the real total and reports them separately', async () => {
      // One honest entry: 60 minutes.
      const a = await clockIn(staff)
      await prisma.timeEntry.update({
        where: { id: a.id },
        data: { clockedInAt: new Date(Date.now() - 60 * 60_000) },
      })
      await clockOut(staff)

      // One abandoned entry, auto-closed at the cutoff.
      const b = await prisma.timeEntry.create({
        data: {
          userId: staffId,
          storeId,
          clockedInAt: new Date(Date.now() - 40 * 3600 * 1000),
          status: 'OPEN',
        },
      })
      await resolveAbandoned(staffId)

      const result = await listEntries(admin, { userId: staffId })
      expect(result.totalMinutes).toBe(60)
      // 12 hours, and it must not be folded into the 60 — nobody should be paid from a
      // number the system invented without the screen saying so.
      expect(result.estimatedMinutes).toBe(AUTO_CLOSE_HOURS * 60)
      expect(result.entries.find((e) => e.id === b.id)?.status).toBe('AUTO')
    })

    it('excludes a voided entry from everything', async () => {
      const a = await clockIn(staff)
      await prisma.timeEntry.update({
        where: { id: a.id },
        data: { clockedInAt: new Date(Date.now() - 60 * 60_000) },
      })
      await clockOut(staff)
      await voidEntry(admin, a.id, 'Clocked in by mistake', adminId)

      const result = await listEntries(admin, { userId: staffId })
      expect(result.totalMinutes).toBe(0)
      expect(result.entries).toHaveLength(0)
      // Excluded, not deleted.
      expect(await prisma.timeEntry.count({ where: { id: a.id } })).toBe(1)
    })
  })

  describe('admin correction', () => {
    it('replaces a guessed end time and records who and why', async () => {
      const opened = await clockIn(staff)
      const inAt = new Date(Date.now() - 30 * 3600 * 1000)
      await prisma.timeEntry.update({ where: { id: opened.id }, data: { clockedInAt: inAt } })
      await resolveAbandoned(staffId)

      const realEnd = new Date(inAt.getTime() + 7 * 3600 * 1000)
      const fixed = await correctEntry(
        admin,
        opened.id,
        { clockedOutAt: realEnd.toISOString(), note: 'She left at 4pm' },
        adminId,
      )

      expect(fixed.status).toBe('CORRECTED')
      expect(fixed.minutes).toBe(7 * 60)
      expect(fixed.note).toBe('She left at 4pm')

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: opened.id, action: 'timeclock.correct' },
      })
      expect(audit.before).toHaveProperty('status', 'AUTO')
      expect(audit.after).toHaveProperty('status', 'CORRECTED')
    })

    it('refuses an end before the start, with a sentence rather than a constraint error', async () => {
      const opened = await clockIn(staff)
      await expect(
        correctEntry(
          admin,
          opened.id,
          { clockedOutAt: new Date(Date.now() - 3600 * 1000).toISOString(), note: 'nope' },
          adminId,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('refuses an end time in the future', async () => {
      const opened = await clockIn(staff)
      await expect(
        correctEntry(
          admin,
          opened.id,
          { clockedOutAt: new Date(Date.now() + 3600 * 1000).toISOString(), note: 'nope' },
          adminId,
        ),
      ).rejects.toThrow(ValidationError)
    })

    it('404s on an entry that does not exist', async () => {
      await expect(
        correctEntry(admin, 'cmt0000000000000000000000', { clockedOutAt: new Date().toISOString(), note: 'x' }, adminId),
      ).rejects.toThrow(NotFoundError)
    })

    it('is closed to staff', async () => {
      const opened = await clockIn(staff)
      await expect(
        correctEntry(staff, opened.id, { clockedOutAt: new Date().toISOString(), note: 'x' }, staffId),
      ).rejects.toThrow(ForbiddenError)
      await expect(listEntries(staff, {})).rejects.toThrow(ForbiddenError)
    })
  })

  describe('database invariants', () => {
    it('refuses an end at or before the start', async () => {
      const now = new Date()
      await expect(
        prisma.timeEntry.create({
          data: { userId: staffId, storeId, clockedInAt: now, clockedOutAt: now, status: 'CLOCKED' },
        }),
      ).rejects.toThrow()
    })

    it('refuses a closed status with no end time', async () => {
      await expect(
        prisma.timeEntry.create({
          data: { userId: staffId, storeId, status: 'CLOCKED' },
        }),
      ).rejects.toThrow()
    })

    it('refuses a correction with no reason', async () => {
      await expect(
        prisma.timeEntry.create({
          data: {
            userId: staffId,
            storeId,
            clockedInAt: new Date(Date.now() - 3600 * 1000),
            clockedOutAt: new Date(),
            status: 'CORRECTED',
          },
        }),
      ).rejects.toThrow()
    })
  })

  it('reports the open entry to the person it belongs to', async () => {
    expect(await currentEntry(staff)).toBeNull()
    await clockIn(staff)
    expect((await currentEntry(staff))?.status).toBe('OPEN')
    // An admin has no clock, so there is nothing to report.
    expect(await currentEntry(admin)).toBeNull()
  })
  describe('correcting the START time', () => {
    /** A finished entry, written directly so the times are ours to choose. */
    async function finished(startIso: string, minutes: number) {
      const start = new Date(startIso)
      return prisma.timeEntry.create({
        data: {
          userId: staffId,
          storeId,
          clockedInAt: start,
          clockedOutAt: new Date(start.getTime() + minutes * 60_000),
          status: 'CLOCKED',
        },
        select: { id: true },
      })
    }

    it('moves the start and re-derives the minutes', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 8 * 60)
      const fixed = await correctEntry(
        admin,
        entry.id,
        { clockedInAt: '2026-08-10T12:00:00.000Z', note: 'Clocked in an hour late.' },
        adminId,
      )
      expect(fixed.status).toBe('CORRECTED')
      expect(fixed.minutes).toBe(9 * 60)
    })

    it('moves both ends at once', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 8 * 60)
      const fixed = await correctEntry(
        admin,
        entry.id,
        {
          clockedInAt: '2026-08-10T14:00:00.000Z',
          clockedOutAt: '2026-08-10T19:30:00.000Z',
          note: 'Shift was 10 to 3:30.',
        },
        adminId,
      )
      expect(fixed.minutes).toBe(5 * 60 + 30)
    })

    /**
     * Fixing a start must NOT close somebody's shift for them —
     * `TimeEntry_status_pairing_check` requires an OPEN row to carry no end time.
     */
    it('leaves an entry that is still running OPEN', async () => {
      const open = await clockIn(staff)
      const fixed = await correctEntry(
        admin,
        open.id,
        { clockedInAt: new Date(Date.now() - 3600_000).toISOString(), note: 'Started at ten.' },
        adminId,
      )
      expect(fixed.status).toBe('OPEN')
      expect(fixed.clockedOutAt).toBeNull()
      expect(fixed.minutes).toBeNull()
    })

    it('refuses a start after the end', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 60)
      await expect(
        correctEntry(admin, entry.id, { clockedInAt: '2026-08-10T18:00:00.000Z', note: 'x' }, adminId),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('refuses a start in the future', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 60)
      await expect(
        correctEntry(
          admin,
          entry.id,
          { clockedInAt: new Date(Date.now() + 86_400_000).toISOString(), note: 'x' },
          adminId,
        ),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    /** A mis-keyed date is the likeliest mistake, and it would land 30 hours at time and a half. */
    it('refuses an entry longer than a day', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 60)
      await expect(
        correctEntry(
          admin,
          entry.id,
          { clockedInAt: '2026-08-08T13:00:00.000Z', note: 'wrong month' },
          adminId,
        ),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('refuses when nothing was supplied', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 60)
      await expect(
        correctEntry(admin, entry.id, { note: 'nothing to do' }, adminId),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('records BOTH original timestamps in the audit, since either may have moved', async () => {
      const entry = await finished('2026-08-10T13:00:00.000Z', 8 * 60)
      await correctEntry(
        admin,
        entry.id,
        { clockedInAt: '2026-08-10T12:00:00.000Z', note: 'Earlier start.' },
        adminId,
      )
      const log = await prisma.auditLog.findFirst({
        where: { entityId: entry.id, action: 'timeclock.correct' },
      })
      const before = log?.before as { clockedInAt?: string, clockedOutAt?: string }
      expect(before.clockedInAt).toBe('2026-08-10T13:00:00.000Z')
      expect(before.clockedOutAt).toBe('2026-08-10T21:00:00.000Z')
    })
  })
})

/**
 * ⚠️ The regression Kasan reported as two bugs: "on the clock" not showing in the back office,
 * and clocked-out hours "not recording".
 *
 * Both were ONE read bug and neither lost data. `listEntries` built its range with
 * `new Date('2026-08-22')` — and a bare `YYYY-MM-DD` is parsed as UTC MIDNIGHT by spec, so the
 * business day ended at 20:00 Eastern. Anything clocked after that fell into "tomorrow" and
 * dropped out of the range, taking `openCount` with it (it is counted over the same rows).
 *
 * Honolulu is UTC−10, so 06:00 UTC on the 21st is 20:00 on the 20th there — an instant whose
 * UTC date and store date differ. No UTC-boundary implementation can satisfy this.
 */
describe('timeclock business days', () => {
  let storeId: string
  let staff: StaffPrincipal
  let staffId: string
  let admin: AdminPrincipal

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Honolulu', 'honolulu', 'Pacific/Honolulu')
    storeId = store.id
    const terminal = await makeTerminal(storeId, 'device-token-tz')
    const person = await makeStaff(storeId, '1111')
    staffId = person.id
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId: terminal.id }
    const a = await makeAdmin()
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  /** 2026-08-21T06:00Z is 2026-08-20 20:00 in Honolulu — an evening shift, the day before. */
  const EVENING = new Date('2026-08-21T06:00:00Z')

  it('keeps an evening entry on the store\'s day, not UTC\'s', async () => {
    const entry = await clockIn(staff)
    await prisma.timeEntry.update({ where: { id: entry.id }, data: { clockedInAt: EVENING } })

    const onStoreDay = await listEntries(admin, { userId: staffId, from: '2026-08-20', to: '2026-08-20' })
    expect(onStoreDay.entries).toHaveLength(1)

    // ...and it is NOT on the 21st, which is only where UTC would have put it.
    const onUtcDay = await listEntries(admin, { userId: staffId, from: '2026-08-21', to: '2026-08-21' })
    expect(onUtcDay.entries).toHaveLength(0)
  })

  /**
   * The first of the two reported symptoms. `openCount` is derived from the ranged rows, so a
   * person clocked in during the evening read as NOT on the clock.
   *
   * Uses a LIVE entry, not a backdated one: `listEntries` calls `resolveAbandoned` first, and
   * anything older than the 12h cutoff is legitimately auto-closed, so a backdated entry can
   * never be OPEN. The store's current business day is computed the way the store sees it,
   * which is exactly the question the back office asks.
   */
  it('still counts someone as ON THE CLOCK today, in the store\'s day', async () => {
    await clockIn(staff)
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Honolulu',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())

    const page = await listEntries(admin, { userId: staffId, from: today, to: today })
    expect(page.entries).toHaveLength(1)
    expect(page.openCount).toBe(1)
  })

  /** The second symptom: finished hours vanishing from the Hours tab. */
  it('reports the minutes of an evening entry that has been clocked out', async () => {
    const entry = await clockIn(staff)
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        clockedInAt: EVENING,
        clockedOutAt: new Date(EVENING.getTime() + 90 * 60_000),
        status: 'CLOCKED',
      },
    })

    const page = await listEntries(admin, { userId: staffId, from: '2026-08-20', to: '2026-08-20' })
    expect(page.entries).toHaveLength(1)
    expect(page.totalMinutes).toBe(90)
  })

})
