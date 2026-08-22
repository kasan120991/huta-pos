import { Role } from '@huta/shared'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app.js'
import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, ForbiddenError } from '../../src/errors/index.js'
import { FakePaymentProvider } from '../../src/payments/fake.provider.js'
import { setPaymentProvider } from '../../src/payments/provider.js'
import {
  listRecentSales,
  refundQuote,
  refundSale,
  retryCardRefund,
  voidSale,
} from '../../src/sales/refund.service.js'
import { checkout, createSaleIntent, getSale } from '../../src/sales/sales.service.js'
import { closeShift, currentShift, openShift } from '../../src/sales/shift.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  giveStock,
  makeAdmin,
  makeCategory,
  makeProduct,
  makeStaff,
  makeStore,
  makeTerminal,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Refunds and voids — the first consumer of the step-up mechanism, and the writer of
 * every money-back record. Amounts are cumulative-difference shares of the line's actual
 * charge, so any sequence of partials over a full line sums to exactly what was paid.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let adminUser: { id: string }
let category: { id: string }
let fake: FakePaymentProvider

beforeEach(async () => {
  await resetDatabase()
  fake = new FakePaymentProvider()
  setPaymentProvider(fake)

  storeA = await makeStore('Store A', 'store-a') // 400 bps tax
  storeB = await makeStore('Store B', 'store-b')
  adminUser = await makeAdmin()
  const terminal = await makeTerminal(storeA.id, 'refunds-test-device-token')
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: terminal.id }
  const staffUser = await makeStaff(storeA.id, '4321')
  staff = { kind: 'staff', userId: staffUser.id, role: Role.STAFF, storeId: storeA.id, terminalId: terminal.id }
  category = await makeCategory('Edible', 'edible')
  await openShift(staff, storeA.id, { openingCashCents: 100_00 })
})

afterAll(() => {
  setPaymentProvider(null)
})

async function eachProduct(opts: { stock?: number, priceCents?: number, costBasisCents?: number } = {}) {
  const product = await makeProduct({
    name: `Gummies-${Math.random().toString(36).slice(2, 8)}`,
    categoryId: category.id,
    priceCents: opts.priceCents ?? 10_00,
  })
  const variant = product.variants[0]!
  await giveStock(storeA.id, variant.id, opts.stock ?? 10, opts.costBasisCents)
  return { product, variant }
}

/** A grant exactly as POST /auth/step-up would mint it. */
async function makeGrant(opts: { action?: string, expired?: boolean, consumed?: boolean } = {}) {
  const grant = await prisma.stepUpGrant.create({
    data: {
      adminUserId: adminUser.id,
      action: opts.action ?? 'sale.refund',
      // The window CHECK needs expiresAt > createdAt, so an expired grant is backdated.
      ...(opts.expired
        ? { createdAt: new Date(Date.now() - 300_000), expiresAt: new Date(Date.now() - 1000) }
        : { expiresAt: new Date(Date.now() + 120_000) }),
      ...(opts.consumed ? { consumedAt: new Date() } : {}),
    },
  })
  return grant.id
}

/** A completed cash sale of `quantity` units, returning the receipt. */
async function cashSale(variantId: string, quantity: number, tendered = 100_00) {
  return checkout(staff, {
    lines: [{ variantId, quantityBase: quantity }],
    ageVerified: false,
    tenders: [{ method: 'CASH', tenderedCents: tendered }],
  })
}

/** A completed card sale (optionally split with `cashCents`). */
async function cardSale(variantId: string, quantity: number, cashCents = 0) {
  const staged = await createSaleIntent(staff, {
    lines: [{ variantId, quantityBase: quantity }],
    cashCents,
  })
  fake.succeed(staged.paymentIntentId)
  return checkout(staff, {
    lines: [{ variantId, quantityBase: quantity }],
    ageVerified: false,
    tenders: [
      ...(cashCents > 0 ? [{ method: 'CASH', tenderedCents: cashCents } as const] : []),
      { method: 'CARD', paymentIntentId: staged.paymentIntentId },
    ],
  })
}

