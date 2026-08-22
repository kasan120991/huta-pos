import { Role } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { NotFoundError } from '../../src/errors/index.js'
import {
  createSupplier,
  getSupplier,
  listSuppliers,
  supplierActivity,
  updateSupplier,
} from '../../src/suppliers/supplier.service.js'
import {
  makeAdmin,
  makeCategory,
  makeStaff,
  makeStore,
  makeSupplier,
  resetDatabase,
} from '../setup/factories.js'
import { prisma } from '../../src/db/client.js'
import { findCostKeys } from '../setup/cost-keys.js'

let admin: AdminPrincipal
let staff: StaffPrincipal
let supplierId: string
let storeId: string
let adminId: string

beforeEach(async () => {
  await resetDatabase()
  orderNumber = 0
  const store = await makeStore('Store A', 'store-a')
  storeId = store.id

  const adminUser = await makeAdmin()
  adminId = adminUser.id
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: null }

  const staffUser = await makeStaff(store.id, '4321')
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: store.id,
    terminalId: 't-1',
  }

  const supplier = await makeSupplier('Binoid CBD', { slug: 'binoid-cbd' })
  supplierId = supplier.id
})

/** The commercial terms the house rules keeps away from staff. */
const TERMS = ['accountNumber', 'paymentTerms', 'minimumOrderCents', 'notes'] as const

describe('commercial terms visibility', () => {
  it('gives staff contact details but no commercial terms', async () => {
    const [row] = await listSuppliers(staff)

    // Contact info IS the point — staff need a rep's number when a delivery is wrong.
    expect(row).toMatchObject({
      name: 'Binoid CBD',
      contactName: 'Dana Reyes',
      phone: '555-0142',
    })

    for (const field of TERMS) {
      expect(row).not.toHaveProperty(field)
    }

    const detail = await getSupplier(staff, supplierId)
    for (const field of TERMS) {
      expect(detail).not.toHaveProperty(field)
    }
  })

  it('gives an admin the terms, so the test above is proving something', async () => {
    const detail = await getSupplier(admin, supplierId)

    expect(detail).toMatchObject({
      accountNumber: 'ACCT-9001',
      paymentTerms: 'Net 30',
      minimumOrderCents: 50_000,
    })
    for (const field of TERMS) {
      expect(detail).toHaveProperty(field)
    }
  })
})

describe('listSuppliers', () => {
  it('hides inactive suppliers unless asked', async () => {
    await makeSupplier('Retired Co', { slug: 'retired-co', active: false })

    expect(await listSuppliers(admin)).toHaveLength(1)
    expect(await listSuppliers(admin, { includeInactive: true })).toHaveLength(2)
  })

  it('searches by name, case-insensitively', async () => {
    await makeSupplier('Torch Distribution', { slug: 'torch-distribution' })

    const hits = await listSuppliers(admin, { search: 'torch' })
    expect(hits.map((s) => s.name)).toEqual(['Torch Distribution'])
  })

  it('reports how many products name each supplier as primary', async () => {
    const category = await makeCategory('Edible', 'edible')
    await prisma.product.create({
      data: {
        name: 'Gummies',
        slug: 'gummies-supplier-count',
        categoryId: category.id,
        primarySupplierId: supplierId,
      },
    })

    const [row] = await listSuppliers(admin)
    expect(row?.productCount).toBe(1)
  })
})

