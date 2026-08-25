import { assertCan } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors/index.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * Money actually handed over against a pay line.
 *
 * Kept apart from `payroll.service.ts` for the reason `refund.service.ts` sits apart from
 * `sales.service.ts`: computing what is owed and moving money are different concerns with
 * different failure modes, and only one of them touches a cash drawer.
 *
 * ⚠️ The store on a CASH payout is the till the notes come OUT of. It has nothing to do with
 * where the hours were worked — people work at both locations and payroll is business-wide.
 * Do not try to reconcile a store's payroll cash against that store's hours.
 */

const CASH_LIMIT_NOTE =
  'Payroll cash comes out of an open drawer, so the count at close accounts for it.'

export interface PayoutInput {
  readonly method: 'CASH' | 'CHECK' | 'BANK'
  readonly amountCents: number
  readonly reference?: string | undefined
  readonly note?: string | undefined
  /** CASH only — which till the money leaves. */
  readonly storeId?: string | undefined
}

export interface PayoutRow {
  readonly id: string
  readonly payLineId: string
  readonly method: string
  readonly amountCents: number
  readonly reference: string | null
  readonly note: string | null
  readonly paidAt: string
  readonly paidByName: string
  readonly reversedAt: string | null
  readonly reversalNote: string | null
}

async function toRow(id: string): Promise<PayoutRow> {
  const p = await prisma.payPayout.findUnique({
    where: { id },
    select: {
      id: true,
      payLineId: true,
      method: true,
      amountCents: true,
      reference: true,
      note: true,
      paidAt: true,
      reversedAt: true,
      reversalNote: true,
      paidBy: { select: { firstName: true, lastName: true } },
    },
  })
  if (!p) throw new NotFoundError('That payout does not exist.')
  return {
    id: p.id,
    payLineId: p.payLineId,
    method: p.method,
    amountCents: p.amountCents,
    reference: p.reference,
    note: p.note,
    paidAt: p.paidAt.toISOString(),
    paidByName: `${p.paidBy.firstName} ${p.paidBy.lastName}`.trim(),
    reversedAt: p.reversedAt?.toISOString() ?? null,
    reversalNote: p.reversalNote,
  }
}

