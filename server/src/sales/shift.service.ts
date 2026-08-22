import type {
  CashMovementInput,
  CashMovementRow,
  LiveDrawerRow,
  ShiftListPage,
  ShiftListRow,
  ShiftRow,
} from '@huta/shared/schemas'

import type { Principal } from '../auth/principal.js'
import { assertCan } from '../auth/permissions.js'
import { resolveMoneyStores } from '../auth/store-scope.js'
import { prisma } from '../db/client.js'
import { dayRange, scopeTimezone } from '../lib/business-day.js'
import type { Prisma } from '../generated/prisma/client.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/index.js'

type Db = Prisma.TransactionClient

/**
 * Shifts — the cash drawer's accountability record.
 *
 * ONE open shift per STORE: the business runs one drawer per store, and `expectedCash`
 * sums the cash taken across the whole shift, so splitting shifts per terminal would
 * split one physical drawer's accountability across rows. `terminalId` is still recorded
 * from whoever opened it.
 *
 * The close computes `expected` and records `variance = counted − expected` — recorded,
 * never absorbed. It is a reportable number.
 */

const shiftSelect = {
  id: true,
  storeId: true,
  store: { select: { name: true } },
  terminalId: true,
  openedById: true,
  openedBy: { select: { firstName: true, lastName: true } },
  openedAt: true,
  openingCashCents: true,
  closedById: true,
  closedBy: { select: { firstName: true, lastName: true } },
  closedAt: true,
  closingCountedCashCents: true,
  expectedCashCents: true,
  varianceCents: true,
  status: true,
  notes: true,
  openingExpectedCents: true,
  openingVarianceCents: true,
  reviewedAt: true,
  reviewNote: true,
  reviewedBy: { select: { firstName: true, lastName: true } },
} as const

type ShiftRecord = Prisma.ShiftGetPayload<{ select: typeof shiftSelect }>

const fullName = (u: { firstName: string, lastName: string } | null): string | null =>
  u ? `${u.firstName} ${u.lastName}`.trim() : null

/**
 * Live cash figures for a shift: how many sales it holds and the CASH taken.
 *
 * Sums `Payment.amountCents` — the sale total actually kept — never `cashTenderedCents`,
 * whose overage went back out of the drawer as change.
 */
async function cashFigures(db: Db, shiftId: string) {
  // Sequential on purpose: `db` may be a transaction client, which holds ONE connection —
  // parallel queries on it are deprecated in pg and will break in pg@9.
  const saleCount = await db.sale.count({ where: { shiftId } })
  const payments = await db.payment.groupBy({
    by: ['method'],
    where: { sale: { shiftId }, status: 'SUCCEEDED' },
    _sum: { amountCents: true },
  })
  const paid = (method: string) =>
    payments.find((p) => p.method === method)?._sum.amountCents ?? 0
  // Cash refunds by the REFUND's shift, not the sale's — a Tuesday refund of a Monday
  // sale pays out of Tuesday's drawer. Card refunds never touch a drawer.
  const refunds = await db.refund.aggregate({
    where: { shiftId, method: 'CASH' },
    _sum: { amountCents: true },
  })
  return {
    saleCount,
    cashSalesCents: paid('CASH'),
    cardSalesCents: paid('CARD'),
    cashRefundsCents: refunds._sum.amountCents ?? 0,
  }
}

async function movementSums(db: Db, shiftId: string) {
  const grouped = await db.cashMovement.groupBy({
    by: ['type'],
    where: { shiftId },
    _sum: { amountCents: true },
  })
  const sum = (type: string) => grouped.find((g) => g.type === type)?._sum.amountCents ?? 0
  return {
    paidIn: sum('PAID_IN'),
    paidOut: sum('PAID_OUT'),
    drops: sum('DROP'),
    // The owner collecting the till. Leaves the drawer exactly as a safe drop does, and is
    // counted apart from one because it is the event that resets a carried-over balance.
    pickups: sum('PICKUP'),
  }
}

