import type {
  CashMovementInput,
  CashMovementRow,
  ShiftListRow,
  ShiftRow,
} from '@huta/shared/schemas'

import type { Principal } from '../auth/principal.js'
import { assertCan } from '../auth/permissions.js'
import { resolveMoneyStores } from '../auth/store-scope.js'
import { prisma } from '../db/client.js'
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
  return { paidIn: sum('PAID_IN'), paidOut: sum('PAID_OUT'), drops: sum('DROP') }
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

    return tx.shift.create({
      data: {
        storeId,
        terminalId: principal.terminalId,
        openedById: userId,
        openingCashCents: input.openingCashCents,
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
    const { paidIn, paidOut, drops } = await movementSums(tx, shiftId)
    // Finally honouring the schema's doc comment: "... - cash refunds". Card money never
    // enters this figure in either direction — it does not live in the drawer.
    const expected =
      shift.openingCashCents + cashSalesCents + paidIn - paidOut - drops - cashRefundsCents

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
 * The drawer list. Did not exist before 2026-08-22 — a variance was only ever visible at the
 * register that closed it.
 *
 * TWO QUERIES for the whole page, not two hundred. `toShiftRow` is deliberately not used
 * here: it runs three sequential queries per row, and it does not need to, because a CLOSED
 * shift already carries its money in columns that `closeShift` wrote once. Sale counts come
 * back for every row in a single `groupBy`.
 *
 * Scoped with the SHARED money resolver: cross-store stays on `report.view`, own store on
 * `shift.manage`, which is the capability that already governs opening and closing one.
 */
export async function listShifts(
  principal: Principal,
  filter: ShiftFilter,
): Promise<ShiftListRow[]> {
  const stores = await resolveMoneyStores(principal, filter.storeId, 'shift.manage')
  const storeIds = stores.map((s) => s.id)

  const shifts = await prisma.shift.findMany({
    where: {
      storeId: { in: storeIds },
      ...(filter.userId
        ? { OR: [{ openedById: filter.userId }, { closedById: filter.userId }] }
        : {}),
      ...(filter.from || filter.to
        ? {
            openedAt: {
              ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00`) } : {}),
              // Half-open. A `lte` against midnight drops everything opened after 00:00 on
              // the end date — the trap the sales history already documents.
              ...(filter.to
                ? { lt: new Date(new Date(`${filter.to}T00:00:00`).getTime() + 86_400_000) }
                : {}),
            },
          }
        : {}),
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
      store: { select: { name: true } },
      openedBy: { select: { firstName: true, lastName: true } },
      closedBy: { select: { firstName: true, lastName: true } },
    },
    // The `id` tiebreak matters: shifts opened in the same second would otherwise sort
    // unstably under paging and show a row twice. Same fix the sales ledger carries.
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  })

  const counts = await prisma.sale.groupBy({
    by: ['shiftId'],
    where: { shiftId: { in: shifts.map((s) => s.id) } },
    _count: { _all: true },
  })
  const countFor = new Map(counts.map((c) => [c.shiftId, c._count._all]))

  return shifts.map((s) => ({
    id: s.id,
    storeId: s.storeId,
    storeName: s.store.name,
    status: s.status,
    openedAt: s.openedAt.toISOString(),
    openedByName: `${s.openedBy.firstName} ${s.openedBy.lastName}`,
    closedAt: s.closedAt?.toISOString() ?? null,
    closedByName: s.closedBy ? `${s.closedBy.firstName} ${s.closedBy.lastName}` : null,
    openingCashCents: s.openingCashCents,
    closingCountedCashCents: s.closingCountedCashCents,
    expectedCashCents: s.expectedCashCents,
    varianceCents: s.varianceCents,
    saleCount: countFor.get(s.id) ?? 0,
  }))
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