describe('the step-up gate', () => {
  it('demands a grant from staff AND admins, naming the action', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 1)
    const input = {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH' as const,
    }

    await expect(refundSale(staff, sale.id, input)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
      details: { action: 'sale.refund' },
    })
    await expect(refundSale(admin, sale.id, input)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    })
    await expect(voidSale(staff, sale.id, { reason: 'wrong item' })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    })
    expect(await prisma.refund.count()).toBe(0)
  })

  it('rejects expired, consumed, and wrong-action grants', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 1)
    const input = {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH' as const,
    }

    for (const grantId of [
      await makeGrant({ expired: true }),
      await makeGrant({ consumed: true }),
      await makeGrant({ action: 'inventory.adjust' }),
    ]) {
      await expect(refundSale(staff, sale.id, { ...input, stepUpGrantId: grantId })).rejects.toThrow(
        ForbiddenError,
      )
    }
    expect(await prisma.refund.count()).toBe(0)
  })

  it('spends a grant exactly once across two concurrent refunds', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 2)
    const grantId = await makeGrant()
    const attempt = (quantity: number) =>
      refundSale(staff, sale.id, {
        lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: quantity, restock: true }],
        method: 'CASH',
        stepUpGrantId: grantId,
      })

    const results = await Promise.allSettled([attempt(1), attempt(1)])
    const ok = results.filter((r) => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    expect(await prisma.refund.count()).toBe(1)
  })
})

describe('cash refunds', () => {
  it('refunds the exact proportional charge, restocks, and records everyone', async () => {
    const { variant } = await eachProduct({ priceCents: 10_00 })
    const sale = await cashSale(variant.id, 4) // $40.00 + 4% = $41.60
    const line = sale.lines[0]!

    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: line.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      reason: 'customer changed their mind',
      stepUpGrantId: await makeGrant(),
    })

    // Line charge = 4000 net + 160 tax = 4160; one of four units = 1040.
    expect(receipt).toMatchObject({
      method: 'CASH',
      amountCents: 10_40,
      status: 'SUCCEEDED',
      saleNumber: sale.number,
      refundedByName: 'Test Staff',
      approvedByName: 'Test Admin',
    })
    expect(receipt.lines).toEqual([
      expect.objectContaining({ quantityBase: 1, amountCents: 10_40, restock: true }),
    ])

    const stored = await prisma.refund.findUnique({ where: { id: receipt.id } })
    expect(stored).toMatchObject({ approvedById: adminUser.id, method: 'CASH' })
    expect(stored!.shiftId).not.toBeNull()

    const movement = await prisma.inventoryMovement.findFirst({ where: { refundId: receipt.id } })
    expect(movement).toMatchObject({ type: 'RETURN', quantityBase: 1 })
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(10 - 4 + 1)

    const after = await getSale(admin, sale.id)
    expect(after.status).toBe('PARTIALLY_REFUNDED')
    expect(after.lines[0]!.refundedQuantityBase).toBe(1)
    expect(after.refunds).toHaveLength(1)
  })

  it('quotes exactly what the refund then pays — the preview IS the money', async () => {
    const { variant } = await eachProduct({ priceCents: 6_67 })
    const sale = await cashSale(variant.id, 3) // charge 20.81, indivisible by 3
    const line = sale.lines[0]!

    const quoted = await refundQuote(staff, sale.id, {
      lines: [{ saleLineId: line.id, quantityBase: 2 }],
    })
    const actual = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: line.id, quantityBase: 2, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })

    expect(quoted.totalCents).toBe(actual.amountCents)
    expect(quoted.lines[0]!.amountCents).toBe(actual.lines[0]!.amountCents)
  })

  it('sums a full line refunded in partials to EXACTLY its charge', async () => {
    // 3 × $6.67 = 2001 net, 4% tax = 80 → charge 2081, indivisible by 3.
    const { variant } = await eachProduct({ priceCents: 6_67 })
    const sale = await cashSale(variant.id, 3)
    const line = sale.lines[0]!
    expect(line.netCents + line.taxCents).toBe(20_81)

    const amounts: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = await refundSale(staff, sale.id, {
        lines: [{ saleLineId: line.id, quantityBase: 1, restock: true }],
        method: 'CASH',
        stepUpGrantId: await makeGrant(),
      })
      amounts.push(r.amountCents)
    }

    expect(amounts.reduce((a, b) => a + b, 0)).toBe(20_81)
    // Cumulative-difference: 694, 693, 694 — never a stranded or invented cent.
    expect(amounts).toEqual([6_94, 6_93, 6_94])
    expect((await getSale(admin, sale.id)).status).toBe('REFUNDED')
  })

  it('keeps damaged goods out of stock when restock is off', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 2)

    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: false }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })

    expect(receipt.amountCents).toBe(10_40)
    expect(await prisma.inventoryMovement.count({ where: { refundId: receipt.id } })).toBe(0)
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(8) // sold 2, none came back
  })

  it('refuses more than remains, then completes the rest', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 2)
    const line = sale.lines[0]!

    await refundSale(staff, sale.id, {
      lines: [{ saleLineId: line.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })

    await expect(
      refundSale(staff, sale.id, {
        lines: [{ saleLineId: line.id, quantityBase: 2, restock: true }],
        method: 'CASH',
        stepUpGrantId: await makeGrant(),
      }),
    ).rejects.toThrow(ConflictError)

    await refundSale(staff, sale.id, {
      lines: [{ saleLineId: line.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })
    expect((await getSale(admin, sale.id)).status).toBe('REFUNDED')
  })

  it('needs an open drawer — cash refunds with no shift are refused', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 1)
    const open = await currentShift(staff, storeA.id)
    await closeShift(staff, open!.id, { countedCashCents: 0 })

    await expect(
      refundSale(staff, sale.id, {
        lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
        method: 'CASH',
        stepUpGrantId: await makeGrant(),
      }),
    ).rejects.toThrow(ConflictError)
  })
})

