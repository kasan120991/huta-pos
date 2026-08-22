import { divRoundHalfUp } from '@huta/shared'
import type {
  RefundInput,
  RefundQuoteInput,
  RefundQuoteResult,
  RefundReceipt,
  SaleReceipt,
  SaleSummaryRow,
  VoidInput,
} from '@huta/shared/schemas'

import { assertCan } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { consume } from '../auth/stepup.service.js'
import { prisma } from '../db/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  ValidationError,
} from '../errors/index.js'
import { applyMovement } from '../inventory/inventory.service.js'
import { getPaymentProvider } from '../payments/provider.js'
import { emitToAdmin, emitToStore } from '../realtime/emitter.js'
import { getSale, mapRefund, refundSelect } from './sales.service.js'

type Db = Prisma.TransactionClient

/**
 * Refunds and voids — the register's first consumer of the step-up mechanism.
 *
 * Policy (Kasan, 2026-08-18): EVERY refund and void needs an admin step-up grant, staff
 * and admins alike. The grant is single-use, action-bound and two minutes wide; its row
 * is the audit record, and the approving admin lands on `Refund.approvedById`.
 *
 * Amounts are SERVER-computed by cumulative-difference shares of each line's actual
 * charge (net + tax): `amount(q) = share(prev+q) − share(prev)` with
 * `share(n) = divRoundHalfUp(C·n, quantityBase)`. Any sequence of partial refunds over a
 * full line therefore sums to exactly its charge — no cent is ever stranded or invented.
 *
 * Disbursement is RECORD-FIRST: the transaction commits (card refunds born PENDING),
 * THEN Stripe is called, then the status settles. The failure mode of the other order —
 * money moved with no record — is the silent one, and this codebase never loses money
 * silently. A FAILED card refund keeps its restock movements (the goods physically came
 * back) and is retried from the admin side.
 *
 * Lock order: shift → sale → StockLevel. The shift FOR UPDATE settles close-vs-refund
 * (an expected-cash figure is computed over a settled drawer); the sale FOR UPDATE
 * serialises concurrent refunds of one sale so quantity checks cannot race.
 */

const STEP_UP_ACTION = 'sale.refund' as const

async function requireApproval(stepUpGrantId: string | undefined): Promise<string> {
  if (!stepUpGrantId) throw new StepUpRequiredError(STEP_UP_ACTION)
  const { approvedByUserId } = await consume(stepUpGrantId, STEP_UP_ACTION)
  return approvedByUserId
}

/** The terminal's store — refunds happen at a drawer, exactly like ringing a sale. */
async function resolveStoreId(principal: Principal): Promise<string> {
  if (principal.terminalId === null) {
    throw new ForbiddenError('Refunds happen at a register — attach at a terminal first.')
  }
  if (principal.storeId !== null) return principal.storeId
  const terminal = await prisma.terminal.findUnique({
    where: { id: principal.terminalId },
    select: { storeId: true, active: true },
  })
  if (!terminal || !terminal.active) throw new NotFoundError('That terminal does not exist.')
  return terminal.storeId
}

/** `share(n)` of a line's charge — see the module comment. */
function shareOfCharge(chargeCents: number, n: number, quantityBase: number): number {
  return divRoundHalfUp(chargeCents * n, quantityBase)
}

/** The one place refund amounts come from — the quote and the refund both call this. */
function computeRefundAmounts(
  sale: SaleForRefund,
  lines: ReadonlyArray<{ saleLineId: string, quantityBase: number }>,
) {
  const lineById = new Map(sale.lines.map((l) => [l.id, l]))
  return lines.map((l) => {
    const line = lineById.get(l.saleLineId)!
    const charge = line.netCents + line.taxCents
    const amountCents =
      shareOfCharge(charge, line.refundedQuantityBase + l.quantityBase, line.quantityBase) -
      shareOfCharge(charge, line.refundedQuantityBase, line.quantityBase)
    return { saleLineId: l.saleLineId, variantId: line.variantId, amountCents }
  })
}