async function toShiftRow(db: Db, shift: ShiftRecord): Promise<ShiftRow> {
  const { saleCount, cashSalesCents, cardSalesCents, cashRefundsCents } = await cashFigures(
    db,
    shift.id,
  )
  return {
    id: shift.id,
    storeId: shift.storeId,
    storeName: shift.store.name,
    terminalId: shift.terminalId,
    openedById: shift.openedById,
    openedByName: fullName(shift.openedBy) ?? shift.openedById,
    openedAt: shift.openedAt.toISOString(),
    openingCashCents: shift.openingCashCents,
    closedById: shift.closedById,
    closedByName: fullName(shift.closedBy),
    closedAt: shift.closedAt?.toISOString() ?? null,
    closingCountedCashCents: shift.closingCountedCashCents,
    expectedCashCents: shift.expectedCashCents,
    varianceCents: shift.varianceCents,
    status: shift.status,
    notes: shift.notes,
    saleCount,
    cashSalesCents,
    cardSalesCents,
    cashRefundsCents,
    reviewedAt: shift.reviewedAt?.toISOString() ?? null,
    reviewedByName: fullName(shift.reviewedBy),
    reviewNote: shift.reviewNote,
    openingExpectedCents: shift.openingExpectedCents,
    openingVarianceCents: shift.openingVarianceCents,
  }
}

/** Staff act on their own store only; the capability check carries the store context. */
function assertShiftScope(principal: Principal, storeId: string): void {
  assertCan(principal, 'shift.manage', { storeId })
  if (principal.storeId !== null && principal.storeId !== storeId) {
    throw new ForbiddenError('That shift belongs to another store.')
  }
}

