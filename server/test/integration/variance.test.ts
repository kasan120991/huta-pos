import { PurchaseOrderStatus, Role } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { closeShort, createOrder, placeOrder } from '../../src/purchasing/purchase-order.service.js'
import {
  createReceipt,
  listReceipts,
  reviewReceipt,
  varianceForReceipt,
} from '../../src/receiving/receiving.service.js'
import {
  makeAdmin,
  makeCategory,
  makeProduct,
  makeStaff,
  makeStore,
  makeSupplier,
  resetDatabase,
} from '../setup/factories.js'

/**
 * The variance rule.
 *
 * This is the test that decides whether the review queue is worth opening. A literal "any
 * mismatch flags" reading would fire on every normal split delivery and fill the queue with
 * entries an admin dismisses without reading; the rule is therefore CUMULATIVE, and a
 * shortfall is not a fact until someone declares the order finished.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let adminId: string
let staffId: string
let supplierId: string
let orderedVariantId: string
let otherVariantId: string

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')

  const adminUser = await makeAdmin()
  adminId = adminUser.id
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: null }

  const staffUser = await makeStaff(storeA.id, '4321')
  staffId = staffUser.id
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: 't-1',
  }

  supplierId = (await makeSupplier('Binoid CBD', { slug: 'binoid-cbd' })).id

  const edible = await makeCategory('Edible', 'edible')
  orderedVariantId = (
    await makeProduct({ name: 'Gummies', categoryId: edible.id, priceCents: 4000 })
  ).variants[0]!.id
  otherVariantId = (
    await makeProduct({ name: 'Mints', categoryId: edible.id, priceCents: 2000 })
  ).variants[0]!.id
})

/** An order for 20 of one item, placed and ready to receive against. */
async function placedOrder(storeId = storeA.id) {
  const drafted = await createOrder(admin, {
    storeId,
    userId: adminId,
    supplierId,
    lines: [{ variantId: orderedVariantId, quantityBase: 20, unitCostCents: 250 }],
  })
  return placeOrder(admin, drafted.id, adminId)
}

async function receive(
  orderId: string,
  lines: Array<{ variantId: string; quantityBase: number }>,
) {
  return createReceipt(admin, {
    storeId: storeA.id,
    userId: adminId,
    purchaseOrderId: orderId,
    lines,
  })
}

describe('the variance rule', () => {
  it('does NOT flag a partial delivery', async () => {
    const order = await placedOrder()
    const receipt = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 8 }])

    // 8 of 20 is a split delivery, which is normal. Flagging it is what would make the queue
    // useless, so this is the assertion that matters most in this file.
    expect(receipt.hasVariance).toBe(false)
  })

  it('does NOT flag the delivery that completes the order', async () => {
    const order = await placedOrder()
    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 8 }])
    const second = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 12 }])

    // Judged cumulatively: 8 + 12 is exactly 20. A per-receipt rule would have called this
    // one short by 8 despite the order being perfectly satisfied.
    expect(second.hasVariance).toBe(false)
  })

  it('flags an over-delivery', async () => {
    const order = await placedOrder()
    const receipt = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 25 }])

    expect(receipt.hasVariance).toBe(true)
    const variance = await varianceForReceipt(receipt.id)
    expect(variance).toEqual([
      expect.objectContaining({ kind: 'OVER', differenceBase: 5, orderedBase: 20 }),
    ])
  })

  it('flags an over-delivery that only goes over CUMULATIVELY', async () => {
    const order = await placedOrder()
    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 18 }])
    const second = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 5 }])

    // 5 is well under 20 on its own; it is the running total of 23 that is over.
    expect(second.hasVariance).toBe(true)
  })

  it('flags an item that was never on the order', async () => {
    const order = await placedOrder()
    const receipt = await receive(order.id, [
      { variantId: orderedVariantId, quantityBase: 20 },
      { variantId: otherVariantId, quantityBase: 6 },
    ])

    expect(receipt.hasVariance).toBe(true)
    const variance = await varianceForReceipt(receipt.id)
    expect(variance).toContainEqual(
      expect.objectContaining({ kind: 'UNEXPECTED', orderedBase: null, receivedBase: 6 }),
    )
  })

  it('flags a shortfall exactly once, when the order is closed', async () => {
    const order = await placedOrder()
    const receipt = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 8 }])
    expect(receipt.hasVariance).toBe(false)

    await closeShort(admin, order.id)

    const after = await prisma.receipt.findUnique({ where: { id: receipt.id } })
    expect(after?.hasVariance).toBe(true)

    const variance = await varianceForReceipt(receipt.id)
    expect(variance).toEqual([
      expect.objectContaining({ kind: 'SHORT', differenceBase: -12, orderedBase: 20 }),
    ])
  })

  it('posts the stock regardless — variances are flagged, not blocked', async () => {
    const order = await placedOrder()
    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 25 }])

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: orderedVariantId } },
    })
    expect(level?.quantityBase).toBe(25)
  })
})

