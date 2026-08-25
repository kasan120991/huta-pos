import { PurchaseOrderStatus, Role, WEIGHT } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import {
  cancelOrder,
  closeShort,
  createOrder,
  deleteCancelledDraft,
  getOrder,
  listOrders,
  placeOrder,
  updateDraft,
} from '../../src/purchasing/purchase-order.service.js'
import { createReceipt, openOrdersForReceiving } from '../../src/receiving/receiving.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  makeAdmin,
  makeCategory,
  makePriceGroup,
  makeProduct,
  makeStaff,
  makeStore,
  makeSupplier,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Purchase orders — the internal order log that makes lead time measurable.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let adminId: string
let supplierId: string
let eachVariantId: string
let weightVariantId: string

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')

  const adminUser = await makeAdmin()
  adminId = adminUser.id
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: null }

  const staffUser = await makeStaff(storeA.id, '4321')
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: 't-1',
  }

  supplierId = (await makeSupplier('Binoid CBD', { slug: 'binoid-cbd' })).id

  const edible = await makeCategory('Edible', 'edible')
  eachVariantId = (
    await makeProduct({ name: 'Gummies', categoryId: edible.id, priceCents: 4000 })
  ).variants[0]!.id

  const flower = await makeCategory('Flower', 'flower')
  const group = await makePriceGroup('Flower', 'flower', 1000)
  weightVariantId = (
    await makeWeightProduct({ name: 'Blue Dream', categoryId: flower.id, priceGroupId: group.id })
  ).variants[0]!.id
})

async function draft(storeId = storeA.id, lines?: Array<{ variantId: string; quantityBase: number; unitCostCents?: number }>) {
  return createOrder(admin, {
    storeId,
    userId: adminId,
    supplierId,
    lines: lines ?? [{ variantId: eachVariantId, quantityBase: 20, unitCostCents: 250 }],
  })
}

describe('order numbers', () => {
  it('allocates nothing until the order is placed', async () => {
    const order = await draft()
    expect(order.number).toBeNull()
    expect(order.reference).toBe('Draft')
    expect(order.status).toBe(PurchaseOrderStatus.DRAFT)
  })

  it('numbers sequentially from one, per store', async () => {
    const first = await placeOrder(admin, (await draft()).id, adminId)
    const second = await placeOrder(admin, (await draft()).id, adminId)
    expect([first.reference, second.reference]).toEqual(['PO-0001', 'PO-0002'])

    // The other store counts from one as well. A shared sequence would make Ashley's first
    // order PO-0038 and tell its manager nothing.
    const other = await placeOrder(admin, (await draft(storeB.id)).id, adminId)
    expect(other.reference).toBe('PO-0001')
  })

  it('never issues the same number twice under concurrent placement', async () => {
    const drafts = await Promise.all([draft(), draft(), draft(), draft(), draft()])

    // The whole reason the counter is read with SELECT … FOR UPDATE. Without the lock these
    // all read the same value and the unique index rejects four of them.
    const placed = await Promise.all(drafts.map((d) => placeOrder(admin, d.id, adminId)))

    const numbers = placed.map((p) => p.number).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(numbers).toEqual([1, 2, 3, 4, 5])
  })
})