describe('card refunds', () => {
  it('settles record-first: PENDING commits, Stripe answers, SUCCEEDED lands', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 2) // $20.80 on the card

    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await makeGrant(),
    })

    expect(receipt.status).toBe('SUCCEEDED')
    expect(fake.refunds).toEqual([expect.objectContaining({ amountCents: 10_40 })])
    const stored = await prisma.refund.findUnique({ where: { id: receipt.id } })
    expect(stored!.stripeRefundId).toBe(fake.refunds[0]!.refundId)
    expect(stored!.paymentId).not.toBeNull()
  })

  it('keeps the record and the restock when Stripe fails, and retries from admin', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 1)
    fake.failNextRefund()

    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await makeGrant(),
    })

    expect(receipt.status).toBe('FAILED')
    // The goods came back regardless — the movement stands.
    expect(await prisma.inventoryMovement.count({ where: { refundId: receipt.id } })).toBe(1)

    const retried = await retryCardRefund(admin, receipt.id)
    expect(retried.status).toBe('SUCCEEDED')
    expect(fake.refunds).toHaveLength(2)
  })

  it('never refunds a card more than it paid', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 2, 5_00) // card took 15.80, cash 5.00
    const line = sale.lines[0]!

    // Both units back on the card would be 20.80 — more than the card's 15.80.
    await expect(
      refundSale(staff, sale.id, {
        lines: [{ saleLineId: line.id, quantityBase: 2, restock: true }],
        method: 'CARD',
        stepUpGrantId: await makeGrant(),
      }),
    ).rejects.toThrow(ConflictError)

    // One unit (10.40) fits on the card; a cash-only sale obviously has no card to take it.
    const ok = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: line.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await makeGrant(),
    })
    expect(ok.amountCents).toBe(10_40)

    const cashOnly = await cashSale(variant.id, 1)
    await expect(
      refundSale(staff, cashOnly.id, {
        lines: [{ saleLineId: cashOnly.lines[0]!.id, quantityBase: 1, restock: true }],
        method: 'CARD',
        stepUpGrantId: await makeGrant(),
      }),
    ).rejects.toThrow(ConflictError)
  })

  it('records no shift when none is open — card money never touches a drawer', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 1)
    const open = await currentShift(staff, storeA.id)
    await closeShift(staff, open!.id, { countedCashCents: 0 })

    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await makeGrant(),
    })

    expect(receipt.status).toBe('SUCCEEDED')
    expect((await prisma.refund.findUnique({ where: { id: receipt.id } }))!.shiftId).toBeNull()
  })
})