describe('receiving against an order', () => {
  it('defaults an admin line cost from the order line', async () => {
    const order = await placedOrder()
    const receipt = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 10 }])

    // No cost was typed on the delivery; it inherits the $2.50 from the order.
    expect(receipt.lines[0]?.unitCostCents).toBe(250)

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: orderedVariantId } },
      select: { costBasisCents: true },
    })
    expect(level?.costBasisCents).toBe(2500)
  })

  it('lets an explicit cost beat the order cost', async () => {
    const order = await placedOrder()
    const receipt = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: orderedVariantId, quantityBase: 10, unitCostCents: 300 }],
    })
    expect(receipt.lines[0]?.unitCostCents).toBe(300)
  })

  it('leaves a staff delivery uncosted even against a costed order', async () => {
    const order = await placedOrder()
    const receipt = await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      purchaseOrderId: order.id,
      lines: [{ variantId: orderedVariantId, quantityBase: 10 }],
    })

    // Staff cannot see cost, so they must not receive a payload carrying it — inheriting the
    // order's cost silently would put it on the wire for a principal that may not have it.
    expect(receipt.lines[0]).not.toHaveProperty('unitCostCents')

    const line = await prisma.receiptLine.findFirst({ where: { receiptId: receipt.id } })
    expect(line?.unitCostCents).toBeNull()
  })

  it('refuses an order raised for another store', async () => {
    const order = await placedOrder(storeB.id)
    await expect(
      receive(order.id, [{ variantId: orderedVariantId, quantityBase: 5 }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a draft order and a closed one', async () => {
    const drafted = await createOrder(admin, {
      storeId: storeA.id,
      userId: adminId,
      supplierId,
      lines: [{ variantId: orderedVariantId, quantityBase: 20 }],
    })
    await expect(
      receive(drafted.id, [{ variantId: orderedVariantId, quantityBase: 5 }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const order = await placedOrder()
    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 20 }])
    // Now RECEIVED.
    await expect(
      receive(order.id, [{ variantId: orderedVariantId, quantityBase: 1 }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('advances the order status as deliveries land', async () => {
    const order = await placedOrder()
    expect(order.status).toBe(PurchaseOrderStatus.ORDERED)

    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 8 }])
    expect((await prisma.purchaseOrder.findUnique({ where: { id: order.id } }))?.status).toBe(
      PurchaseOrderStatus.PARTIALLY_RECEIVED,
    )

    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 12 }])
    expect((await prisma.purchaseOrder.findUnique({ where: { id: order.id } }))?.status).toBe(
      PurchaseOrderStatus.RECEIVED,
    )
  })
})

describe('the review queue', () => {
  it('holds only flagged, unreviewed deliveries', async () => {
    const order = await placedOrder()
    await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 8 }]) // clean
    const flagged = await receive(order.id, [{ variantId: otherVariantId, quantityBase: 3 }])

    const queue = await listReceipts(admin, { needsReviewOnly: true })
    expect(queue.map((r) => r.id)).toEqual([flagged.id])
  })

  it('leaves the queue once reviewed, and records who signed it off', async () => {
    const order = await placedOrder()
    const flagged = await receive(order.id, [{ variantId: otherVariantId, quantityBase: 3 }])

    const reviewed = await reviewReceipt(admin, flagged.id, adminId)
    expect(reviewed.reviewedAt).not.toBeNull()
    expect(reviewed.reviewedByName).toBe('Test Admin')

    expect(await listReceipts(admin, { needsReviewOnly: true })).toHaveLength(0)
  })

  it('refuses to review twice, or to review a clean delivery', async () => {
    const order = await placedOrder()
    const flagged = await receive(order.id, [{ variantId: otherVariantId, quantityBase: 3 }])
    await reviewReceipt(admin, flagged.id, adminId)
    await expect(reviewReceipt(admin, flagged.id, adminId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    const clean = await receive(order.id, [{ variantId: orderedVariantId, quantityBase: 2 }])
    await expect(reviewReceipt(admin, clean.id, adminId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses a staff principal', async () => {
    const order = await placedOrder()
    const flagged = await receive(order.id, [{ variantId: otherVariantId, quantityBase: 3 }])
    await expect(reviewReceipt(staff, flagged.id, staffId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('returns no variance for a standalone delivery', async () => {
    const standalone = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: orderedVariantId, quantityBase: 5 }],
    })

    // Nothing to compare against, and the DB CHECK refuses hasVariance without an order.
    expect(standalone.hasVariance).toBe(false)
    expect(await varianceForReceipt(standalone.id)).toEqual([])
  })
})
