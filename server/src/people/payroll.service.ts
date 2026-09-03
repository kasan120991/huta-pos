import {
  extendOvertime,
  extendPerHour,
  splitWorkweekMinutes,
  unsafe,
} from '@huta/shared'
import type {
  PayRunRow,
  PayrollBlocker,
  PayrollLine,
  PayrollPreview,
  PayWeekRow,
  PeriodSummary,
  PersonPayLine,
  PersonPaySummary,
} from '@huta/shared/schemas'
import { assertCan } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors/index.js'
import {
  scopeTimezone,
  timezonesAgree,
  weekStartDateOf,
  weeksBetween,
  zonedStartOfWeek,
} from '../lib/business-day.js'
import { minutesOf, resolveAbandoned } from './timeclock.service.js'
import { resolveRatesForWeeks } from './wage.service.js'

/**
 * Gross payroll, computed from the timeclock.
 *
 * ⚠️ GROSS ONLY — hours × rate, plus FLSA overtime. Nothing here withholds tax, computes net
 * pay, or files anything. That figure goes to a payroll provider or an accountant, who does
 * the withholding. Hourly NON-EXEMPT staff only; there is no salary concept and no exempt
 * flag, so nobody salaried may be run through this.
 *
 * A run is a PURE FUNCTION of (payable entries, wage rates, period boundaries). That is what
 * makes reversing and re-committing an unchanged period produce identical totals, which is in
 * turn what makes reversal safe. Nothing is scheduled — there is no cron in this codebase and
 * this does not add one.
 *
 * ⚠️ Business-wide, never per store. People work at both locations since 2026-08-22, so a
 * per-store run would test overtime against two separate forty-hour thresholds and understate
 * it — a wage violation rather than a display bug. The only store-scoped part of payroll is
 * the till a cash payout leaves from, which has nothing to do with where the hours were worked.
 */

/**
 * Every pay period starts an even number of weeks after this Sunday (Kasan, 2026-08-24), so
 * periods tile the calendar forever with no gaps and no overlaps even when a run is skipped.
 */
export const PAY_PERIOD_ANCHOR_SUNDAY = '2026-08-23'

/** A fortnight. */
export const PAY_PERIOD_WEEKS = 2

/**
 * Only a closed, human-attested entry is payable.
 *
 * `AUTO` is excluded and BLOCKS the run: its end time is a guess the system made at the
 * cutoff, and the shared `TimeEntryPage` schema already says what paying from it would mean.
 * `OPEN` blocks too — there is nothing to measure yet. `VOIDED` is excluded silently, because
 * a discarded entry is not a problem to be fixed.
 */
const PAYABLE_STATUSES = ['CLOCKED', 'CORRECTED'] as const

/** A week returning more rows than this is a bug or an import, not a fortnight of work. */
const SANITY_ROW_LIMIT = 5000

async function reportingStores() {
  const stores = await prisma.store.findMany({
    where: { active: true },
    select: { id: true, name: true, timezone: true },
  })
  if (!timezonesAgree(stores)) {
    // Refuse rather than guess. A workweek boundary cut in one store's zone for another
    // store's employee is money-wrong, not merely misdated. Never fires today.
    throw new ConflictError(
      'Stores are in different timezones, so one workweek boundary cannot be right for everyone. Payroll needs a per-store design before it can run.',
    )
  }
  return { stores, timeZone: scopeTimezone(stores) }
}

/** Boundaries for a period, with the two workweeks inside it. */
export function periodBounds(periodStartDate: string, timeZone: string) {
  const weeks = Array.from({ length: PAY_PERIOD_WEEKS }, (_, i) => {
    const start = zonedStartOfWeek(periodStartDate, timeZone, i)
    const end = zonedStartOfWeek(periodStartDate, timeZone, i + 1)
    return { weekStartDate: weekStartDateOf(start, timeZone), start, end }
  })
  return {
    periodStart: weeks[0]!.start,
    // ⚠️ zonedStartOfWeek, never start + 14 days — a fortnight across a DST change is 13d23h
    // or 14d1h, and an hour of error at the boundary misfiles a Sunday-morning entry.
    periodEnd: zonedStartOfWeek(periodStartDate, timeZone, PAY_PERIOD_WEEKS),
    weeks,
  }
}