describe('draft editing', () => {
  it('replaces lines on a draft', async () => {
    const order = await draft()
    const updated = await updateDraft(admin, order.id, {
      lines: [{ variantId: weightVariantId, quantityBase: WEIGHT.POUND, unitCostCents: 400 }],
    })

    expect(updated.lines).toHaveLength(1)
    expect(updated.lines[0]?.quantityBase).toBe(WEIGHT.POUND)
  })

  it('refuses to edit a placed order', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)

    // The lines ARE the record of what was asked for. Editing them after placement would
    // make every variance agree with whatever turned up.
    await expect(
      updateDraft(admin, order.id, { lines: [{ variantId: eachVariantId, quantityBase: 5 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses the same product twice on one order', async () => {
    await expect(
      draft(storeA.id, [
        { variantId: eachVariantId, quantityBase: 5 },
        { variantId: eachVariantId, quantityBase: 3 },
      ]),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a zero quantity and an unknown variant', async () => {
    await expect(
      draft(storeA.id, [{ variantId: eachVariantId, quantityBase: 0 }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await expect(
      draft(storeA.id, [{ variantId: 'cjld2cyuq0000t3rmniod1foy', quantityBase: 5 }]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses an inactive supplier', async () => {
    const retired = await makeSupplier('Retired Co', { slug: 'retired-co', active: false })
    await expect(
      createOrder(admin, {
        storeId: storeA.id,
        userId: adminId,
        supplierId: retired.id,
        lines: [{ variantId: eachVariantId, quantityBase: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('received against ordered', () => {
  it('derives received from receipts rather than storing it', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)

    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 8 }],
    })
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 7 }],
    })

    const after = await getOrder(admin, order.id)
    expect(after.lines[0]).toMatchObject({
      quantityBase: 20,
      receivedBase: 15,
      varianceBase: -5,
    })
    expect(after.receiptCount).toBe(2)
  })
})

describe('lifecycle', () => {
  it('cancels an open order', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)
    const cancelled = await cancelOrder(admin, order.id)

    expect(cancelled.status).toBe(PurchaseOrderStatus.CANCELLED)
    expect(cancelled.cancelledAt).not.toBeNull()
    expect(cancelled.outstanding).toBe(false)
  })

  it('cancels an unplaced DRAFT without demanding the number it never had', async () => {
    // Found live 2026-08-19: the status/timestamps CHECK required a number for anything
    // past DRAFT, so discarding a draft 500'd. Numbering happens at place time exactly
    // so an abandoned draft never burns one — a cancelled draft keeps number null.
    const order = await draft()
    const cancelled = await cancelOrder(admin, order.id)

    expect(cancelled.status).toBe(PurchaseOrderStatus.CANCELLED)
    expect(cancelled.number).toBeNull()
    expect(cancelled.reference).toBe('Draft')
    expect(cancelled.cancelledAt).not.toBeNull()
  })

  it('deletes a draft outright, lines and all', async () => {
    const order = await draft()
    await deleteCancelledDraft(admin, order.id)

    expect(await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).toBeNull()
    // The cascade is the database's, not ours — assert it actually fired.
    expect(await prisma.purchaseOrderLine.count({ where: { purchaseOrderId: order.id } })).toBe(0)
  })

  it('deletes a draft that was already cancelled', async () => {
    const order = await draft()
    await cancelOrder(admin, order.id)
    await deleteCancelledDraft(admin, order.id)

    expect(await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).toBeNull()
  })

  it('REFUSES to delete a cancelled order that was placed, so the number sequence keeps no gaps', async () => {
    // The guard that matters: a placed order burned a per-store number, and that sequence is
    // something a person reconciles against. Cancelling does not hand back the number.
    const order = await placeOrder(admin, (await draft()).id, adminId)
    await cancelOrder(admin, order.id)

    await expect(deleteCancelledDraft(admin, order.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).not.toBeNull()
  })

  it('refuses to delete a placed order that is still open', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)
    await expect(deleteCancelledDraft(admin, order.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('writes the deleted draft into the audit log, since the row itself is gone', async () => {
    const order = await draft()
    await deleteCancelledDraft(admin, order.id)

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'PurchaseOrder', entityId: order.id, action: 'purchaseOrder.delete' },
    })
    expect(entry).not.toBeNull()
    // The log is the ONLY evidence it existed, so it has to carry the lines.
    expect((entry?.before as { lines?: unknown[] }).lines).toHaveLength(order.lines.length)
  })

  it('refuses to cancel a closed order', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)
    await cancelOrder(admin, order.id)
    await expect(cancelOrder(admin, order.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses to place the same order twice', async () => {
    const order = await draft()
    await placeOrder(admin, order.id, adminId)
    await expect(placeOrder(admin, order.id, adminId)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('closes a short order and flags the shortfall', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 8 }],
    })

    const closed = await closeShort(admin, order.id)
    expect(closed.status).toBe(PurchaseOrderStatus.RECEIVED)
    expect(closed.fullyReceivedAt).not.toBeNull()

    // The flag lands on the order's most recent receipt, which is what an admin opens.
    const flagged = await prisma.receipt.findMany({ where: { hasVariance: true } })
    expect(flagged).toHaveLength(1)
  })

  it('refuses to close an order that is not short', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 20 }],
    })
    // Fully received, so it is already RECEIVED rather than PARTIALLY_RECEIVED.
    await expect(closeShort(admin, order.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('lead time', () => {
  it('tracks first delivery and full fulfillment separately', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)

    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 8 }],
    })

    const partial = await getOrder(admin, order.id)
    expect(partial.status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED)
    expect(partial.firstReceiptAt).not.toBeNull()
    // A partial that finishes three weeks later is not a two-day lead time, so this stays
    // null until the order is actually complete.
    expect(partial.fullyReceivedAt).toBeNull()
    expect(partial.outstanding).toBe(true)

    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 12 }],
    })

    const complete = await getOrder(admin, order.id)
    expect(complete.status).toBe(PurchaseOrderStatus.RECEIVED)
    expect(complete.fullyReceivedAt).not.toBeNull()
    expect(complete.outstanding).toBe(false)
  })

  it('does not move firstReceiptAt on a later delivery', async () => {
    const order = await placeOrder(admin, (await draft()).id, adminId)
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 4 }],
    })
    const first = (await getOrder(admin, order.id)).firstReceiptAt

    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: order.id,
      lines: [{ variantId: eachVariantId, quantityBase: 4 }],
    })

    expect((await getOrder(admin, order.id)).firstReceiptAt).toBe(first)
  })

  it('counts a placed, unreceived order as outstanding', async () => {
    await placeOrder(admin, (await draft()).id, adminId)
    await draft() // a draft is NOT outstanding — nothing has been asked for yet

    const outstanding = await listOrders(admin, { outstandingOnly: true })
    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]?.outstanding).toBe(true)
  })
})

