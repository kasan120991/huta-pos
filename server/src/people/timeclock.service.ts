import { roundHalfUp } from '@huta/shared'
import type { Principal } from '../auth/principal.js'
import { assertCan } from '../auth/permissions.js'
import { prisma } from '../db/client.js'
import { dayRange, scopeTimezone } from '../lib/business-day.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/index.js'

/**
 * The timeclock — a person's working hours.
 *
 * ⚠️ DELIBERATELY NOT A SHIFT. A `Shift` is one cash drawer per STORE: in this database one
 * has run 47 hours, several carry two different cashiers, and one was opened by one person
 * and closed by another. It records money custody, not attendance, and hours cannot be
 * derived from it. That is why this table exists.
 *
 * Three rules Kasan set on 2026-08-22:
 *   · STAFF ONLY. An admin is not on a clock.
 *   · WARN, NEVER BLOCK. Ringing a sale does not require an open entry; the register
 *     nudges. A timeclock bug must never be the reason a customer cannot be served.
 *   · AUTO-CLOSE AT A CUTOFF, marked as an estimate.
 */

/**
 * How long an entry may stay open before it is treated as abandoned.
 *
 * Twelve hours, matching `DEVICE_SESSION_TTL_SECONDS` — the staff cookie dies at the same
 * point, so a person who is still genuinely working has had to sign in again anyway. The
 * longest real shift here is around twelve, so this errs toward UNDER-counting rather than
 * inventing hours nobody worked; an admin corrects it either way, and `status: AUTO` is what
 * makes the difference visible.
 */
export const AUTO_CLOSE_HOURS = 12

/**
 * Lazily close anything abandoned, and return how many were closed.
 *
 * ⚠️ THERE IS NO SCHEDULER IN THIS CODEBASE, and this does not add one. Both existing
 * expiries — pairing codes and step-up grants — resolve at READ time by comparing against
 * `new Date()`, and this follows them: an entry older than the cutoff is materialised as
 * closed the next time anything looks at that person's clock. A cron would be a new
 * operational dependency for one feature, and one that fails silently at 3am.
 *
 * Scoped to one user when a user is given, so a clock-in does not sweep the whole table.
 */
export async function resolveAbandoned(userId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_HOURS * 3600 * 1000)
  const stale = await prisma.timeEntry.findMany({
    where: { status: 'OPEN', clockedInAt: { lt: cutoff }, ...(userId ? { userId } : {}) },
    select: { id: true, clockedInAt: true },
  })
  for (const entry of stale) {
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        // The cutoff, not "now" — closing at read time would grow the estimate every time
        // someone loaded the page, so the same abandoned shift would be worth more hours on
        // Friday than it was on Tuesday.
        clockedOutAt: new Date(entry.clockedInAt.getTime() + AUTO_CLOSE_HOURS * 3600 * 1000),
        status: 'AUTO',
      },
    })
  }
  return stale.length
}

const entrySelect = {
  id: true,
  userId: true,
  storeId: true,
  clockedInAt: true,
  clockedOutAt: true,
  status: true,
  note: true,
  user: { select: { firstName: true, lastName: true } },
  store: { select: { name: true } },
  closedBy: { select: { firstName: true, lastName: true } },
} as const

type Selected = Awaited<ReturnType<typeof prisma.timeEntry.findFirstOrThrow<{ select: typeof entrySelect }>>>

/**
 * Whole minutes, rounded to the NEAREST. Null while an entry is still open — there is
 * nothing to measure.
 *
 * ⚠️ This floored until 2026-08-24, and the change is Kasan's call now that payroll pays from
 * it. Flooring discarded up to 59 seconds per entry, which over a fortnight of fourteen
 * entries is up to thirteen minutes — small, but lost SYSTEMATICALLY and always in the
 * employer's direction, which is the shape of a wage claim rather than a rounding footnote.
 * Rounding to nearest is directionally neutral: it gives back as often as it takes.
 *
 * `roundHalfUp`, not `Math.round`, for the reason its own docblock gives — `Math.round` is
 * asymmetric about zero. The interval CHECK guarantees a positive duration so the two agree
 * here, but the asymmetric one has no business anywhere near money.
 *
 * The Hours tab renders this same figure, so the timesheet and the payslip cannot disagree.
 * The register's LIVE elapsed counter deliberately still floors — a clock that is still
 * running must not claim a minute nobody has worked yet.
 */