/**
 * The last DAY of a period, as `YYYY-MM-DD` — the Saturday a fortnight closes on.
 *
 * Calendar arithmetic on the bare date, never on the zoned instant: `periodEnd` is the
 * exclusive start of the NEXT period, so subtracting a day from it in instant space would
 * land at 23:00 or 01:00 on a DST fortnight and name the wrong Saturday.
 */
function periodEndDateOf(periodStartDate: string): string {
  const [y, m, d] = periodStartDate.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + PAY_PERIOD_WEEKS * 7 - 1)).toISOString().slice(0, 10)
}

function assertAlignedPeriod(periodStartDate: string): void {
  const offset = weeksBetween(PAY_PERIOD_ANCHOR_SUNDAY, periodStartDate)
  if (!Number.isInteger(offset) || Math.abs(offset % PAY_PERIOD_WEEKS) !== 0) {
    throw new ValidationError(
      `Pay periods run fortnightly from ${PAY_PERIOD_ANCHOR_SUNDAY}. ${periodStartDate} is not one of them.`,
    )
  }
}

/** The last `count` fortnights, newest first, each flagged run or not. */
export async function listPeriods(principal: Principal, count = 6): Promise<PeriodSummary[]> {
  assertCan(principal, 'user.manage')
  const { timeZone } = await reportingStores()

  const currentStart = weekStartDateOf(new Date(), timeZone)
  // Step back to the nearest ALIGNED Sunday — the current week may be the second of a period.
  const drift = Math.abs(weeksBetween(PAY_PERIOD_ANCHOR_SUNDAY, currentStart) % PAY_PERIOD_WEEKS)
  const anchoredNow = zonedStartOfWeek(currentStart, timeZone, -drift)
  const anchoredNowDate = weekStartDateOf(anchoredNow, timeZone)

  const starts = Array.from({ length: count }, (_, i) =>
    weekStartDateOf(
      zonedStartOfWeek(anchoredNowDate, timeZone, -i * PAY_PERIOD_WEEKS),
      timeZone,
    ),
  )

  const runs = await prisma.payRun.findMany({
    where: { periodStartDate: { in: starts }, status: 'COMMITTED' },
    select: { id: true, periodStartDate: true, grossCents: true },
  })
  const byPeriod = new Map(runs.map((r) => [r.periodStartDate, r]))
  const now = Date.now()

  return starts.map((periodStartDate) => {
    const { periodEnd } = periodBounds(periodStartDate, timeZone)
    const run = byPeriod.get(periodStartDate) ?? null
    return {
      periodStartDate,
      periodEndDate: periodEndDateOf(periodStartDate),
      inProgress: periodEnd.getTime() > now,
      runId: run?.id ?? null,
      grossCents: run?.grossCents ?? null,
    }
  })
}

/**
 * Compute a period without writing anything.
 *
 * ⚠️ Returns blockers rather than throwing. An admin needs to see WHAT to fix, and a 400 with
 * one sentence cannot list six entries across three people.
 */
