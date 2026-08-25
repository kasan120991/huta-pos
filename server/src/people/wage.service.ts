import { assertCan } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors/index.js'
import { scopeTimezone, weekStartDateOf, zonedStartOfWeek } from '../lib/business-day.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * Hourly wages, effective-dated.
 *
 * Gated on `user.manage`, reusing rather than minting a `payroll.manage` — the precedent
 * `listEntries` sets, because there are two roles and an admin holds everything, so a new
 * capability would add a row to the permission matrix with no behavioural difference.
 *
 * ⚠️ Worth recording honestly: `user.manage` currently means "edit the staff list and fix
 * timesheets", while this means "see everyone's wage". If a store-manager role ever appears,
 * wages are the first thing you would withhold, and this is the one call site where splitting
 * the capability would be more than a rename.
 */

type Db = Prisma.TransactionClient | typeof prisma

export interface ResolvedRate {
  readonly id: string
  readonly ratePerHourCents: number
}

async function reportingTimezone(): Promise<string> {
  const stores = await prisma.store.findMany({
    where: { active: true },
    select: { id: true, name: true, timezone: true },
  })
  return scopeTimezone(stores)
}

/**
 * The rate in force for one person at one instant, or null when nobody has set one.
 *
 * Null, never zero. A zero rate would produce a pay line that satisfies every CHECK and pays
 * nothing, which is the failure this whole module is arranged to make impossible.
 *
 * Ties on `effectiveFrom` break on `createdAt` then `id`, so the ordering is TOTAL — two rows
 * keyed for the same Sunday (which is how a typo gets corrected) must not resolve differently
 * on two runs of the same computation.
 */
export async function resolveRateAt(
  db: Db,
  userId: string,
  at: Date,
): Promise<ResolvedRate | null> {
  const row = await db.wageRate.findFirst({
    where: { userId, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, ratePerHourCents: true },
  })
  return row
}

/**
 * Rates for many people across a handful of week starts, in ONE query.
 *
 * Payroll must use this rather than looping `resolveRateAt`: N people × 2 weeks would be 2N
 * round trips, the exact cost pattern `activity.service.ts` documents refusing. The row count
 * is bounded by how many raises have ever been recorded, which is a handful for the life of
 * the business.
 *
 * Keyed `userId -> weekStartDate -> rate`.
 */
export async function resolveRatesForWeeks(
  db: Db,
  userIds: readonly string[],
  weekStarts: readonly Date[],
): Promise<Map<string, Map<string, ResolvedRate>>> {
  const out = new Map<string, Map<string, ResolvedRate>>()
  if (userIds.length === 0 || weekStarts.length === 0) return out

  const latest = weekStarts.reduce((a, b) => (a > b ? a : b))
  const rows = await db.wageRate.findMany({
    where: { userId: { in: [...userIds] }, effectiveFrom: { lte: latest } },
    orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, userId: true, ratePerHourCents: true, effectiveFrom: true },
  })

  const timeZone = await reportingTimezone()
  for (const userId of userIds) {
    const mine = rows.filter((r) => r.userId === userId)
    const byWeek = new Map<string, ResolvedRate>()
    for (const start of weekStarts) {
      // Ascending scan keeping the last row at or before the week start — the same answer
      // resolveRateAt gives, with the same total ordering, without a query per week.
      let found: ResolvedRate | null = null
      for (const row of mine) {
        if (row.effectiveFrom.getTime() <= start.getTime()) {
          found = { id: row.id, ratePerHourCents: row.ratePerHourCents }
        }
      }
      if (found) byWeek.set(weekStartDateOf(start, timeZone), found)
    }
    out.set(userId, byWeek)
  }
  return out
}

export interface WageRateRow {
  readonly id: string
  readonly userId: string
  readonly ratePerHourCents: number
  readonly effectiveFromDate: string
  readonly setByName: string
  readonly note: string | null
  readonly createdAt: string
  /** True for the row currently in force — what the staff page shows as "the" rate. */
  readonly current: boolean
}

export async function listWageRates(
  principal: Principal,
  userId: string,
): Promise<WageRateRow[]> {
  assertCan(principal, 'user.manage')

  const rows = await prisma.wageRate.findMany({
    where: { userId },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      userId: true,
      ratePerHourCents: true,
      effectiveFromDate: true,
      effectiveFrom: true,
      note: true,
      createdAt: true,
      setBy: { select: { firstName: true, lastName: true } },
    },
  })

  const now = Date.now()
  const currentId = rows.find((r) => r.effectiveFrom.getTime() <= now)?.id ?? null

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    ratePerHourCents: r.ratePerHourCents,
    effectiveFromDate: r.effectiveFromDate,
    setByName: `${r.setBy.firstName} ${r.setBy.lastName}`.trim(),
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    current: r.id === currentId,
  }))
}

export interface SetWageInput {
  readonly ratePerHourCents: number
  /** Any date; it is snapped BACKWARD to the Sunday of its week. */
  readonly effectiveFrom: string
  readonly note?: string | undefined
}

/**
 * Record a wage, effective from the Sunday of the supplied date's week.
 *
 * ⚠️ Snapping BACKWARD is deliberate and has a payoff: setting a new hire's rate on their
 * Wednesday start date covers that whole first week. Snapping forward would leave those days
 * unpayable with no obvious remedy. The cost is that a mid-week raise applies to the whole of
 * that week, and the dialog must say so out loud.
 */
export async function setWageRate(
  principal: Principal,
  userId: string,
  input: SetWageInput,
  actorId: string,
): Promise<WageRateRow> {
  assertCan(principal, 'user.manage')

  if (!Number.isInteger(input.ratePerHourCents) || input.ratePerHourCents <= 0) {
    // Refuse before the CHECK does, with a sentence that says what is wrong.
    throw new ValidationError('An hourly wage must be more than zero.')
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, firstName: true },
  })
  if (!user) throw new NotFoundError('That person is not on the staff list.')
  // Admins are not on the clock, so they have no hours and cannot have gross pay. Cross-table,
  // so this cannot be a CHECK — service plus a test, the way User's role rules are handled.
  if (user.role === 'ADMIN') {
    throw new ValidationError('Admins are not on the clock, so they have no hourly wage.')
  }

  const timeZone = await reportingTimezone()
  const effectiveFrom = zonedStartOfWeek(input.effectiveFrom, timeZone)
  const effectiveFromDate = weekStartDateOf(effectiveFrom, timeZone)

  // You cannot change what has already been paid. The remedy is to reverse the run first.
  const paid = await prisma.payRun.findFirst({
    where: {
      status: 'COMMITTED',
      periodStart: { lte: effectiveFrom },
      periodEnd: { gt: effectiveFrom },
      lines: { some: { userId } },
    },
    select: { periodStartDate: true },
  })
  if (paid) {
    throw new ConflictError(
      `That week is inside a pay run that has already been committed (${paid.periodStartDate}). Reverse the run before changing the rate.`,
    )
  }

  const created = await prisma.wageRate.create({
    data: {
      userId,
      ratePerHourCents: input.ratePerHourCents,
      effectiveFrom,
      effectiveFromDate,
      setById: actorId,
      note: input.note?.trim() || null,
    },
    select: { id: true },
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'payroll.wage.set',
      entityType: 'WageRate',
      entityId: created.id,
      // Append-only: there is no prior row to diff against, so `before` is genuinely empty.
      before: {},
      after: {
        userId,
        ratePerHourCents: input.ratePerHourCents,
        effectiveFromDate,
      },
    },
  })

  const rows = await listWageRates(principal, userId)
  return rows.find((r) => r.id === created.id)!
}