export async function openShift(
  principal: Principal,
  storeId: string,
  input: { openingCashCents: number },
): Promise<ShiftRow> {
  assertShiftScope(principal, storeId)
  if (principal.userId === null) throw new ForbiddenError('Opening a shift needs a person.')
  const userId = principal.userId

  const created = await prisma.$transaction(async (tx) => {
    // Lock the store row so two concurrent opens serialise — the second one then SEES
    // the first's shift and refuses, instead of both slipping past the check.
    const store = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Store" WHERE "id" = ${storeId} FOR UPDATE
    `
    if (store.length === 0) throw new NotFoundError('That store does not exist.')

    const open = await tx.shift.findFirst({
      where: { storeId, status: 'OPEN' },
      select: { id: true },
    })
    if (open) throw new ConflictError('A shift is already open at this store.')

    /**
     * What the drawer SHOULD hold: cash carries over, so the previous close is this open's
     * expected figure. Resolved inside the store-row lock above, so two concurrent opens
     * cannot both chain off the same close.
     *
     * Null for the very first drawer a store opens — genuinely unknown, and a different fact
     * from zero. Nothing is inferred in that case, and the CHECK keeps both columns null.
     */
    const previous = await tx.shift.findFirst({
      where: { storeId, status: 'CLOSED', closingCountedCashCents: { not: null } },
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
      select: { closingCountedCashCents: true },
    })
    const carried = previous?.closingCountedCashCents ?? null

    return tx.shift.create({
      data: {
        storeId,
        terminalId: principal.terminalId,
        openedById: userId,
        openingCashCents: input.openingCashCents,
        openingExpectedCents: carried,
        openingVarianceCents: carried === null ? null : input.openingCashCents - carried,
      },
      select: shiftSelect,
    })
  })

  return toShiftRow(prisma, created)
}

export async function closeShift(
  principal: Principal,
  shiftId: string,
  input: { countedCashCents: number, notes?: string | undefined },
): Promise<ShiftRow> {
  if (principal.userId === null) throw new ForbiddenError('Closing a shift needs a person.')
  const userId = principal.userId

  const closed = await prisma.$transaction(async (tx) => {
    // Lock the shift row: a checkout holds this same lock while it writes, so the close
    // computes `expected` over a settled set of sales — no payment can land mid-close.
    const locked = await tx.$queryRaw<
      Array<{ id: string, storeId: string, status: string, openingCashCents: number }>
    >`
      SELECT "id", "storeId", "status", "openingCashCents"
        FROM "Shift" WHERE "id" = ${shiftId} FOR UPDATE
    `
    const shift = locked[0]
    if (!shift) throw new NotFoundError('That shift does not exist.')
    assertShiftScope(principal, shift.storeId)
    if (shift.status !== 'OPEN') throw new ConflictError('That shift is already closed.')

    const { cashSalesCents, cashRefundsCents } = await cashFigures(tx, shiftId)
    const { paidIn, paidOut, drops, pickups } = await movementSums(tx, shiftId)
    // Finally honouring the schema's doc comment: "... - cash refunds". Card money never
    // enters this figure in either direction — it does not live in the drawer.
    const expected =
      shift.openingCashCents + cashSalesCents + paidIn - paidOut - drops - pickups
      - cashRefundsCents

    // Every closure field in ONE update — the DB CHECK is all-or-nothing.
    return tx.shift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        closedById: userId,
        closedAt: new Date(),
        closingCountedCashCents: input.countedCashCents,
        expectedCashCents: expected,
        varianceCents: input.countedCashCents - expected,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      select: shiftSelect,
    })
  })

  return toShiftRow(prisma, closed)
}

export async function currentShift(principal: Principal, storeId: string): Promise<ShiftRow | null> {
  assertShiftScope(principal, storeId)
  const shift = await prisma.shift.findFirst({
    where: { storeId, status: 'OPEN' },
    select: shiftSelect,
  })
  return shift ? toShiftRow(prisma, shift) : null
}

export interface ShiftFilter {
  readonly storeId?: string | undefined
  /** Business days, `YYYY-MM-DD`, resolved against the store's own timezone. */
  readonly from?: string | undefined
  readonly to?: string | undefined
  /** Drawers this person opened OR closed — the two custody facts a Shift records. */
  readonly userId?: string | undefined
}

/**
 * The drawer list, behind `/admin/drawers`. Did not exist before 2026-08-22 — a variance was
 * only ever visible at the register that closed it, in the moment it was closed.
 *
 * THREE QUERIES for the whole page, not two hundred. `toShiftRow` is deliberately not used
 * here: it runs three sequential queries PER ROW, and it does not need to, because a CLOSED
 * shift already carries its money in columns that `closeShift` wrote once. Sale counts and
 * pickups each come back for every row in a single `groupBy`, so the cost is flat in the
 * page size.
 *
 * Scoped with the SHARED money resolver: cross-store stays on `report.view`, own store on
 * `shift.manage`, which is the capability that already governs opening and closing one.
 */
export async function listShifts(
  principal: Principal,
  filter: ShiftFilter,
): Promise<ShiftListPage> {
  const stores = await resolveMoneyStores(principal, filter.storeId, 'shift.manage')
  const storeIds = stores.map((s) => s.id)
  const timeZone = scopeTimezone(stores)
  const range = dayRange(filter.from, filter.to, timeZone)

  const shifts = await prisma.shift.findMany({
    where: {
      storeId: { in: storeIds },
      ...(filter.userId
        ? { OR: [{ openedById: filter.userId }, { closedById: filter.userId }] }
        : {}),
      // Cut in the STORE's timezone, never the server's — `Store.timezone`'s schema comment
      // requires it, and the arithmetic this replaced (`new Date(`${from}T00:00:00`)`) read
      // the server's zone, so a drawer opened at 23:50 Eastern was filed on the wrong day
      // whenever the two disagreed. Half-open, for the reason `dayRange` documents.
      ...(range ? { openedAt: range } : {}),
    },
    select: {
      id: true,
      storeId: true,
      status: true,
      openedAt: true,
      closedAt: true,
      openingCashCents: true,
      closingCountedCashCents: true,
      expectedCashCents: true,
      varianceCents: true,
      openedById: true,
      closedById: true,
      openingExpectedCents: true,
      openingVarianceCents: true,
      reviewedAt: true,
      reviewNote: true,
      store: { select: { name: true } },
      openedBy: { select: { firstName: true, lastName: true } },
      closedBy: { select: { firstName: true, lastName: true } },
      reviewedBy: { select: { firstName: true, lastName: true } },
    },
    // The `id` tiebreak matters: shifts opened in the same second would otherwise sort
    // unstably under paging and show a row twice. Same fix the sales ledger carries.
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  })

  const shiftIds = shifts.map((s) => s.id)
  const counts = await prisma.sale.groupBy({
    by: ['shiftId'],
    where: { shiftId: { in: shiftIds } },
    _count: { _all: true },
  })
  const countFor = new Map(counts.map((c) => [c.shiftId, c._count._all]))

  // A THIRD grouped query, still constant rather than per row. Worth the round trip: a
  // carried-over balance that drops by $800 is either a collection or a theft, and only this
  // tells them apart.
  const pickups = await prisma.cashMovement.groupBy({
    by: ['shiftId'],
    where: { shiftId: { in: shiftIds }, type: 'PICKUP' },
    _sum: { amountCents: true },
  })
  const pickupFor = new Map(pickups.map((p) => [p.shiftId, p._sum.amountCents ?? 0]))

  const rows: ShiftListRow[] = shifts.map((s) => ({
    id: s.id,
    storeId: s.storeId,
    storeName: s.store.name,
    status: s.status,
    openedAt: s.openedAt.toISOString(),
    openedById: s.openedById,
    openedByName: `${s.openedBy.firstName} ${s.openedBy.lastName}`,
    closedAt: s.closedAt?.toISOString() ?? null,
    closedById: s.closedById,
    closedByName: s.closedBy ? `${s.closedBy.firstName} ${s.closedBy.lastName}` : null,
    openingCashCents: s.openingCashCents,
    closingCountedCashCents: s.closingCountedCashCents,
    expectedCashCents: s.expectedCashCents,
    varianceCents: s.varianceCents,
    saleCount: countFor.get(s.id) ?? 0,
    reviewedAt: s.reviewedAt?.toISOString() ?? null,
    reviewedByName: fullName(s.reviewedBy),
    reviewNote: s.reviewNote,
    openingExpectedCents: s.openingExpectedCents,
    openingVarianceCents: s.openingVarianceCents,
    pickupsCents: pickupFor.get(s.id) ?? 0,
  }))

  return { shifts: rows, timezone: timeZone }
}

export async function getShift(principal: Principal, shiftId: string): Promise<ShiftRow> {
  const shift = await prisma.shift.findUnique({ where: { id: shiftId }, select: shiftSelect })
  if (!shift) throw new NotFoundError('That shift does not exist.')
  assertShiftScope(principal, shift.storeId)
  return toShiftRow(prisma, shift)
}

export async function addCashMovement(
  principal: Principal,
  shiftId: string,
  input: CashMovementInput,
): Promise<CashMovementRow> {
  if (principal.userId === null) throw new ForbiddenError('A cash movement needs a person.')
  const userId = principal.userId

  /**
   * ⚠️ A PICKUP is admin-only, unlike the other three.
   *
   * It is the one movement that takes money out of the business rather than around it, and a
   * cashier who could key "$500 pickup" could paper over a $500 shortfall — the precise fraud
   * this ledger exists to catch. Paid-in, paid-out and safe drops stay staff-writable.
   */
  if (input.type === 'PICKUP' && principal.role !== 'ADMIN') {
    throw new ForbiddenError('Only an admin may record a cash pickup.')
  }

  const created = await prisma.$transaction(async (tx) => {
    // Same shift lock as close: a movement must not slip in while a close is computing.
    const locked = await tx.$queryRaw<Array<{ id: string, storeId: string, status: string }>>`
      SELECT "id", "storeId", "status" FROM "Shift" WHERE "id" = ${shiftId} FOR UPDATE
    `
    const shift = locked[0]
    if (!shift) throw new NotFoundError('That shift does not exist.')
    assertShiftScope(principal, shift.storeId)
    if (shift.status !== 'OPEN') throw new ConflictError('That shift is closed.')

    return tx.cashMovement.create({
      data: { shiftId, type: input.type, amountCents: input.amountCents, reason: input.reason, userId },
      select: {
        id: true,
        type: true,
        amountCents: true,
        reason: true,
        user: { select: { firstName: true, lastName: true } },
        createdAt: true,
      },
    })
  })

  return {
    id: created.id,
    type: created.type,
    amountCents: created.amountCents,
    reason: created.reason,
    userName: fullName(created.user) ?? userId,
    createdAt: created.createdAt.toISOString(),
  }
}

export async function listCashMovements(
  principal: Principal,
  shiftId: string,
): Promise<CashMovementRow[]> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: { storeId: true },
  })
  if (!shift) throw new NotFoundError('That shift does not exist.')
  assertShiftScope(principal, shift.storeId)

  const rows = await prisma.cashMovement.findMany({
    where: { shiftId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      amountCents: true,
      reason: true,
      user: { select: { firstName: true, lastName: true } },
      createdAt: true,
    },
  })
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    amountCents: row.amountCents,
    reason: row.reason,
    userName: fullName(row.user) ?? '—',
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * Record WHY a drawer was off.
 *
 * Deliberately separate from `Shift.notes`, which is what the cashier typed while counting.
 * A manager's later conclusion must not overwrite the more direct account of the two, so
 * this is its own column set with its own attribution.
 *
 * ADMIN ONLY, the same shape `reviewReceipt` uses — staff hold `shift.manage` because they
 * open and close drawers, which is not the same authority as pronouncing on a shortfall.
 *
 * Diverges from the receipts queue on one point, on purpose: re-posting AMENDS rather than
 * throwing `ConflictError`. An annotation is not an acknowledgement — "investigating"
 * becomes "found it, miscount" — and locking the first sentence would be wrong. Nothing is
 * lost: every version survives in `AuditLog`'s before/after.
 */
export async function reviewShift(
  principal: Principal,
  shiftId: string,
  note: string,
): Promise<ShiftRow> {
  if (principal.role !== 'ADMIN' || principal.userId === null) {
    throw new ForbiddenError('Only an admin may review a drawer.')
  }

  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: { id: true, status: true, reviewedAt: true, reviewNote: true, reviewedById: true },
  })
  if (!shift) throw new NotFoundError('That shift does not exist.')
  // An OPEN drawer has no counted figure and therefore no variance to explain. The CHECK
  // would refuse the row anyway; this is the useful sentence ahead of it.
  if (shift.status !== 'CLOSED') {
    throw new ConflictError('That drawer is still open — there is no variance to explain yet.')
  }

  const userId = principal.userId
  await prisma.$transaction(async (tx) => {
    await tx.shift.update({
      where: { id: shiftId },
      // All three together — the pairing CHECK refuses half a review record.
      data: { reviewedById: userId, reviewedAt: new Date(), reviewNote: note },
    })
    await tx.auditLog.create({
      data: {
        userId,
        action: 'shift.review',
        entityType: 'Shift',
        entityId: shiftId,
        // The previous note is the point of `before`: an amend must leave the earlier
        // account recoverable, which is what lets this endpoint overwrite at all.
        before: { reviewNote: shift.reviewNote, reviewedById: shift.reviewedById },
        after: { reviewNote: note, reviewedById: userId },
      },
    })
  })

  return getShift(principal, shiftId)
}

/**
 * What is in every till RIGHT NOW.
 *
 * Cash carries over between shifts and days and only leaves when the owner collects it, so
 * "how much is sitting in Ashley's drawer" has a real answer — and one nobody could ask
 * before, because the balance only ever surfaced at a close.
 *
 * FIVE QUERIES, whatever the store count. The obvious implementation calls `cashFigures` and
 * `movementSums` per store, which is five round trips EACH; these group across every open
 * drawer at once. Same discipline as `listShifts` — a dashboard tile must not cost a query
 * per location.
 *
 * Cash takings need the one raw statement: Prisma's `groupBy` cannot group on a RELATION
 * field, and the drawer a payment belongs to lives on its Sale. Fetching the payments and
 * summing them in JS would work but scales with the day's transactions rather than with the
 * number of stores, which is the property this function exists to have.
 *
 * A store with NO open drawer is still reported, with nulls. Dropping it would make "the till
 * is empty" and "nobody has opened up" look identical, and the second is the one that needs
 * somebody to do something.
 */
export async function liveDrawers(
  principal: Principal,
  storeId?: string,
): Promise<LiveDrawerRow[]> {
  const stores = await resolveMoneyStores(principal, storeId, 'shift.manage')
  const storeIds = stores.map((s) => s.id)

  const open = await prisma.shift.findMany({
    where: { storeId: { in: storeIds }, status: 'OPEN' },
    select: {
      id: true,
      storeId: true,
      openedAt: true,
      openingCashCents: true,
      openedBy: { select: { firstName: true, lastName: true } },
    },
  })
  const shiftIds = open.map((s) => s.id)

  if (shiftIds.length === 0) {
    return stores.map((store) => emptyDrawer(store.id, store.name))
  }

  // Sequential, not Promise.all — `cashFigures` explains why: the pg driver does not
  // multiplex a single connection, and these all run on the shared client.
  const cashRows = await prisma.$queryRaw<Array<{ shiftId: string, cash: bigint | number }>>`
    SELECT s."shiftId" AS "shiftId", COALESCE(SUM(p."amountCents"), 0) AS cash
      FROM "Payment" p
      JOIN "Sale" s ON s."id" = p."saleId"
     WHERE s."shiftId" = ANY(${shiftIds})
       AND p."method" = 'CASH'
       AND p."status" = 'SUCCEEDED'
     GROUP BY s."shiftId"
  `
  const saleCounts = await prisma.sale.groupBy({
    by: ['shiftId'],
    where: { shiftId: { in: shiftIds } },
    _count: { _all: true },
  })
  const refunds = await prisma.refund.groupBy({
    by: ['shiftId'],
    where: { shiftId: { in: shiftIds }, method: 'CASH', status: 'SUCCEEDED' },
    _sum: { amountCents: true },
  })
  const movements = await prisma.cashMovement.groupBy({
    by: ['shiftId', 'type'],
    where: { shiftId: { in: shiftIds } },
    _sum: { amountCents: true },
  })

  // SUM() comes back as a bigint from pg; Number() is safe here because every amount is
  // integer cents well inside 2^53.
  const cashFor = new Map(cashRows.map((r) => [r.shiftId, Number(r.cash)]))
  const countFor = new Map(saleCounts.map((c) => [c.shiftId, c._count._all]))
  const refundFor = new Map(refunds.map((r) => [r.shiftId, r._sum.amountCents ?? 0]))

  return stores.map((store) => {
    const shift = open.find((s) => s.storeId === store.id)
    if (!shift) return emptyDrawer(store.id, store.name)

    const moved = (type: string) =>
      movements.find((m) => m.shiftId === shift.id && m.type === type)?._sum.amountCents ?? 0
    const cashSales = cashFor.get(shift.id) ?? 0

    return {
      storeId: store.id,
      storeName: store.name,
      shiftId: shift.id,
      openedAt: shift.openedAt.toISOString(),
      openedByName: fullName(shift.openedBy),
      openingCashCents: shift.openingCashCents,
      cashSalesCents: cashSales,
      /**
       * Exactly the arithmetic `closeShift` runs, minus the counting — so the figure on the
       * dashboard is the one the drawer will be measured against, not a second opinion.
       */
      balanceCents:
        shift.openingCashCents + cashSales + moved('PAID_IN') - moved('PAID_OUT')
        - moved('DROP') - moved('PICKUP') - (refundFor.get(shift.id) ?? 0),
      saleCount: countFor.get(shift.id) ?? 0,
    }
  })
}

function emptyDrawer(storeId: string, storeName: string): LiveDrawerRow {
  return {
    storeId,
    storeName,
    shiftId: null,
    openedAt: null,
    openedByName: null,
    openingCashCents: null,
    cashSalesCents: null,
    balanceCents: null,
    saleCount: null,
  }
}