export async function previewRun(
  principal: Principal,
  periodStartDate: string,
): Promise<PayrollPreview> {
  assertCan(principal, 'user.manage')
  assertAlignedPeriod(periodStartDate)

  // Materialise anything abandoned FIRST, so a forgotten clock-out shows up as the AUTO
  // blocker it is rather than an OPEN one that silently disappears mid-computation. Before
  // any transaction: this writes, and a write inside the commit lock invites a deadlock.
  await resolveAbandoned()

  const { timeZone } = await reportingStores()
  const { periodStart, periodEnd, weeks } = periodBounds(periodStartDate, timeZone)
  if (weekStartDateOf(periodStart, timeZone) !== periodStartDate) {
    throw new ValidationError(`${periodStartDate} is not a Sunday.`)
  }

  const blockers: PayrollBlocker[] = []
  const notes: string[] = []

  // Anything unfinished or estimated inside the window blocks the run.
  const unfinished = await prisma.timeEntry.findMany({
    where: {
      clockedInAt: { gte: periodStart, lt: periodEnd },
      status: { in: ['OPEN', 'AUTO'] },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      clockedInAt: true,
      user: { select: { firstName: true, lastName: true } },
    },
    orderBy: { clockedInAt: 'asc' },
  })
  for (const entry of unfinished) {
    blockers.push({
      kind: entry.status === 'OPEN' ? 'OPEN_ENTRY' : 'ESTIMATED_ENTRY',
      userId: entry.userId,
      userName: `${entry.user.firstName} ${entry.user.lastName}`.trim(),
      timeEntryId: entry.id,
      at: entry.clockedInAt.toISOString(),
    })
  }

  // Payable entries, one ranged query per workweek. Deliberately NOT `listEntries`, whose
  // `take: 500` with JS aggregation would silently truncate the totals — and under-reporting
  // pays somebody less than they earned. The window is two weeks by construction, so a guard
  // that REFUSES is right where a cap that truncates is not.
  const byUserWeek = new Map<string, Map<string, number>>()
  const names = new Map<string, string>()
  let crossesMidnight = 0

  for (const week of weeks) {
    const rows = await prisma.timeEntry.findMany({
      where: {
        clockedInAt: { gte: week.start, lt: week.end },
        status: { in: [...PAYABLE_STATUSES] },
      },
      select: {
        id: true,
        userId: true,
        clockedInAt: true,
        clockedOutAt: true,
        user: { select: { firstName: true, lastName: true } },
      },
    })
    if (rows.length > SANITY_ROW_LIMIT) {
      throw new ConflictError(
        `That week holds ${rows.length} time entries, which is not a week of work. Payroll refuses rather than reporting a partial figure.`,
      )
    }
    for (const row of rows) {
      names.set(row.userId, `${row.user.firstName} ${row.user.lastName}`.trim())
      // The SAME function the Hours tab renders — payroll agrees with the timesheet because
      // it calls one implementation, not because two were written to match.
      const minutes = minutesOf(row)
      if (minutes === null) continue
      if (row.clockedOutAt && row.clockedOutAt.getTime() >= week.end.getTime()) crossesMidnight += 1
      const mine = byUserWeek.get(row.userId) ?? new Map<string, number>()
      mine.set(week.weekStartDate, (mine.get(week.weekStartDate) ?? 0) + minutes)
      byUserWeek.set(row.userId, mine)
    }
  }

  if (crossesMidnight > 0) {
    notes.push(
      `${crossesMidnight} ${crossesMidnight === 1 ? 'entry runs' : 'entries run'} past the end of the week they started in. Each counts wholly in the week it began, matching the Hours tab.`,
    )
  }

  const userIds = [...byUserWeek.keys()]
  const rates = await resolveRatesForWeeks(
    prisma,
    userIds,
    weeks.map((w) => w.start),
  )

  const lines: PayrollLine[] = []
  for (const userId of userIds) {
    const perWeek = byUserWeek.get(userId)!
    const weekPreviews: PayWeekRow[] = []

    for (const week of weeks) {
      const minutesWorked = perWeek.get(week.weekStartDate) ?? 0
      if (minutesWorked <= 0) continue

      const rate = rates.get(userId)?.get(week.weekStartDate)
      if (!rate) {
        // A blocker, never a zero — a week at rate 0 satisfies every CHECK and pays nothing.
        blockers.push({
          kind: 'NO_WAGE_RATE',
          userId,
          userName: names.get(userId) ?? 'Unknown',
          weekStartDate: week.weekStartDate,
        })
        continue
      }

      const { regularMinutes, overtimeMinutes } = splitWorkweekMinutes(minutesWorked)
      const perHour = unsafe.centsPerHour(rate.ratePerHourCents)
      const regularCents = extendPerHour(perHour, regularMinutes)
      const overtimeCents = extendOvertime(perHour, overtimeMinutes)

      weekPreviews.push({
        weekStartDate: week.weekStartDate,
        minutesWorked,
        regularMinutes,
        overtimeMinutes,
        ratePerHourCents: rate.ratePerHourCents,
        regularCents,
        overtimeCents,
        grossCents: regularCents + overtimeCents,
      })
    }

    if (weekPreviews.length === 0) continue

    const sum = (pick: (w: PayWeekRow) => number) =>
      weekPreviews.reduce((a, w) => a + pick(w), 0)

    lines.push({
      userId,
      userName: names.get(userId) ?? 'Unknown',
      totalMinutes: sum((w) => w.minutesWorked),
      regularMinutes: sum((w) => w.regularMinutes),
      overtimeMinutes: sum((w) => w.overtimeMinutes),
      regularCents: sum((w) => w.regularCents),
      overtimeCents: sum((w) => w.overtimeCents),
      grossCents: sum((w) => w.grossCents),
      weeks: weekPreviews,
    })
  }

  lines.sort((a, b) => a.userName.localeCompare(b.userName))

  const committed = await prisma.payRun.findFirst({
    where: { periodStartDate, status: 'COMMITTED' },
    select: { id: true },
  })

  const total = (pick: (l: PayrollLine) => number) =>
    lines.reduce((a, l) => a + pick(l), 0)

  return {
    periodStartDate,
    periodEndDate: periodEndDateOf(periodStartDate),
    timezone: timeZone,
    payable: blockers.length === 0 && lines.length > 0,
    blockers,
    notes,
    lines,
    totalMinutes: total((l) => l.totalMinutes),
    overtimeMinutes: total((l) => l.overtimeMinutes),
    regularCents: total((l) => l.regularCents),
    overtimeCents: total((l) => l.overtimeCents),
    grossCents: total((l) => l.grossCents),
    committedRunId: committed?.id ?? null,
  }
}