export function minutesOf(entry: { clockedInAt: Date, clockedOutAt: Date | null }): number | null {
  if (!entry.clockedOutAt) return null
  return roundHalfUp((entry.clockedOutAt.getTime() - entry.clockedInAt.getTime()) / 60_000)
}

function toRow(e: Selected) {
  return {
    id: e.id,
    userId: e.userId,
    userName: `${e.user.firstName} ${e.user.lastName}`,
    storeId: e.storeId,
    storeName: e.store.name,
    clockedInAt: e.clockedInAt.toISOString(),
    clockedOutAt: e.clockedOutAt?.toISOString() ?? null,
    status: e.status,
    minutes: minutesOf(e),
    note: e.note,
    closedByName: e.closedBy ? `${e.closedBy.firstName} ${e.closedBy.lastName}` : null,
  }
}

/* ————— what a person does at a register ————— */

/**
 * Only STAFF punch a clock, and only for themselves.
 *
 * There is no capability for this and none is needed: `principal.userId` IS the subject, so
 * there is no other person's record to reach. Adding a `timeclock.punch` capability would
 * put a row in the permission matrix that both roles hold, which says nothing.
 */
function requireStaff(principal: Principal): { userId: string, storeId: string, terminalId: string } {
  if (principal.kind !== 'staff') {
    throw new ForbiddenError(
      principal.kind === 'admin'
        ? 'Admins are not on the clock.'
        : 'Sign in before clocking on.',
    )
  }
  return {
    userId: principal.userId,
    storeId: principal.storeId,
    terminalId: principal.terminalId,
  }
}

export async function clockIn(principal: Principal) {
  const me = requireStaff(principal)
  await resolveAbandoned(me.userId)

  try {
    const created = await prisma.timeEntry.create({
      data: {
        userId: me.userId,
        // From the TERMINAL, never a request body — the same rule every store-scoped write
        // follows, and it is what gives an entry a correct store without trusting a client.
        storeId: me.storeId,
        clockedInTerminalId: me.terminalId,
        status: 'OPEN',
      },
      select: entrySelect,
    })
    return toRow(created)
  }
  catch (error) {
    // The partial unique index caught a second open entry — either a double tap or a second
    // till. Report WHEN they clocked in, so the answer is useful rather than a refusal.
    if ((error as { code?: string }).code === 'P2002') {
      const open = await prisma.timeEntry.findFirst({
        where: { userId: me.userId, status: 'OPEN' },
        select: { clockedInAt: true },
      })
      const at = open?.clockedInAt.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })
      throw new ConflictError(at ? `You clocked in at ${at}.` : 'You are already clocked in.')
    }
    throw error
  }
}

export async function clockOut(principal: Principal) {
  const me = requireStaff(principal)
  await resolveAbandoned(me.userId)

  const open = await prisma.timeEntry.findFirst({
    where: { userId: me.userId, status: 'OPEN' },
    select: { id: true },
  })
  if (!open) throw new ConflictError('You are not clocked in.')

  const closed = await prisma.timeEntry.update({
    where: { id: open.id },
    data: {
      clockedOutAt: new Date(),
      clockedOutTerminalId: me.terminalId,
      status: 'CLOCKED',
      closedById: me.userId,
    },
    select: entrySelect,
  })
  return toRow(closed)
}

/** The open entry, or null. What the register's clock button reads to decide its label. */
export async function currentEntry(principal: Principal) {
  if (principal.kind !== 'staff') return null
  await resolveAbandoned(principal.userId)
  const open = await prisma.timeEntry.findFirst({
    where: { userId: principal.userId, status: 'OPEN' },
    select: entrySelect,
  })
  return open ? toRow(open) : null
}

/* ————— what an admin does on the Staff page ————— */