describe('voids', () => {
  it('reverses the whole sale: refund rows, restock, VOIDED, both names', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 2)

    const voided = await voidSale(staff, sale.id, {
      reason: 'rang the wrong item',
      stepUpGrantId: await makeGrant(),
    })

    expect(voided.status).toBe('VOIDED')
    expect(voided.voidReason).toBe('rang the wrong item')
    expect(voided.voidedAt).not.toBeNull()
    expect(voided.refunds).toHaveLength(1)
    expect(voided.refunds[0]).toMatchObject({ method: 'CASH', amountCents: 20_80 })
    expect(voided.refunds[0]!.lines).toEqual([
      expect.objectContaining({ quantityBase: 2, amountCents: 20_80, restock: true }),
    ])

    const stored = await prisma.sale.findUnique({ where: { id: sale.id }, select: { voidedById: true } })
    expect(stored!.voidedById).toBe(staff.userId) // the acting cashier…
    const refund = await prisma.refund.findFirst({ where: { saleId: sale.id } })
    expect(refund!.approvedById).toBe(adminUser.id) // …and the approving admin

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(10) // everything came back
  })

  it('disburses a split void card-first: two refund rows, lines on the first', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 2, 5_00) // 15.80 card + 5.00 cash

    const voided = await voidSale(staff, sale.id, {
      reason: 'customer walked',
      stepUpGrantId: await makeGrant(),
    })

    expect(voided.refunds).toHaveLength(2)
    const [first, second] = voided.refunds
    expect(first).toMatchObject({ method: 'CARD', amountCents: 15_80, status: 'SUCCEEDED' })
    expect(first!.lines).toHaveLength(1)
    expect(second).toMatchObject({ method: 'CASH', amountCents: 5_00 })
    expect(second!.lines).toHaveLength(0)
    expect(fake.refunds).toEqual([expect.objectContaining({ amountCents: 15_80 })])
  })

  it('voids a $0 sale cleanly', async () => {
    const { variant } = await eachProduct()
    const sale = await checkout(staff, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      orderDiscount: { discountType: 'PERCENT_OFF', value: 10000 },
      ageVerified: false,
      tenders: [],
    })

    const voided = await voidSale(staff, sale.id, {
      reason: 'test ring',
      stepUpGrantId: await makeGrant(),
    })
    expect(voided.status).toBe('VOIDED')
    expect(voided.refunds[0]).toMatchObject({ method: 'CASH', amountCents: 0 })
  })

  it('refuses once the shift has closed, or after any refund', async () => {
    const { variant } = await eachProduct()
    const partiallyRefunded = await cashSale(variant.id, 2)
    await refundSale(staff, partiallyRefunded.id, {
      lines: [{ saleLineId: partiallyRefunded.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })
    await expect(
      voidSale(staff, partiallyRefunded.id, { reason: 'x', stepUpGrantId: await makeGrant() }),
    ).rejects.toThrow(ConflictError)

    const lateSale = await cashSale(variant.id, 1)
    const open = await currentShift(staff, storeA.id)
    await closeShift(staff, open!.id, { countedCashCents: 0 })
    await expect(
      voidSale(staff, lateSale.id, { reason: 'x', stepUpGrantId: await makeGrant() }),
    ).rejects.toThrow(ConflictError)
  })
})