/**
 * Commit a period.
 *
 * The blocker assessment is re-run here rather than trusted from the preview: they are
 * separate HTTP requests minutes apart, and another admin may have corrected — or broken — a
 * timesheet in between.
 */
export async function commitRun(
  principal: Principal,
  periodStartDate: string,
  note: string | undefined,
  actorId: string,
): Promise<PayRunRow> {
  assertCan(principal, 'user.manage')

  const preview = await previewRun(principal, periodStartDate)

  const { timeZone } = await reportingStores()
  const { periodStart, periodEnd, weeks } = periodBounds(periodStartDate, timeZone)

  if (periodEnd.getTime() > Date.now()) {
    throw new ConflictError('That fortnight has not finished yet.')
  }
  if (preview.blockers.length > 0) {
    const first = preview.blockers[0]!
    throw new ConflictError(
      `${preview.blockers.length} ${preview.blockers.length === 1 ? 'thing needs' : 'things need'} fixing before this period can be paid — starting with ${first.userName}.`,
    )
  }
  if (preview.lines.length === 0) {
    throw new ConflictError('Nobody worked in that period.')
  }

  const weekBounds = new Map(weeks.map((w) => [w.weekStartDate, w]))

  try {
    const created = await prisma.$transaction(async (tx) => {
      const run = await tx.payRun.create({
        data: {
          periodStartDate,
          periodStart,
          periodEnd,
          // Snapshotted: a later change to Store.timezone must not re-date a committed run.
          timezone: timeZone,
          status: 'COMMITTED',
          totalMinutes: preview.totalMinutes,
          overtimeMinutes: preview.overtimeMinutes,
          regularCents: preview.regularCents,
          overtimeCents: preview.overtimeCents,
          grossCents: preview.grossCents,
          committedById: actorId,
          note: note?.trim() || null,
        },
        select: { id: true },
      })

      for (const line of preview.lines) {
        await tx.payLine.create({
          data: {
            payRunId: run.id,
            userId: line.userId,
            totalMinutes: line.totalMinutes,
            regularMinutes: line.regularMinutes,
            overtimeMinutes: line.overtimeMinutes,
            regularCents: line.regularCents,
            overtimeCents: line.overtimeCents,
            grossCents: line.grossCents,
            weeks: {
              create: line.weeks.map((w) => ({
                weekStartDate: w.weekStartDate,
                weekStart: weekBounds.get(w.weekStartDate)!.start,
                weekEnd: weekBounds.get(w.weekStartDate)!.end,
                minutesWorked: w.minutesWorked,
                regularMinutes: w.regularMinutes,
                overtimeMinutes: w.overtimeMinutes,
                ratePerHourCents: w.ratePerHourCents,
                regularCents: w.regularCents,
                overtimeCents: w.overtimeCents,
                grossCents: w.grossCents,
              })),
            },
          },
        })
      }
      return run
    })

    await prisma.auditLog.create({
      data: {
        userId: actorId,
        action: 'payroll.run.commit',
        entityType: 'PayRun',
        entityId: created.id,
        before: {},
        // The totals and the line count, not every line — an audit row is not a second copy
        // of the table.
        after: {
          periodStartDate,
          lineCount: preview.lines.length,
          totalMinutes: preview.totalMinutes,
          grossCents: preview.grossCents,
        },
      },
    })

    return await getRunRow(created.id)
  } catch (error) {
    // The partial unique index is the serialiser for two admins committing at once. Prisma 7
    // with the pg adapter does not populate meta.target, so duck-type both.
    const e = error as { code?: string, message?: string }
    if (e.code === 'P2002' || (e.message ?? '').includes('PayRun_one_live_per_period')) {
      throw new ConflictError('That period has already been run.')
    }
    throw error
  }
}

