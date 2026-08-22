import { DiscountType, Role } from '@huta/shared'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app.js'
import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import {
  ConflictError,
  InsufficientStockError,
  PaymentFailedError,
} from '../../src/errors/index.js'
import { FakePaymentProvider } from '../../src/payments/fake.provider.js'
import { setPaymentProvider } from '../../src/payments/provider.js'
import { checkout, createSaleIntent, getSale } from '../../src/sales/sales.service.js'
import { openShift } from '../../src/sales/shift.service.js'
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
 * Card payments and split tender — Phase 9.
 *
 * The card amount always belongs to the INTENT (staged from the server's own quote),
 * never to the request body, and checkout re-verifies it against a fresh in-transaction
 * quote. Every failure after the charge must end with the money back on the card —
 * except intent_already_used, where the money belongs to the sale that won.
 */

let storeA: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let category: { id: string }
let fake: FakePaymentProvider

beforeEach(async () => {
  await resetDatabase()
  fake = new FakePaymentProvider()
  setPaymentProvider(fake)

  storeA = await makeStore('Store A', 'store-a') // 400 bps tax
  const adminUser = await makeAdmin()
  const terminal = await makeTerminal(storeA.id, 'payments-test-device-token')
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: terminal.id }
  const staffUser = await makeStaff(storeA.id, '4321')
  staff = { kind: 'staff', userId: staffUser.id, role: Role.STAFF, storeId: storeA.id, terminalId: terminal.id }
  category = await makeCategory('Edible', 'edible')
  await openShift(staff, storeA.id, { openingCashCents: 100_00 })
})

afterAll(() => {
  setPaymentProvider(null)
})

/** An EACH product at $10.00, stocked at Store A. */
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

describe('staging an intent', () => {
  it('prices the card from the SERVER quote: total − cash', async () => {
    const { variant } = await eachProduct()

    // 2 × $10.00 + 4% = $20.80; $5.00 in cash leaves $15.80 on the card.
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      cashCents: 5_00,
    })

    expect(staged.totalCents).toBe(20_80)
    expect(staged.cardAmountCents).toBe(15_80)
    const intent = await fake.retrieveIntent(staged.paymentIntentId)
    expect(intent.amountCents).toBe(15_80)
    expect(intent.metadata).toMatchObject({ storeId: storeA.id, cashierId: admin.userId })
  })

  it('refuses to stage a card for nothing — cash already covers the sale', async () => {
    const { variant } = await eachProduct()
    await expect(
      createSaleIntent(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        cashCents: 10_40,
      }),
    ).rejects.toThrow(ConflictError)
  })
})

describe('a card sale', () => {
  it('rings with the intent verified, and snapshots brand and last4', async () => {
    const { variant } = await eachProduct()
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      cashCents: 0,
    })
    fake.succeed(staged.paymentIntentId)

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      ageVerified: false,
      tenders: [{ method: 'CARD', paymentIntentId: staged.paymentIntentId }],
    })

    expect(receipt.totalCents).toBe(20_80)
    expect(receipt.payments).toHaveLength(1)
    expect(receipt.payments[0]).toEqual({
      method: 'CARD',
      amountCents: 20_80,
      cardBrand: 'visa',
      cardLast4: '4242',
    })
    const payment = await prisma.payment.findFirst({ where: { saleId: receipt.id } })
    expect(payment).toMatchObject({
      method: 'CARD',
      status: 'SUCCEEDED',
      stripePaymentIntentId: staged.paymentIntentId,
      cashTenderedCents: null,
      cashChangeCents: null,
    })
  })

  it('refuses an unconfirmed intent and writes nothing', async () => {
    const { variant } = await eachProduct()
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      cashCents: 0,
    })
    // Never confirmed.

    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 2 }],
        ageVerified: false,
        tenders: [{ method: 'CARD', paymentIntentId: staged.paymentIntentId }],
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'not_succeeded' } })

    expect(await prisma.sale.count()).toBe(0)
    expect(fake.refunds).toHaveLength(0) // no money moved, nothing to give back
  })

  it('refunds the charge when the cart drifted after staging (amount_mismatch)', async () => {
    const { variant } = await eachProduct()
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      cashCents: 0,
    })
    fake.succeed(staged.paymentIntentId)

    // The cart grew to 2 units after the card was taken for 1.
    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 2 }],
        ageVerified: false,
        tenders: [{ method: 'CARD', paymentIntentId: staged.paymentIntentId }],
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'amount_mismatch' } })

    expect(await prisma.sale.count()).toBe(0)
    expect(fake.refunds).toEqual([
      expect.objectContaining({ paymentIntentId: staged.paymentIntentId, amountCents: 10_40 }),
    ])
  })

  it('gives one intent to exactly one sale, and never refunds the winner', async () => {
    const { variant } = await eachProduct()
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      cashCents: 0,
    })
    fake.succeed(staged.paymentIntentId)
    const input = {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CARD', paymentIntentId: staged.paymentIntentId } as const],
    }

    const first = await checkout(admin, input)
    await expect(checkout(admin, input)).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      details: { reason: 'intent_already_used' },
    })

    expect(await prisma.sale.count()).toBe(1)
    expect((await getSale(admin, first.id)).status).toBe('COMPLETED')
    // The charge belongs to the first sale — the loser must NOT have refunded it.
    expect(fake.refunds).toHaveLength(0)
  })

  it('refunds the charge when the sale itself fails (oversell rollback)', async () => {
    const { variant } = await eachProduct({ stock: 1 })
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      cashCents: 0,
    })
    fake.succeed(staged.paymentIntentId)

    // Stock vanishes between staging and completing.
    await prisma.stockLevel.update({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
      data: { quantityBase: 0 },
    })

    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CARD', paymentIntentId: staged.paymentIntentId }],
      }),
    ).rejects.toThrow(InsufficientStockError)

    expect(await prisma.sale.count()).toBe(0)
    expect(fake.refunds).toEqual([
      expect.objectContaining({ paymentIntentId: staged.paymentIntentId, amountCents: 10_40 }),
    ])
  })
})

