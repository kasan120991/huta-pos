import type { CashMovementInput, CashMovementRow, ShiftRow } from '@huta/shared/schemas'

import type { Principal } from '../auth/principal.js'
import { assertCan } from '../auth/permissions.js'
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