async function getRunRow(id: string): Promise<PayRunRow> {
  const run = await prisma.payRun.findUnique({
    where: { id },
    select: {
      id: true,
      periodStartDate: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      timezone: true,
      totalMinutes: true,
      overtimeMinutes: true,
      regularCents: true,
      overtimeCents: true,
      grossCents: true,
      committedAt: true,
      reversedAt: true,
      reversalNote: true,
      note: true,
      committedBy: { select: { firstName: true, lastName: true } },
      reversedBy: { select: { firstName: true, lastName: true } },
      _count: { select: { lines: true } },
    },
  })
  if (!run) throw new NotFoundError('That pay run does not exist.')

  const paidCents = await paidOnRun(id)

  return {
    id: run.id,
    periodStartDate: run.periodStartDate,
    periodEndDate: periodEndDateOf(run.periodStartDate),
    status: run.status,
    timezone: run.timezone,
    totalMinutes: run.totalMinutes,
    overtimeMinutes: run.overtimeMinutes,
    regularCents: run.regularCents,
    overtimeCents: run.overtimeCents,
    grossCents: run.grossCents,
    committedByName: `${run.committedBy.firstName} ${run.committedBy.lastName}`.trim(),
    committedAt: run.committedAt.toISOString(),
    reversedByName: run.reversedBy
      ? `${run.reversedBy.firstName} ${run.reversedBy.lastName}`.trim()
      : null,
    reversedAt: run.reversedAt?.toISOString() ?? null,
    reversalNote: run.reversalNote,
    note: run.note,
    lineCount: run._count.lines,
    paidCents,
    outstandingCents: run.grossCents - paidCents,
  }
}

/**
 * What has actually been paid out against one run — payouts that still stand.
 *
 * `getRun` derives the same figure per line from the payouts it has already loaded; this is
 * for the paths that do not load lines. Both filter `reversedAt: null` for the same reason:
 * a reversed payout is money that came back, so counting it would report a person as paid
 * when they are owed.
 */
async function paidOnRun(runId: string): Promise<number> {
  const agg = await prisma.payPayout.aggregate({
    where: { reversedAt: null, payLine: { payRunId: runId } },
    _sum: { amountCents: true },
  })
  return agg._sum.amountCents ?? 0
}

/**
 * Every run, newest first.
 *
 * ⚠️ TWO queries whatever the run count. This used to select ids and then call `getRunRow`
 * in a loop — a hundred sequential round trips for a hundred runs, the exact cost pattern
 * `activity.service.ts` documents refusing. The payouts come back in ONE `groupBy` and are
 * joined in memory, the way `listShifts` gets its sale counts.
 */