export interface EntryFilter {
  readonly userId?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/**
 * Gated on `user.manage` rather than a new `timeclock.manage`.
 *
 * There are two roles and an admin holds everything, so a separate capability would add a
 * row to the permission matrix with no behavioural difference today. If a "manager
 * who can fix timesheets but not create people" ever exists, splitting it is one constant
 * and one call site.
 */
export async function listEntries(principal: Principal, filter: EntryFilter) {
  assertCan(principal, 'user.manage')
  await resolveAbandoned(filter.userId)

  /**
   * ⚠️ Days are cut in the STORE's timezone, and getting this wrong hid people's hours.
   *
   * This used `new Date(filter.from)` on a bare `YYYY-MM-DD`, which JavaScript parses as UTC
   * MIDNIGHT — so the business day ended at 20:00 Eastern and everything clocked after that
   * fell into "tomorrow" and vanished from the range. Two consequences, both reported as
   * separate bugs: a person clocked in at 21:38 showed as NOT on the clock (`openCount` is
   * counted over these same rows), and their finished entries disappeared from the Hours tab
   * as though the hours had never been recorded. They always were; only the read was wrong.
   *
   * Worse than the `listShifts` version of this bug, which at least used the SERVER's zone —
   * a bare date string is UTC by spec, so this was wrong even with the server set to Eastern.
   * Third caller of the same rule; `lib/business-day.ts` exists so there is no fourth.
   */
  const stores = await prisma.store.findMany({
    where: { active: true },
    select: { id: true, name: true, timezone: true },
  })
  const range = dayRange(filter.from, filter.to, scopeTimezone(stores))

  const entries = await prisma.timeEntry.findMany({
    where: {
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(range ? { clockedInAt: range } : {}),
      status: { not: 'VOIDED' },
    },
    select: entrySelect,
    orderBy: [{ clockedInAt: 'desc' }, { id: 'desc' }],
    take: 500,
  })

  const rows = entries.map(toRow)

  /**
   * Estimated minutes are reported SEPARATELY, never folded in silently.
   *
   * An AUTO entry's end time is a guess the system made. Rolling it into one total would
   * mean paying someone from a number nobody keyed, with nothing on screen saying so. The
   * caller can add them together and say "38h 20m, of which 6h estimated" — which is the
   * honest version of the same figure.
   */
  /*
   * Which of these sit inside a fortnight that has already been paid.
   *
   * ONE query for the whole page, not one per row: the committed runs covering these people
   * are a handful, and matching an entry to one is then plain arithmetic. A per-entry lookup
   * would be up to 500 round trips for a page that renders in a table.
   */
  const userIds = [...new Set(rows.map((r) => r.userId))]
  const paidRuns = userIds.length
    ? await prisma.payRun.findMany({
        where: { status: 'COMMITTED', lines: { some: { userId: { in: userIds } } } },
        select: {
          id: true,
          periodStartDate: true,
          periodStart: true,
          periodEnd: true,
          lines: { select: { userId: true } },
        },
      })
    : []

  const marked = rows.map((row) => {
    const at = new Date(row.clockedInAt).getTime()
    const run = paidRuns.find(
      (r) =>
        r.periodStart.getTime() <= at &&
        r.periodEnd.getTime() > at &&
        r.lines.some((l) => l.userId === row.userId),
    )
    return {
      ...row,
      paidRunId: run?.id ?? null,
      paidPeriodStartDate: run?.periodStartDate ?? null,
    }
  })

  const counted = rows.filter((r) => r.minutes !== null)
  return {
    entries: marked,
    totalMinutes: counted
      .filter((r) => r.status !== 'AUTO')
      .reduce((sum, r) => sum + (r.minutes ?? 0), 0),
    estimatedMinutes: counted
      .filter((r) => r.status === 'AUTO')
      .reduce((sum, r) => sum + (r.minutes ?? 0), 0),
    openCount: rows.filter((r) => r.status === 'OPEN').length,
  }
}

export interface EntryCorrection {
  /** Optional — supplied only when the START is being moved too. */
  readonly clockedInAt?: string | undefined
  /** Optional, so an entry that is still OPEN can have its start fixed without closing it. */
  readonly clockedOutAt?: string | undefined
  readonly note: string
}

/** A single entry longer than this is a mis-keyed date, not a shift. */
const MAX_ENTRY_HOURS = 24

/**
 * Refuse to move time into or out of a fortnight that has already been paid.
 *
 * Added 2026-08-24 with editable start times, and it applies to the end time too — that was a
 * gap the moment payroll started paying from this table. An entry is dated by `clockedInAt`,
 * so moving a start can move hours between pay periods; both the position it is leaving and
 * the one it is arriving at have to be clear, or a committed run stops matching the timesheet
 * it was computed from.
 *
 * Queried directly rather than through `payroll.service.ts`, which imports this module —
 * reaching back the other way would be a cycle for one `findFirst`.
 */
async function assertNotPaid(userId: string, at: Date, what: string): Promise<void> {
  const run = await prisma.payRun.findFirst({
    where: {
      status: 'COMMITTED',
      periodStart: { lte: at },
      periodEnd: { gt: at },
      lines: { some: { userId } },
    },
    select: { periodStartDate: true },
  })
  if (run) {
    throw new ConflictError(
      `${what} falls in a pay run that has already been committed (${run.periodStartDate}). Reverse the run before changing the timesheet.`,
    )
  }
}

/** Supply the real times for an entry the system guessed at, or that is still open. */
export async function correctEntry(
  principal: Principal,
  id: string,
  input: EntryCorrection,
  actorId: string,
) {
  assertCan(principal, 'user.manage')

  const existing = await prisma.timeEntry.findUnique({
    where: { id },
    select: { id: true, userId: true, clockedInAt: true, clockedOutAt: true, status: true },
  })
  if (!existing) throw new NotFoundError('That time entry does not exist.')
  if (existing.status === 'VOIDED') throw new ValidationError('That entry was discarded.')
  if (input.clockedInAt === undefined && input.clockedOutAt === undefined) {
    throw new ValidationError('Nothing to change.')
  }

  const now = new Date()

  const start = input.clockedInAt === undefined ? existing.clockedInAt : new Date(input.clockedInAt)
  if (Number.isNaN(start.getTime())) throw new ValidationError('That is not a valid start time.')
  if (start > now) throw new ValidationError('The start time cannot be in the future.')

  // An OPEN entry keeps its missing end: `TimeEntry_status_pairing_check` requires OPEN to
  // carry no end time, so fixing somebody's start does not close their shift for them.
  const end =
    input.clockedOutAt === undefined
      ? existing.clockedOutAt
      : new Date(input.clockedOutAt)
  if (end !== null && Number.isNaN(end.getTime())) {
    throw new ValidationError('That is not a valid end time.')
  }

  if (end !== null) {
    // Refuse before the CHECK does, with a sentence that says what is wrong.
    if (end <= start) throw new ValidationError('The end time has to be after the start time.')
    if (end > now) throw new ValidationError('The end time cannot be in the future.')
    if (end.getTime() - start.getTime() > MAX_ENTRY_HOURS * 3600 * 1000) {
      // Almost always a mis-keyed DATE rather than a real shift, and now that payroll pays
      // from this table a 40-hour entry would land 30 of those hours at time and a half.
      throw new ValidationError(
        `That is more than ${MAX_ENTRY_HOURS} hours in one entry — check the dates. Split it into two entries if somebody really worked across days.`,
      )
    }
  }

  // Both ends of the move, because an entry is dated by where it STARTS.
  await assertNotPaid(existing.userId, existing.clockedInAt, 'That entry')
  if (start.getTime() !== existing.clockedInAt.getTime()) {
    await assertNotPaid(existing.userId, start, 'The new start time')
  }

  const closing = end !== null
  const updated = await prisma.timeEntry.update({
    where: { id },
    data: {
      clockedInAt: start,
      clockedOutAt: end,
      // Only a finished entry becomes CORRECTED; one still running stays OPEN, and nobody
      // has closed it, so `closedById` stays as it was.
      ...(closing ? { status: 'CORRECTED' as const, closedById: actorId } : {}),
      note: input.note,
    },
    select: entrySelect,
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'timeclock.correct',
      entityType: 'TimeEntry',
      entityId: id,
      // Both timestamps, since either may have moved — the log is the only record of what
      // the clock originally said.
      before: {
        clockedInAt: existing.clockedInAt.toISOString(),
        clockedOutAt: existing.clockedOutAt?.toISOString() ?? null,
        status: existing.status,
      },
      after: {
        clockedInAt: start.toISOString(),
        clockedOutAt: end?.toISOString() ?? null,
        status: closing ? 'CORRECTED' : existing.status,
        note: input.note,
      },
    },
  })
  return toRow(updated)
}

/** Discard an entry. Excluded from every figure, never deleted — nothing here is. */
export async function voidEntry(principal: Principal, id: string, note: string, actorId: string) {
  assertCan(principal, 'user.manage')

  const existing = await prisma.timeEntry.findUnique({
    where: { id },
    select: { id: true, status: true, clockedOutAt: true },
  })
  if (!existing) throw new NotFoundError('That time entry does not exist.')

  const updated = await prisma.timeEntry.update({
    where: { id },
    data: { status: 'VOIDED', note, closedById: actorId },
    select: entrySelect,
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'timeclock.void',
      entityType: 'TimeEntry',
      entityId: id,
      before: { status: existing.status },
      after: { status: 'VOIDED', note },
    },
  })
  return toRow(updated)
}