/** The open drawer at a store, locked, or a refusal that says what to do about it. */
async function lockOpenShift(tx: Prisma.TransactionClient, storeId: string): Promise<string> {
  // FOR UPDATE first, exactly as addCashMovement does: a close holds this same lock while it
  // computes `expected`, so a payout cannot slip in mid-count and land on the wrong side.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Shift"
       WHERE "storeId" = ${storeId} AND "status" = 'OPEN'
       FOR UPDATE
    `
  const shiftId = rows[0]?.id
  if (!shiftId) {
    throw new ConflictError(
      'That store has no open drawer, so there is no till to pay cash out of. Open one at the register, or pay by check or transfer.',
    )
  }
  return shiftId
}

/**
 * Record money paid against a pay line.
 *
 * Admin-only. Taking cash out of a till for payroll is the same risk shape as a `PICKUP`,
 * which is admin-only for stated reasons — a cashier who can key one can paper over a
 * shortfall of the same size.
 */
export async function recordPayout(
  principal: Principal,
  payLineId: string,
  input: PayoutInput,
  actorId: string,
): Promise<PayoutRow> {
  assertCan(principal, 'user.manage')

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError('A payout must be more than zero.')
  }

  const line = await prisma.payLine.findUnique({
    where: { id: payLineId },
    select: {
      id: true,
      grossCents: true,
      payRun: { select: { status: true, periodStartDate: true } },
      user: { select: { firstName: true, lastName: true } },
      payouts: { where: { reversedAt: null }, select: { amountCents: true } },
    },
  })
  if (!line) throw new NotFoundError('That pay line does not exist.')
  if (line.payRun.status === 'REVERSED') {
    throw new ConflictError('That pay run has been reversed. Re-run the period before paying it.')
  }

  // Cross-row, so it cannot be a CHECK — service plus a test.
  const alreadyPaid = line.payouts.reduce((a, p) => a + p.amountCents, 0)
  if (alreadyPaid + input.amountCents > line.grossCents) {
    const left = line.grossCents - alreadyPaid
    throw new ConflictError(
      left <= 0
        ? 'That line is already paid in full.'
        : `That is more than is left on the line — ${(left / 100).toFixed(2)} outstanding.`,
    )
  }

  if (input.method === 'CASH' && !input.storeId) {
    throw new ValidationError('Say which till the cash comes out of.')
  }

  const created = await prisma.$transaction(async (tx) => {
    let cashMovementId: string | null = null

    if (input.method === 'CASH') {
      const shiftId = await lockOpenShift(tx, input.storeId!)
      const who = `${line.user.firstName} ${line.user.lastName}`.trim()
      const movement = await tx.cashMovement.create({
        data: {
          shiftId,
          type: 'PAID_OUT',
          amountCents: input.amountCents,
          // closeShift already subtracts PAID_OUT, so the drawer accounts for this the moment
          // the row exists — no change to the shift service at all.
          reason: `Payroll — ${who}, period ${line.payRun.periodStartDate}`,
          userId: actorId,
        },
        select: { id: true },
      })
      cashMovementId = movement.id
    }

    return tx.payPayout.create({
      data: {
        payLineId,
        method: input.method,
        amountCents: input.amountCents,
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        cashMovementId,
        paidById: actorId,
      },
      select: { id: true },
    })
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'payroll.payout.record',
      entityType: 'PayPayout',
      entityId: created.id,
      before: {},
      after: { payLineId, method: input.method, amountCents: input.amountCents },
    },
  })

  return toRow(created.id)
}

/**
 * Reverse a payout.
 *
 * A CASH reversal writes a compensating `PAID_IN` into whichever drawer is open AT REVERSAL
 * TIME — the rule `Refund.shiftId` already follows: money comes back to today's till, not
 * last week's, because that is the drawer it is physically going into.
 */
export async function reversePayout(
  principal: Principal,
  payoutId: string,
  note: string,
  actorId: string,
  storeId?: string,
): Promise<PayoutRow> {
  assertCan(principal, 'user.manage')
  if (!note.trim()) throw new ValidationError('A reversal needs a reason.')

  const payout = await prisma.payPayout.findUnique({
    where: { id: payoutId },
    select: {
      id: true,
      method: true,
      amountCents: true,
      reversedAt: true,
      payLine: {
        select: {
          payRun: { select: { periodStartDate: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  })
  if (!payout) throw new NotFoundError('That payout does not exist.')
  if (payout.reversedAt) throw new ConflictError('That payout has already been reversed.')

  if (payout.method === 'CASH' && !storeId) {
    throw new ValidationError('Say which till the cash goes back into.')
  }

  await prisma.$transaction(async (tx) => {
    let reversalCashMovementId: string | null = null

    if (payout.method === 'CASH') {
      const shiftId = await lockOpenShift(tx, storeId!)
      const who = `${payout.payLine.user.firstName} ${payout.payLine.user.lastName}`.trim()
      const movement = await tx.cashMovement.create({
        data: {
          shiftId,
          type: 'PAID_IN',
          amountCents: payout.amountCents,
          reason: `Payroll reversed — ${who}, period ${payout.payLine.payRun.periodStartDate}`,
          userId: actorId,
        },
        select: { id: true },
      })
      reversalCashMovementId = movement.id
    }

    await tx.payPayout.update({
      where: { id: payoutId },
      data: {
        reversedById: actorId,
        reversedAt: new Date(),
        reversalNote: note.trim(),
        reversalCashMovementId,
      },
    })
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'payroll.payout.reverse',
      entityType: 'PayPayout',
      entityId: payoutId,
      before: { method: payout.method, amountCents: payout.amountCents },
      after: { reversedAt: new Date().toISOString(), reversalNote: note.trim() },
    },
  })

  return toRow(payoutId)
}

export { CASH_LIMIT_NOTE }