export async function listRuns(principal: Principal): Promise<PayRunRow[]> {
  assertCan(principal, 'user.manage')

  const runs = await prisma.payRun.findMany({
    orderBy: [{ periodStart: 'desc' }, { committedAt: 'desc' }],
    select: {
      id: true,
      periodStartDate: true,
      status: true,
      timezone: true,
      totalMinutes: true,
      overtimeMinutes: true,
      regularCents: true,
      overtimeCents: true,
      grossCents: true,
      committedAt: true,
      reversedAt: true,
      reversalNote: true,
      note: true,
      committedBy: { select: { firstName: true, lastName: true } },
      reversedBy: { select: { firstName: true, lastName: true } },
      _count: { select: { lines: true } },
    },
    take: 100,
  })
  if (runs.length === 0) return []

  // `PayPayout` hangs off the LINE, not the run, so the run id is only reachable through the
  // relation — group by the line and fold up.
  const lines = await prisma.payLine.findMany({
    where: { payRunId: { in: runs.map((r) => r.id) } },
    select: {
      payRunId: true,
      payouts: { where: { reversedAt: null }, select: { amountCents: true } },
    },
  })

  const paidByRun = new Map<string, number>()
  for (const line of lines) {
    const sum = line.payouts.reduce((a, p) => a + p.amountCents, 0)
    paidByRun.set(line.payRunId, (paidByRun.get(line.payRunId) ?? 0) + sum)
  }

  return runs.map((run) => {
    const paidCents = paidByRun.get(run.id) ?? 0
    return {
      id: run.id,
      periodStartDate: run.periodStartDate,
      periodEndDate: periodEndDateOf(run.periodStartDate),
      status: run.status,
      timezone: run.timezone,
      totalMinutes: run.totalMinutes,
      overtimeMinutes: run.overtimeMinutes,
      regularCents: run.regularCents,
      overtimeCents: run.overtimeCents,
      grossCents: run.grossCents,
      committedByName: `${run.committedBy.firstName} ${run.committedBy.lastName}`.trim(),
      committedAt: run.committedAt.toISOString(),
      reversedByName: run.reversedBy
        ? `${run.reversedBy.firstName} ${run.reversedBy.lastName}`.trim()
        : null,
      reversedAt: run.reversedAt?.toISOString() ?? null,
      reversalNote: run.reversalNote,
      note: run.note,
      lineCount: run._count.lines,
      paidCents,
      outstandingCents: run.grossCents - paidCents,
    }
  })
}

export async function getRun(principal: Principal, id: string) {
  assertCan(principal, 'user.manage')
  const row = await getRunRow(id)
  const lines = await prisma.payLine.findMany({
    where: { payRunId: id },
    orderBy: { user: { firstName: 'asc' } },
    select: {
      id: true,
      userId: true,
      totalMinutes: true,
      regularMinutes: true,
      overtimeMinutes: true,
      regularCents: true,
      overtimeCents: true,
      grossCents: true,
      user: { select: { firstName: true, lastName: true } },
      weeks: {
        orderBy: { weekStartDate: 'asc' },
        select: {
          weekStartDate: true,
          minutesWorked: true,
          regularMinutes: true,
          overtimeMinutes: true,
          ratePerHourCents: true,
          regularCents: true,
          overtimeCents: true,
          grossCents: true,
        },
      },
      payouts: {
        orderBy: { paidAt: 'asc' },
        select: {
          id: true,
          method: true,
          amountCents: true,
          reference: true,
          note: true,
          paidAt: true,
          reversedAt: true,
          reversalNote: true,
          paidBy: { select: { firstName: true, lastName: true } },
        },
      },
    },
  })

  return {
    ...row,
    lines: lines.map((l) => {
      const paidCents = l.payouts
        .filter((p) => p.reversedAt === null)
        .reduce((a, p) => a + p.amountCents, 0)
      return {
        id: l.id,
        userId: l.userId,
        userName: `${l.user.firstName} ${l.user.lastName}`.trim(),
        totalMinutes: l.totalMinutes,
        regularMinutes: l.regularMinutes,
        overtimeMinutes: l.overtimeMinutes,
        regularCents: l.regularCents,
        overtimeCents: l.overtimeCents,
        grossCents: l.grossCents,
        paidCents,
        outstandingCents: l.grossCents - paidCents,
        weeks: l.weeks,
        payouts: l.payouts.map((p) => ({
          id: p.id,
          method: p.method,
          amountCents: p.amountCents,
          reference: p.reference,
          note: p.note,
          paidAt: p.paidAt.toISOString(),
          paidByName: `${p.paidBy.firstName} ${p.paidBy.lastName}`.trim(),
          reversedAt: p.reversedAt?.toISOString() ?? null,
          reversalNote: p.reversalNote,
        })),
      }
    }),
  }
}