describe('the drawer', () => {
  it('subtracts same-shift cash refunds from expected, and nets a voided sale to zero', async () => {
    const { variant } = await eachProduct()

    // $20.80 cash sale, then $10.40 of it refunded, then a second sale voided entirely.
    const sale = await cashSale(variant.id, 2)
    await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })
    const doomed = await cashSale(variant.id, 1) // $10.40
    await voidSale(staff, doomed.id, { reason: 'mistake', stepUpGrantId: await makeGrant() })

    const open = await currentShift(staff, storeA.id)
    expect(open).toMatchObject({ cashSalesCents: 31_20, cashRefundsCents: 20_80 })

    const closed = await closeShift(staff, open!.id, { countedCashCents: 110_40 })
    // 100.00 opening + 31.20 cash sales − 10.40 refund − 10.40 void = 110.40.
    expect(closed.expectedCashCents).toBe(110_40)
    expect(closed.varianceCents).toBe(0)
  })

  it('pays a cross-shift cash refund out of the CURRENT drawer, not the sale day one', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 1) // $10.40, shift 1

    const first = await currentShift(staff, storeA.id)
    const closedFirst = await closeShift(staff, first!.id, { countedCashCents: 110_40 })
    expect(closedFirst.expectedCashCents).toBe(110_40)
    expect(closedFirst.varianceCents).toBe(0)

    await openShift(staff, storeA.id, { openingCashCents: 50_00 })
    await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })

    const second = await currentShift(staff, storeA.id)
    expect(second).toMatchObject({ cashSalesCents: 0, cashRefundsCents: 10_40 })
    const closedSecond = await closeShift(staff, second!.id, { countedCashCents: 39_60 })
    expect(closedSecond.expectedCashCents).toBe(39_60) // 50.00 − 10.40
    expect(closedSecond.varianceCents).toBe(0)
    // The first shift's settled figures did not move.
    expect((await prisma.shift.findUnique({ where: { id: first!.id } }))!.expectedCashCents).toBe(110_40)
  })

  it('keeps card money out of expected in both directions', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 2) // $20.80 on the card
    await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await makeGrant(),
    })

    const open = await currentShift(staff, storeA.id)
    expect(open).toMatchObject({ cardSalesCents: 20_80, cashSalesCents: 0, cashRefundsCents: 0 })
    const closed = await closeShift(staff, open!.id, { countedCashCents: 100_00 })
    expect(closed.expectedCashCents).toBe(100_00) // opening float only
  })
})

describe('the webhook, refund lifecycle', () => {
  it('flips a PENDING card refund by stripeRefundId, idempotently', async () => {
    const { variant } = await eachProduct()
    const sale = await cardSale(variant.id, 1)
    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await makeGrant(),
    })
    const stripeRefundId = (await prisma.refund.findUnique({ where: { id: receipt.id } }))!
      .stripeRefundId!

    const app = createApp()
    const deliver = (id: string) =>
      request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 'test-signature')
        .set('content-type', 'application/json')
        .send(JSON.stringify({
          id,
          type: 'refund.failed',
          payload: { id: stripeRefundId, status: 'failed' },
        }))

    expect((await deliver('evt_rf_1')).status).toBe(200)
    expect((await prisma.refund.findUnique({ where: { id: receipt.id } }))!.status).toBe('FAILED')

    // The retry of the same event changes nothing and still answers 200.
    expect((await deliver('evt_rf_1')).body).toEqual({ received: true, duplicate: true })
    expect(await prisma.stripeEvent.count({ where: { type: 'refund.failed' } })).toBe(1)
  })
})

describe('scoping and visibility', () => {
  it('pins refunds to the terminal store and strips cost from staff', async () => {
    const { variant } = await eachProduct()
    const sale = await cashSale(variant.id, 1)

    const otherTerminal = await makeTerminal(storeB.id, 'refunds-storeB-token', 'Register B')
    const otherStaffUser = await makeStaff(storeB.id, '9876', 'staffb@test.local')
    const otherStaff: StaffPrincipal = {
      kind: 'staff',
      userId: otherStaffUser.id,
      role: Role.STAFF,
      storeId: storeB.id,
      terminalId: otherTerminal.id,
    }

    await expect(
      refundSale(otherStaff, sale.id, {
        lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
        method: 'CASH',
        stepUpGrantId: await makeGrant(),
      }),
    ).rejects.toThrow(ForbiddenError)

    const receipt = await refundSale(staff, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await makeGrant(),
    })
    expect(findCostKeys(receipt)).toEqual([])
  })

  it('lists this store’s recent sales with their payment methods', async () => {
    const { variant } = await eachProduct()
    const first = await cashSale(variant.id, 1)
    await cardSale(variant.id, 1)

    const rows = await listRecentSales(staff, {})
    expect(rows).toHaveLength(2)
    expect(rows[0]!.paymentMethods).toEqual(['CARD']) // newest first
    expect(rows[1]!).toMatchObject({ number: first.number, paymentMethods: ['CASH'] })

    const byNumber = await listRecentSales(staff, { number: first.number })
    expect(byNumber).toHaveLength(1)
    expect(byNumber[0]!.id).toBe(first.id)
  })
})
