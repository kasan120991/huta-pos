import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, ForbiddenError, ValidationError } from '../../src/errors/index.js'
import { listUsers } from '../../src/auth/user.service.js'
import { commitRun, getRun, previewRun } from '../../src/people/payroll.service.js'
import { listWageRates, resolveRateAt, setWageRate } from '../../src/people/wage.service.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/** Walks a payload for anything wage-shaped. Plain substrings, the `cost-keys.ts` rule — a
 *  word-boundary regex under /i is what let `unitCostCents` slip through for months. */
const WAGE_FRAGMENTS = ['wage', 'rateperhour', 'hourlyrate', 'salary', 'grosspay']
function findWageKeys(value: unknown, path = '$', found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    value.forEach((v, i) => findWageKeys(v, `${path}[${i}]`, found))
    return found
  }
  for (const [key, v] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (WAGE_FRAGMENTS.some((f) => lower.includes(f))) found.push(`${path}.${key}`)
    findWageKeys(v, `${path}.${key}`, found)
  }
  return found
}

describe('wages', () => {
  let storeId: string
  let staffId: string
  let staff: StaffPrincipal
  let admin: AdminPrincipal
  let adminId: string

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    storeId = store.id
    await prisma.store.update({ where: { id: storeId }, data: { timezone: 'America/New_York' } })
    const terminal = await makeTerminal(storeId, 'device-token-wage')
    const person = await makeStaff(storeId, '1111')
    staffId = person.id
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId: terminal.id }
    const a = await makeAdmin()
    adminId = a.id
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  const set = (cents: number, from: string, note?: string) =>
    setWageRate(admin, staffId, { ratePerHourCents: cents, effectiveFrom: from, note }, adminId)

  describe('effective dating', () => {
    it('snaps any date BACK to the Sunday of its week', async () => {
      // Wednesday 26 Aug 2026 — a new hire's start date. The whole of that week is covered,
      // which is the point of snapping backward rather than forward.
      const row = await set(1800, '2026-08-26')
      expect(row.effectiveFromDate).toBe('2026-08-23')
    })

    it('resolves the rate in force at an instant', async () => {
      await set(1500, '2026-08-09')
      await set(1800, '2026-08-23')

      const before = await resolveRateAt(prisma, staffId, new Date('2026-08-12T12:00:00.000Z'))
      const after = await resolveRateAt(prisma, staffId, new Date('2026-08-26T12:00:00.000Z'))
      expect(before?.ratePerHourCents).toBe(1500)
      expect(after?.ratePerHourCents).toBe(1800)
    })

    it('returns null before the first rate — never zero', async () => {
      await set(1500, '2026-08-23')
      const earlier = await resolveRateAt(prisma, staffId, new Date('2026-08-01T12:00:00.000Z'))
      expect(earlier).toBeNull()
    })

    it('lets a later row correct a typo on the same Sunday', async () => {
      await set(1500, '2026-08-09')
      await set(1550, '2026-08-09', 'Typo — should have been 15.50.')

      const at = await resolveRateAt(prisma, staffId, new Date('2026-08-12T12:00:00.000Z'))
      expect(at?.ratePerHourCents).toBe(1550)
      // Nothing is deleted; the wrong one survives as history.
      expect(await prisma.wageRate.count({ where: { userId: staffId } })).toBe(2)
    })

    it('marks exactly one row as current', async () => {
      await set(1500, '2026-08-09')
      await set(1800, '2026-08-23')
      const rows = await listWageRates(admin, staffId)
      expect(rows.filter((r) => r.current)).toHaveLength(1)
      expect(rows.find((r) => r.current)?.ratePerHourCents).toBe(1800)
    })
  })

  describe('refusals', () => {
    it('refuses a zero or negative wage', async () => {
      await expect(set(0, '2026-08-23')).rejects.toBeInstanceOf(ValidationError)
      await expect(set(-100, '2026-08-23')).rejects.toBeInstanceOf(ValidationError)
    })

    it('refuses a wage for an admin — admins are not on the clock', async () => {
      await expect(
        setWageRate(admin, adminId, { ratePerHourCents: 5000, effectiveFrom: '2026-08-23' }, adminId),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('refuses to change a week that has already been paid', async () => {
      await set(2000, '2026-08-09')
      await prisma.timeEntry.create({
        data: {
          userId: staffId,
          storeId,
          clockedInAt: new Date('2026-08-10T13:00:00.000Z'),
          clockedOutAt: new Date('2026-08-10T21:00:00.000Z'),
          status: 'CLOCKED',
        },
      })
      await commitRun(admin, '2026-08-09', undefined, adminId)

      // The remedy is to reverse the run, not to rewrite what was paid.
      await expect(set(2500, '2026-08-10')).rejects.toBeInstanceOf(ConflictError)
    })

    it('refuses a staff principal outright', async () => {
      await expect(listWageRates(staff, staffId)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(
        setWageRate(staff, staffId, { ratePerHourCents: 9999, effectiveFrom: '2026-08-23' }, staffId),
      ).rejects.toBeInstanceOf(ForbiddenError)
      await expect(previewRun(staff, '2026-08-09')).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  describe('a rate change inside a fortnight', () => {
    /**
     * The payoff of snapping `effectiveFrom` to a Sunday: each workweek carries exactly ONE
     * rate, so FLSA's blended-regular-rate rule (two rates inside one week) can never fire.
     * The two weeks of a period may still differ from each other, and each snapshots its own.
     */
    it('pays each week at its own rate and snapshots both', async () => {
      await set(2000, '2026-08-09')
      await set(2400, '2026-08-16')

      for (const day of ['10', '17']) {
        await prisma.timeEntry.create({
          data: {
            userId: staffId,
            storeId,
            clockedInAt: new Date(`2026-08-${day}T13:00:00.000Z`),
            clockedOutAt: new Date(`2026-08-${day}T21:00:00.000Z`),
            status: 'CLOCKED',
          },
        })
      }

      const run = await commitRun(admin, '2026-08-09', undefined, adminId)
      const detail = await getRun(admin, run.id)
      const weeks = detail.lines[0]!.weeks

      expect(weeks.map((w) => w.ratePerHourCents)).toEqual([2000, 2400])
      // Eight hours at $20 then eight at $24.
      expect(weeks[0]?.grossCents).toBe(16_000)
      expect(weeks[1]?.grossCents).toBe(19_200)
      expect(detail.lines[0]?.grossCents).toBe(35_200)
    })
  })

  describe('wages do not leak', () => {
    it('keeps wage-shaped keys out of the staff list, and proves the check is not vacuous', async () => {
      await set(1800, '2026-08-23')

      // The staff admin payload carries no wage — rates come from their own admin endpoint.
      const users = await listUsers(true)
      expect(findWageKeys(users)).toEqual([])

      // …and the wage endpoint really does return one, so the absence above means something.
      const rates = await listWageRates(admin, staffId)
      expect(findWageKeys(rates).length).toBeGreaterThan(0)
      expect(rates[0]?.ratePerHourCents).toBe(1800)
    })
  })
})