/**
 * Supersede a committed run.
 *
 * The lines and weeks are left UNTOUCHED, keeping the exact figures that were committed —
 * that is what makes this an audit record rather than an erasure. The partial unique index
 * then permits a fresh run for the same period, and both survive.
 */
export async function reverseRun(
  principal: Principal,
  id: string,
  note: string,
  actorId: string,
): Promise<PayRunRow> {
  assertCan(principal, 'user.manage')

  const run = await prisma.payRun.findUnique({
    where: { id },
    select: { id: true, status: true, grossCents: true, periodStartDate: true },
  })
  if (!run) throw new NotFoundError('That pay run does not exist.')
  if (run.status === 'REVERSED') throw new ConflictError('That run has already been reversed.')
  if (!note.trim()) throw new ValidationError('A reversal needs a reason.')

  // Money that has left the building cannot be un-run by a status flip.
  const outstanding = await prisma.payPayout.count({
    where: { payLine: { payRunId: id }, reversedAt: null },
  })
  if (outstanding > 0) {
    throw new ConflictError(
      `Reverse the ${outstanding} ${outstanding === 1 ? 'payout' : 'payouts'} on this run first — money has already gone out against it.`,
    )
  }

  await prisma.payRun.update({
    where: { id },
    data: {
      status: 'REVERSED',
      reversedById: actorId,
      reversedAt: new Date(),
      reversalNote: note.trim(),
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'payroll.run.reverse',
      entityType: 'PayRun',
      entityId: id,
      before: { periodStartDate: run.periodStartDate, grossCents: run.grossCents },
      after: { status: 'REVERSED', reversalNote: note.trim() },
    },
  })

  return getRunRow(id)
}

/**
 * Everything one person has been paid, across every run.
 *
 * Totals cover COMMITTED runs only — a reversed run was superseded, and counting it would
 * double what somebody earned. Reversed runs still appear in the list, greyed, because they
 * are part of the record.
 */
export async function payLinesForUser(
  principal: Principal,
  userId: string,
): Promise<PersonPaySummary> {
  assertCan(principal, 'user.manage')

  const lines = await prisma.payLine.findMany({
    where: { userId },
    orderBy: { payRun: { periodStart: 'desc' } },
    select: {
      id: true,
      totalMinutes: true,
      overtimeMinutes: true,
      grossCents: true,
      payRun: {
        select: { id: true, periodStartDate: true, status: true },
      },
      payouts: {
        where: { reversedAt: null },
        select: { amountCents: true, method: true },
      },
    },
    take: 60,
  })

  const rows: PersonPayLine[] = lines.map((l) => {
    const paidCents = l.payouts.reduce((a, p) => a + p.amountCents, 0)
    return {
      payLineId: l.id,
      payRunId: l.payRun.id,
      periodStartDate: l.payRun.periodStartDate,
      periodEndDate: periodEndDateOf(l.payRun.periodStartDate),
      runStatus: l.payRun.status,
      totalMinutes: l.totalMinutes,
      overtimeMinutes: l.overtimeMinutes,
      grossCents: l.grossCents,
      paidCents,
      outstandingCents: l.grossCents - paidCents,
      methods: [...new Set(l.payouts.map((p) => p.method))],
    }
  })

  const live = rows.filter((r) => r.runStatus === 'COMMITTED')
  return {
    lines: rows,
    grossCents: live.reduce((a, r) => a + r.grossCents, 0),
    paidCents: live.reduce((a, r) => a + r.paidCents, 0),
    outstandingCents: live.reduce((a, r) => a + r.outstandingCents, 0),
  }
}