describe('createSupplier', () => {
  it('derives a slug and returns the created row', async () => {
    const created = await createSupplier(admin, { name: 'Flying Monkey', paymentTerms: 'Net 15' })

    expect(created).toMatchObject({ name: 'Flying Monkey', slug: 'flying-monkey', active: true })
  })

  it('reports a slug collision as a conflict, not a raw Prisma error', async () => {
    await expect(createSupplier(admin, { name: 'Binoid  CBD' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses a blank name', async () => {
    await expect(createSupplier(admin, { name: '   ' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('normalises an empty string to null rather than storing ""', async () => {
    const created = await createSupplier(admin, { name: 'Sparse Co', phone: '  ' })
    expect(created.phone).toBeNull()
  })
})

describe('updateSupplier', () => {
  it('moves the slug with the name', async () => {
    const updated = await updateSupplier(admin, supplierId, { name: 'Binoid Wholesale' })
    expect(updated.slug).toBe('binoid-wholesale')
  })

  it('deactivates rather than deletes, keeping history answerable', async () => {
    const updated = await updateSupplier(admin, supplierId, { active: false })
    expect(updated.active).toBe(false)

    // Still there — purchase orders, receipts and sale lines all reference it.
    expect(await getSupplier(admin, supplierId)).toMatchObject({ id: supplierId })
  })

  it('leaves untouched fields alone', async () => {
    await updateSupplier(admin, supplierId, { phone: '555-9999' })
    const detail = await getSupplier(admin, supplierId)

    expect(detail).toMatchObject({ phone: '555-9999', paymentTerms: 'Net 30' })
  })

  it('refuses an unknown supplier', async () => {
    await expect(
      updateSupplier(admin, 'cjld2cyuq0000t3rmniod1foy', { name: 'Ghost' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// --- activity ----------------------------------------------------------------------------

const DAY = 86_400_000
const PLACED = new Date('2026-08-01T09:00:00.000Z')

/**
 * `PurchaseOrder_status_timestamps_check` demands a number for anything past DRAFT — the
 * order was placed, so it burned one — while exempting CANCELLED, which may have been
 * abandoned before placement.
 */
let orderNumber = 0

/**
 * A placed order, written directly. Driving the real create → place → receive flow would
 * pin the lead-time arithmetic to whatever "now" happens to be, and these tests are ABOUT
 * the arithmetic.
 */
async function order(spec: {
  status: 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED' | 'DRAFT'
  firstAfterDays?: number
  fullAfterDays?: number
}) {
  orderNumber += 1
  return prisma.purchaseOrder.create({
    data: {
      supplierId,
      storeId,
      orderedById: adminId,
      status: spec.status,
      ...(spec.status === 'DRAFT' ? {} : { number: orderNumber }),
      orderedAt: PLACED,
      ...(spec.firstAfterDays === undefined
        ? {}
        : { firstReceiptAt: new Date(PLACED.getTime() + spec.firstAfterDays * DAY) }),
      ...(spec.fullAfterDays === undefined
        ? {}
        : { fullyReceivedAt: new Date(PLACED.getTime() + spec.fullAfterDays * DAY) }),
      ...(spec.status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    },
  })
}

describe('supplierActivity', () => {
  it('averages lead time over received orders and counts outstanding separately', async () => {
    await order({ status: 'RECEIVED', firstAfterDays: 2, fullAfterDays: 2 })
    await order({ status: 'RECEIVED', firstAfterDays: 4, fullAfterDays: 6 })
    // Still owed. Folding this in as though it arrived today would make the slowest
    // supplier — the one still holding our stock — look the fastest.
    await order({ status: 'ORDERED' })

    const activity = await supplierActivity(supplierId)
    expect(activity.ordersPlaced).toBe(3)
    expect(activity.outstandingCount).toBe(1)
    expect(activity.avgDaysToFirstReceipt).toBe(3)
    expect(activity.firstReceiptSample).toBe(2)
    expect(activity.avgDaysToFullReceipt).toBe(4)
  })

  it('counts a part-received order as outstanding while still using its first delivery', async () => {
    await order({ status: 'PARTIALLY_RECEIVED', firstAfterDays: 1 })

    const activity = await supplierActivity(supplierId)
    expect(activity.outstandingCount).toBe(1)
    // It genuinely delivered once, so the first-receipt average knows about it...
    expect(activity.avgDaysToFirstReceipt).toBe(1)
    // ...but it has not finished, so it contributes nothing to time-to-complete.
    expect(activity.avgDaysToFullReceipt).toBeNull()
    expect(activity.fullReceiptSample).toBe(0)
  })

  it('excludes a cancelled order from the average, even one cancelled after a delivery', async () => {
    await order({ status: 'RECEIVED', firstAfterDays: 2, fullAfterDays: 2 })
    await order({ status: 'CANCELLED', firstAfterDays: 30 })

    const activity = await supplierActivity(supplierId)
    expect(activity.cancelledCount).toBe(1)
    expect(activity.outstandingCount).toBe(0)
    // The 30-day figure measures an order that never completed — it is not a lead time.
    expect(activity.avgDaysToFirstReceipt).toBe(2)
    expect(activity.firstReceiptSample).toBe(1)
  })

  it('ignores drafts entirely — a draft was never placed with anyone', async () => {
    await order({ status: 'DRAFT' })

    const activity = await supplierActivity(supplierId)
    expect(activity.ordersPlaced).toBe(0)
    expect(activity.outstandingCount).toBe(0)
  })

  it('reports null rather than zero when nothing has been ordered', async () => {
    const activity = await supplierActivity(supplierId)
    // "No orders yet" and "arrives instantly" must not render as the same number.
    expect(activity.avgDaysToFirstReceipt).toBeNull()
    expect(activity.firstReceiptSample).toBe(0)
    expect(activity.lastReceivedAt).toBeNull()
    expect(activity.receiptCount).toBe(0)
  })

  it('reports the most recent delivery date and the delivery count', async () => {
    await prisma.receipt.create({
      data: {
        storeId,
        supplierId,
        receivedById: adminId,
        receivedAt: new Date('2026-08-03T10:00:00.000Z'),
      },
    })
    await prisma.receipt.create({
      data: {
        storeId,
        supplierId,
        receivedById: adminId,
        receivedAt: new Date('2026-08-09T10:00:00.000Z'),
      },
    })

    const activity = await supplierActivity(supplierId)
    expect(activity.receiptCount).toBe(2)
    expect(activity.lastReceivedAt).toBe('2026-08-09T10:00:00.000Z')
  })

  it('404s for a supplier that does not exist', async () => {
    await expect(supplierActivity('cmsu3a2fk001ctdr8p8isddzj')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('carries no cost-shaped key — an operational figure is not a valuation', async () => {
    await order({ status: 'RECEIVED', firstAfterDays: 2, fullAfterDays: 2 })
    expect(findCostKeys(await supplierActivity(supplierId))).toEqual([])
  })
})