const saleForRefund = {
  id: true,
  number: true,
  storeId: true,
  shiftId: true,
  status: true,
  totalCents: true,
  lines: {
    select: {
      id: true,
      variantId: true,
      quantityBase: true,
      refundedQuantityBase: true,
      netCents: true,
      taxCents: true,
    },
  },
  payments: {
    where: { status: 'SUCCEEDED' as const },
    select: { id: true, method: true, amountCents: true, stripePaymentIntentId: true },
  },
} as const

type SaleForRefund = Prisma.SaleGetPayload<{ select: typeof saleForRefund }>

/** Lock shift (when open) then sale — every path through here holds both or neither. */
async function lockShiftAndSale(
  tx: Db,
  storeId: string,
  saleId: string,
): Promise<{ openShiftId: string | null, sale: SaleForRefund }> {
  const shifts = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Shift"
     WHERE "storeId" = ${storeId} AND "status" = 'OPEN'
     FOR UPDATE
  `
  await tx.$queryRaw`SELECT "id" FROM "Sale" WHERE "id" = ${saleId} FOR UPDATE`
  const sale = await tx.sale.findUnique({ where: { id: saleId }, select: saleForRefund })
  if (!sale) throw new NotFoundError('That sale does not exist.')
  if (sale.storeId !== storeId) throw new ForbiddenError('That sale belongs to another store.')
  return { openShiftId: shifts[0]?.id ?? null, sale }
}

/** Settle a PENDING card refund against Stripe — record-first, so this runs POST-commit. */
async function settleCardRefund(refundId: string): Promise<boolean> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: {
      amountCents: true,
      payment: { select: { stripePaymentIntentId: true } },
    },
  })
  const intentId = refund?.payment?.stripePaymentIntentId
  if (!refund || !intentId) return false

  // A $0 card refund (voiding a fully discounted sale) has nothing to move.
  if (refund.amountCents === 0) {
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'SUCCEEDED' } })
    return true
  }

  try {
    const result = await getPaymentProvider().refund({
      paymentIntentId: intentId,
      amountCents: refund.amountCents,
    })
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        stripeRefundId: result.refundId,
        status:
          result.status === 'succeeded'
            ? 'SUCCEEDED'
            : result.status === 'failed'
              ? 'FAILED'
              : 'PENDING',
      },
    })
    return result.status !== 'failed'
  } catch (error) {
    console.error(`[payments] card refund ${refundId} failed against Stripe`, error)
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED' } })
    return false
  }
}

export async function refundSale(
  principal: Principal,
  saleId: string,
  input: RefundInput,
): Promise<RefundReceipt> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, STEP_UP_ACTION, { storeId })
  if (principal.userId === null) throw new ForbiddenError('A refund needs a person.')
  const refundedById = principal.userId

  if (input.lines.length === 0) throw new ValidationError('Nothing to refund.')
  const seen = new Set(input.lines.map((l) => l.saleLineId))
  if (seen.size !== input.lines.length) {
    throw new ValidationError('Each line may appear only once in a refund.')
  }

  // Cheap validation BEFORE the grant is consumed — a burned grant means re-keying an
  // admin PIN, so obvious mistakes must fail first. The transaction re-checks under lock.
  const preview = await prisma.sale.findUnique({ where: { id: saleId }, select: saleForRefund })
  if (!preview) throw new NotFoundError('That sale does not exist.')
  if (preview.storeId !== storeId) throw new ForbiddenError('That sale belongs to another store.')
  assertRefundable(preview, input.lines)

  const approvedById = await requireApproval(input.stepUpGrantId)

  const created = await prisma.$transaction(
    async (tx) => {
      const { openShiftId, sale } = await lockShiftAndSale(tx, storeId, saleId)
      assertRefundable(sale, input.lines)
      if (input.method === 'CASH' && openShiftId === null) {
        throw new ConflictError('Open a shift first — a cash refund pays out of the drawer.')
      }

      const amounts = computeRefundAmounts(sale, input.lines)
      const computed = input.lines.map((l, i) => ({ ...l, ...amounts[i]! }))
      const totalCents = computed.reduce((sum, l) => sum + l.amountCents, 0)

      // A card refund goes back to the card that paid — and never more than it paid,
      // counting refunds already issued or still pending against it.
      let paymentId: string | null = null
      if (input.method === 'CARD') {
        const cardPayment = sale.payments.find((p) => p.method === 'CARD')
        if (!cardPayment) throw new ConflictError('No card paid for this sale — refund in cash.')
        const prior = await tx.refund.aggregate({
          where: { saleId, method: 'CARD', status: { not: 'FAILED' } },
          _sum: { amountCents: true },
        })
        const remaining = cardPayment.amountCents - (prior._sum.amountCents ?? 0)
        if (totalCents > remaining) {
          throw new ConflictError(
            `The card paid ${remaining} more cents at most — refund the rest in cash.`,
          )
        }
        paymentId = cardPayment.id
      }

      const refund = await tx.refund.create({
        data: {
          saleId,
          paymentId,
          shiftId: openShiftId,
          refundedById,
          approvedById,
          method: input.method,
          amountCents: totalCents,
          // Record-first: a card refund is PENDING until Stripe answers, post-commit.
          status: input.method === 'CASH' ? 'SUCCEEDED' : 'PENDING',
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          lines: {
            createMany: {
              data: computed.map((l) => ({
                saleLineId: l.saleLineId,
                quantityBase: l.quantityBase,
                amountCents: l.amountCents,
                restock: l.restock,
              })),
            },
          },
        },
        select: { id: true },
      })

      for (const l of computed) {
        if (l.restock) {
          await applyMovement(
            {
              storeId,
              variantId: l.variantId,
              type: 'RETURN',
              quantityBase: l.quantityBase,
              userId: refundedById,
              reference: { refundId: refund.id },
            },
            tx,
          )
        }
        await tx.saleLine.update({
          where: { id: l.saleLineId },
          data: { refundedQuantityBase: { increment: l.quantityBase } },
        })
      }

      await tx.sale.update({
        where: { id: saleId },
        data: { status: await resolveRefundedStatus(tx, saleId) },
      })

      return { refundId: refund.id, saleNumber: sale.number, restocked: computed.filter((l) => l.restock) }
    },
    { timeout: 15_000 },
  )

  const settled = input.method === 'CARD' ? await settleCardRefund(created.refundId) : true
  const receipt = await getRefund(created.refundId, created.saleNumber)

  // After commit, never throwing.
  emitToAdmin({
    name: 'sale.refunded',
    payload: {
      saleId,
      storeId,
      number: created.saleNumber,
      amountCents: receipt.amountCents,
      method: input.method,
      cardRefundFailed: !settled,
    },
  })
  for (const l of created.restocked) {
    emitToStore(storeId, { name: 'stock.changed', payload: { storeId, variantId: l.variantId } })
  }

  return receipt
}

/** Call sites already hold the sale row (or its preview) — pure checks, no I/O. */
function assertRefundable(
  sale: SaleForRefund,
  lines: ReadonlyArray<{ saleLineId: string, quantityBase: number }>,
): void {
  if (sale.status === 'VOIDED') throw new ConflictError('That sale was voided — nothing is left to refund.')
  if (sale.status === 'REFUNDED') throw new ConflictError('That sale is already fully refunded.')
  const lineById = new Map(sale.lines.map((l) => [l.id, l]))
  for (const l of lines) {
    const line = lineById.get(l.saleLineId)
    if (!line) throw new NotFoundError('That sale has no such line.')
    if (l.quantityBase <= 0) throw new ValidationError('Refund quantities must be positive.')
    const remaining = line.quantityBase - line.refundedQuantityBase
    if (l.quantityBase > remaining) {
      throw new ConflictError(
        `Only ${remaining} base units remain unrefunded on that line.`,
      )
    }
  }
}

/**
 * What a refund of these lines would give back — read-only, no grant needed. The
 * register's return surface renders these figures verbatim; the real refund runs the
 * same computation again under lock.
 */
export async function refundQuote(
  principal: Principal,
  saleId: string,
  input: RefundQuoteInput,
): Promise<RefundQuoteResult> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, STEP_UP_ACTION, { storeId })

  const sale = await prisma.sale.findUnique({ where: { id: saleId }, select: saleForRefund })
  if (!sale) throw new NotFoundError('That sale does not exist.')
  if (sale.storeId !== storeId) throw new ForbiddenError('That sale belongs to another store.')
  assertRefundable(sale, input.lines)

  const amounts = computeRefundAmounts(sale, input.lines)
  return {
    lines: amounts.map((a) => ({ saleLineId: a.saleLineId, amountCents: a.amountCents })),
    totalCents: amounts.reduce((sum, a) => sum + a.amountCents, 0),
  }
}

async function resolveRefundedStatus(tx: Db, saleId: string) {
  const outstanding = await tx.saleLine.count({
    where: { saleId, refundedQuantityBase: { lt: tx.saleLine.fields.quantityBase } },
  })
  return outstanding === 0 ? ('REFUNDED' as const) : ('PARTIALLY_REFUNDED' as const)
}

async function getRefund(refundId: string, saleNumber?: number): Promise<RefundReceipt> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { ...refundSelect, sale: { select: { number: true } } },
  })
  if (!refund) throw new NotFoundError('That refund does not exist.')
  return mapRefund(refund, saleNumber ?? refund.sale.number)
}

export async function voidSale(
  principal: Principal,
  saleId: string,
  input: VoidInput,
): Promise<SaleReceipt> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, STEP_UP_ACTION, { storeId })
  if (principal.userId === null) throw new ForbiddenError('A void needs a person.')
  const voidedById = principal.userId
  if (input.reason.trim().length === 0) throw new ValidationError('A void needs a reason.')

  // Cheap validation before the grant burns — same shape as refundSale.
  const preview = await prisma.sale.findUnique({ where: { id: saleId }, select: saleForRefund })
  if (!preview) throw new NotFoundError('That sale does not exist.')
  if (preview.storeId !== storeId) throw new ForbiddenError('That sale belongs to another store.')
  assertVoidable(preview)

  const approvedById = await requireApproval(input.stepUpGrantId)

  const created = await prisma.$transaction(
    async (tx) => {
      const { openShiftId, sale } = await lockShiftAndSale(tx, storeId, saleId)
      assertVoidable(sale)
      // A void un-rings a sale at the drawer it was rung on. Once that shift closes, its
      // arithmetic is settled — later reversals are refunds against a later drawer.
      if (openShiftId === null || openShiftId !== sale.shiftId) {
        throw new ConflictError("That sale's shift has closed — issue a refund instead.")
      }

      const cardPayment = sale.payments.find((p) => p.method === 'CARD')
      const cardCents = cardPayment?.amountCents ?? 0
      const cashCents = sale.totalCents - cardCents

      // Card-first disbursement; the FIRST refund row carries the lines and movements.
      // A cash-only (or $0) sale writes a single CASH row.
      const disbursements: Array<{ method: 'CASH' | 'CARD', amountCents: number, paymentId: string | null }> = []
      if (cardPayment) {
        disbursements.push({ method: 'CARD', amountCents: cardCents, paymentId: cardPayment.id })
      }
      if (cashCents > 0 || !cardPayment) {
        disbursements.push({ method: 'CASH', amountCents: cashCents, paymentId: null })
      }

      const refundIds: string[] = []
      for (const [index, d] of disbursements.entries()) {
        const refund = await tx.refund.create({
          data: {
            saleId,
            paymentId: d.paymentId,
            shiftId: openShiftId,
            refundedById: voidedById,
            approvedById,
            method: d.method,
            amountCents: d.amountCents,
            status: d.method === 'CASH' ? 'SUCCEEDED' : 'PENDING',
            reason: input.reason,
            ...(index === 0
              ? {
                  lines: {
                    createMany: {
                      data: sale.lines.map((line) => {
                        const charge = line.netCents + line.taxCents
                        return {
                          saleLineId: line.id,
                          quantityBase: line.quantityBase,
                          // The line's remaining charge — for a clean void that is the
                          // whole charge; the split of money across disbursements is a
                          // payment-level fact, not a line-level one.
                          amountCents:
                            charge -
                            shareOfCharge(charge, line.refundedQuantityBase, line.quantityBase),
                          restock: true,
                        }
                      }),
                    },
                  },
                }
              : {}),
          },
          select: { id: true },
        })
        refundIds.push(refund.id)
      }

      for (const line of sale.lines) {
        await applyMovement(
          {
            storeId,
            variantId: line.variantId,
            type: 'RETURN',
            quantityBase: line.quantityBase,
            userId: voidedById,
            reference: { refundId: refundIds[0]! },
          },
          tx,
        )
        await tx.saleLine.update({
          where: { id: line.id },
          data: { refundedQuantityBase: line.quantityBase },
        })
      }

      await tx.sale.update({
        where: { id: saleId },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedById,
          voidReason: input.reason,
        },
      })

      return {
        saleNumber: sale.number,
        totalCents: sale.totalCents,
        cardRefundId: cardPayment ? refundIds[0]! : null,
        variantIds: [...new Set(sale.lines.map((l) => l.variantId))],
      }
    },
    { timeout: 15_000 },
  )

  const settled = created.cardRefundId ? await settleCardRefund(created.cardRefundId) : true

  emitToAdmin({
    name: 'sale.refunded',
    payload: {
      saleId,
      storeId,
      number: created.saleNumber,
      amountCents: created.totalCents,
      method: created.cardRefundId ? 'CARD' : 'CASH',
      cardRefundFailed: !settled,
    },
  })
  for (const variantId of created.variantIds) {
    emitToStore(storeId, { name: 'stock.changed', payload: { storeId, variantId } })
  }

  return getSale(principal, saleId)
}

function assertVoidable(sale: SaleForRefund): void {
  if (sale.status === 'VOIDED') throw new ConflictError('That sale is already voided.')
  if (sale.status !== 'COMPLETED' || sale.lines.some((l) => l.refundedQuantityBase > 0)) {
    throw new ConflictError('That sale has refunds against it — refund the rest instead of voiding.')
  }
}

/** Admin retry for a card refund whose Stripe call failed. The record already stands. */
export async function retryCardRefund(principal: Principal, refundId: string): Promise<RefundReceipt> {
  assertCan(principal, STEP_UP_ACTION, {})
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { id: true, method: true, status: true },
  })
  if (!refund) throw new NotFoundError('That refund does not exist.')
  if (refund.method !== 'CARD' || refund.status !== 'FAILED') {
    throw new ConflictError('Only a failed card refund can be retried.')
  }
  await settleCardRefund(refundId)
  return getRefund(refundId)
}

/** The return surface's list: this store's latest sales, optionally by receipt number. */
export async function listRecentSales(
  principal: Principal,
  filter: { number?: number | undefined },
): Promise<SaleSummaryRow[]> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, 'sale.ring', { storeId })

  const sales = await prisma.sale.findMany({
    where: { storeId, ...(filter.number !== undefined ? { number: filter.number } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      number: true,
      createdAt: true,
      totalCents: true,
      status: true,
      cashier: { select: { firstName: true, lastName: true } },
      payments: { where: { status: 'SUCCEEDED' }, select: { method: true } },
    },
  })

  return sales.map((sale) => ({
    id: sale.id,
    number: sale.number,
    createdAt: sale.createdAt.toISOString(),
    totalCents: sale.totalCents,
    status: sale.status,
    cashierName: `${sale.cashier.firstName} ${sale.cashier.lastName}`.trim(),
    paymentMethods: [...new Set(sale.payments.map((p) => p.method))],
  }))
}