describe('split tender', () => {
  it('takes exact cash beside the card — two payment rows, change zero', async () => {
    const { variant } = await eachProduct()
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      cashCents: 5_00,
    })
    fake.succeed(staged.paymentIntentId)

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      ageVerified: false,
      tenders: [
        { method: 'CASH', tenderedCents: 5_00 },
        { method: 'CARD', paymentIntentId: staged.paymentIntentId },
      ],
    })

    expect(receipt.payments).toHaveLength(2)
    expect(receipt.payments).toEqual(
      expect.arrayContaining([
        { method: 'CARD', amountCents: 15_80, cardBrand: 'visa', cardLast4: '4242' },
        { method: 'CASH', amountCents: 5_00, cashTenderedCents: 5_00, cashChangeCents: 0 },
      ]),
    )
  })

  it('refuses cash that disagrees with the staged split, and reverses the charge', async () => {
    const { variant } = await eachProduct()
    const staged = await createSaleIntent(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      cashCents: 5_00,
    })
    fake.succeed(staged.paymentIntentId)

    // $6.00 keyed instead of the staged $5.00 — cash in a split gives no change.
    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 2 }],
        ageVerified: false,
        tenders: [
          { method: 'CASH', tenderedCents: 6_00 },
          { method: 'CARD', paymentIntentId: staged.paymentIntentId },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'amount_mismatch' } })

    expect(await prisma.sale.count()).toBe(0)
    expect(fake.refunds).toHaveLength(1)
  })
})

describe('a $0 sale', () => {
  it('completes with no payment rows at all', async () => {
    const { variant } = await eachProduct()

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      orderDiscount: { discountType: DiscountType.PERCENT_OFF, value: 10000 }, // 100%
      ageVerified: false,
      tenders: [],
    })

    expect(receipt.totalCents).toBe(0)
    expect(receipt.payments).toEqual([])
    expect(await prisma.payment.count({ where: { saleId: receipt.id } })).toBe(0)
  })

  it('refuses a tender when nothing is due', async () => {
    const { variant } = await eachProduct()
    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        orderDiscount: { discountType: DiscountType.PERCENT_OFF, value: 10000 },
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 5_00 }],
      }),
    ).rejects.toThrow(ConflictError)
  })
})

describe('cost visibility', () => {
  it('strips cost from a staff card receipt, in both directions', async () => {
    const { variant } = await eachProduct({ costBasisCents: 40_00 })
    const staged = await createSaleIntent(staff, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      cashCents: 0,
    })
    fake.succeed(staged.paymentIntentId)

    const staffReceipt = await checkout(staff, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CARD', paymentIntentId: staged.paymentIntentId }],
    })
    expect(findCostKeys(staffReceipt)).toEqual([])

    // Not vacuous: the same sale read as admin DOES carry the cost snapshot.
    const adminReceipt = await getSale(admin, staffReceipt.id)
    expect(findCostKeys(adminReceipt).length).toBeGreaterThan(0)
  })
})

describe('the webhook', () => {
  const app = createApp()

  function deliver(event: { id: string, type: string, payload: unknown }, signature = 'test-signature') {
    return request(app)
      .post('/api/stripe/webhook')
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(JSON.stringify(event))
  }

  it('records an event once and answers a retry without re-applying', async () => {
    const first = await deliver({ id: 'evt_1', type: 'payment_intent.succeeded', payload: { id: 'pi_x' } })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ received: true })

    const retry = await deliver({ id: 'evt_1', type: 'payment_intent.succeeded', payload: { id: 'pi_x' } })
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual({ received: true, duplicate: true })

    expect(await prisma.stripeEvent.count()).toBe(1)
  })

  it('rejects a bad signature and records nothing', async () => {
    const res = await deliver({ id: 'evt_2', type: 'refund.updated', payload: {} }, 'wrong')
    expect(res.status).toBe(400)
    expect(await prisma.stripeEvent.count()).toBe(0)
  })
})

describe('payments config', () => {
  it('reports Stripe as unconfigured when no publishable key is set', async () => {
    const res = await request(createApp()).get('/api/payments/config')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ publishableKey: null })
  })
})