describe('cost visibility', () => {
  it('carries cost for an admin', async () => {
    const order = await draft(storeA.id, [
      { variantId: weightVariantId, quantityBase: WEIGHT.POUND, unitCostCents: 400 },
    ])

    expect(findCostKeys(order).length).toBeGreaterThan(0)
    expect(order.lines[0]?.unitCostCents).toBe(400)
    // A pound at $4/g is $1,792 — not $1.79m. The per-gram conversion, again.
    expect(order.totalCostCents).toBe(179_200)
  })

  it('omits cost entirely for a principal without cost.view', async () => {
    const order = await draft(storeA.id, [
      { variantId: eachVariantId, quantityBase: 20, unitCostCents: 250 },
    ])

    // Staff cannot reach these routes at all, but the service must not leak if one ever does.
    const asStaff = await getOrder(staff, order.id)
    expect(findCostKeys(asStaff)).toEqual([])
  })
})

describe('open orders for receiving', () => {
  it('lists placed orders with outstanding math, and never a cost key', async () => {
    const placed = await placeOrder(admin, (await draft()).id, adminId)
    // A partial delivery: 8 of the 20 ordered.
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: placed.id,
      lines: [{ variantId: eachVariantId, quantityBase: 8 }],
    })

    const open = await openOrdersForReceiving(storeA.id)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ reference: 'PO-0001', status: 'PARTIALLY_RECEIVED' })
    expect(open[0]!.lines[0]).toMatchObject({
      orderedBase: 20,
      receivedBase: 8,
      outstandingBase: 12,
    })

    // The chooser is a register payload — cost-free BY CONSTRUCTION, even for an admin.
    // There is no positive control here on purpose: the endpoint never carries cost for
    // anyone, unlike the optional-key payloads findCostKeys usually guards both ways.
    expect(findCostKeys(open)).toEqual([])
  })

  it('offers neither drafts nor closed orders, and scopes to the store', async () => {
    await draft() // never placed — stays DRAFT
    const cancelled = await placeOrder(admin, (await draft()).id, adminId)
    await cancelOrder(admin, cancelled.id)
    const otherStore = await placeOrder(admin, (await draft(storeB.id)).id, adminId)

    const openA = await openOrdersForReceiving(storeA.id)
    expect(openA).toHaveLength(0)

    const openB = await openOrdersForReceiving(storeB.id)
    expect(openB.map((o) => o.id)).toEqual([otherStore.id])
  })

  it('drops a fully received order from the chooser', async () => {
    const placed = await placeOrder(admin, (await draft()).id, adminId)
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      purchaseOrderId: placed.id,
      lines: [{ variantId: eachVariantId, quantityBase: 20 }],
    })

    expect(await openOrdersForReceiving(storeA.id)).toHaveLength(0)
  })
})
