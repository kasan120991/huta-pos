import { MovementType, Role, WEIGHT } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import {
  createReceipt,
  getReceipt,
  listReceipts,
  quickCreateProduct,
  setLineCosts,
} from '../../src/receiving/receiving.service.js'
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
 * Receiving — the one path that creates stock from nothing, and so the primary
 * inventory-fraud and data-error vector.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let adminId: string
let staffId: string
let supplierId: string
let eachVariantId: string
let weightVariantId: string
let categoryId: string

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

  const supplier = await makeSupplier('Binoid CBD', { slug: 'binoid-cbd' })
  supplierId = supplier.id

  const edible = await makeCategory('Edible', 'edible')
  categoryId = edible.id
  const product = await makeProduct({ name: 'Gummies', categoryId: edible.id, priceCents: 4000 })
  eachVariantId = product.variants[0]!.id

  const flower = await makeCategory('Flower', 'flower')
  const group = await makePriceGroup('Flower', 'flower', 1000)
  const strain = await makeWeightProduct({
    name: 'Blue Dream',
    categoryId: flower.id,
    priceGroupId: group.id,
  })
  weightVariantId = strain.variants[0]!.id
})

describe('createReceipt', () => {
  it('posts stock and writes one RECEIVE movement per line, in one transaction', async () => {
    const receipt = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      supplierId,
      invoiceNumber: 'INV-4471',
      lines: [
        { variantId: eachVariantId, quantityBase: 24, unitCostCents: 250 },
        { variantId: weightVariantId, quantityBase: WEIGHT.OUNCE, unitCostCents: 400 },
      ],
    })

    expect(receipt.lines).toHaveLength(2)
    expect(receipt.supplierName).toBe('Binoid CBD')

    const movements = await prisma.inventoryMovement.findMany({
      where: { receiptId: receipt.id },
      select: { type: true, quantityBase: true },
    })
    expect(movements).toHaveLength(2)
    expect(movements.every((m) => m.type === MovementType.RECEIVE)).toBe(true)

    const levels = await prisma.stockLevel.findMany({
      where: { storeId: storeA.id },
      select: { variantId: true, quantityBase: true, costBasisCents: true },
    })
    expect(levels.find((l) => l.variantId === eachVariantId)).toMatchObject({
      quantityBase: 24,
      costBasisCents: 6000,
    })
    expect(levels.find((l) => l.variantId === weightVariantId)).toMatchObject({
      quantityBase: WEIGHT.OUNCE,
      costBasisCents: 11_200,
    })
  })

  it('rolls back EVERY line and the receipt when one line fails', async () => {
    await expect(
      createReceipt(admin, {
        storeId: storeA.id,
        userId: adminId,
        lines: [
          { variantId: eachVariantId, quantityBase: 24, unitCostCents: 250 },
          // A variant that does not exist. The pre-flight check catches this one, so use a
          // real-looking id to be sure the transaction itself is what protects us.
          { variantId: weightVariantId, quantityBase: WEIGHT.OUNCE, unitCostCents: 400 },
          { variantId: 'cjld2cyuq0000t3rmniod1foy', quantityBase: 5 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Nothing posted. Without applyMovement's tx parameter the first two lines would each
    // have committed their own transaction and survived the failure of the third.
    expect(await prisma.receipt.count()).toBe(0)
    expect(await prisma.receiptLine.count()).toBe(0)
    expect(await prisma.inventoryMovement.count()).toBe(0)
    expect(await prisma.stockLevel.count()).toBe(0)
  })

  it('refuses a delivery with no lines', async () => {
    await expect(
      createReceipt(admin, { storeId: storeA.id, userId: adminId, lines: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a zero-quantity line with a usable message, not a constraint error', async () => {
    await expect(
      createReceipt(admin, {
        storeId: storeA.id,
        userId: adminId,
        lines: [{ variantId: eachVariantId, quantityBase: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses an inactive supplier', async () => {
    const retired = await makeSupplier('Retired Co', { slug: 'retired-co', active: false })

    await expect(
      createReceipt(admin, {
        storeId: storeA.id,
        userId: adminId,
        supplierId: retired.id,
        lines: [{ variantId: eachVariantId, quantityBase: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('accepts a standalone delivery with no supplier — samples and walk-in reps', async () => {
    const receipt = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 3 }],
    })

    expect(receipt.supplierId).toBeNull()
    expect(receipt.hasVariance).toBe(false)
  })

  it('updates the variant last cost so it keeps meaning what it says', async () => {
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 10, unitCostCents: 275 }],
    })

    const variant = await prisma.productVariant.findUnique({
      where: { id: eachVariantId },
      select: { costCents: true },
    })
    expect(variant?.costCents).toBe(275)
  })

  it('writes the audit row inside the transaction', async () => {
    const receipt = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 4, unitCostCents: 100 }],
    })

    const log = await prisma.auditLog.findFirst({
      where: { action: 'inventory.receive', entityId: receipt.id },
    })
    expect(log).not.toBeNull()
    expect(log?.userId).toBe(adminId)
  })
})

describe('staff receiving', () => {
  it('posts stock but leaves it uncosted', async () => {
    await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      lines: [{ variantId: eachVariantId, quantityBase: 18 }],
    })

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: eachVariantId } },
      select: { quantityBase: true, costBasisCents: true },
    })
    expect(level).toMatchObject({ quantityBase: 18, costBasisCents: null })
  })

  it('REFUSES a cost from staff rather than silently dropping it', async () => {
    // Refused, not ignored: a terminal that believes it recorded a cost and did not is a
    // worse failure than being told no.
    await expect(
      createReceipt(staff, {
        storeId: storeA.id,
        userId: staffId,
        lines: [{ variantId: eachVariantId, quantityBase: 18, unitCostCents: 250 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(await prisma.receipt.count()).toBe(0)
  })
})

describe('cost visibility', () => {
  beforeEach(async () => {
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      supplierId,
      lines: [
        { variantId: eachVariantId, quantityBase: 24, unitCostCents: 250 },
        { variantId: weightVariantId, quantityBase: WEIGHT.OUNCE, unitCostCents: 400 },
      ],
    })
  })

  it('never sends a cost field to a staff principal, anywhere in the payload', async () => {
    const staffView = await listReceipts(staff, { storeId: storeA.id })
    expect(findCostKeys(staffView)).toEqual([])

    const [first] = staffView
    expect(findCostKeys(await getReceipt(staff, first!.id))).toEqual([])
  })

  it('does send cost to an admin, so the test above is proving something', async () => {
    const adminView = await listReceipts(admin, { storeId: storeA.id })
    expect(findCostKeys(adminView).length).toBeGreaterThan(0)
    expect(adminView[0]?.lines[0]?.unitCostCents).toBe(250)
    // 24 x $2.50 plus 28g x $4.00.
    expect(adminView[0]?.totalCostCents).toBe(6000 + 11_200)
  })
})

describe('setLineCosts', () => {
  it('costs a staff-received delivery and moves the basis', async () => {
    const receipt = await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      lines: [{ variantId: eachVariantId, quantityBase: 20 }],
    })

    expect(receipt.lines[0]).not.toHaveProperty('unitCostCents')

    const costed = await setLineCosts(
      admin,
      receipt.id,
      [{ lineId: receipt.lines[0]!.id, unitCostCents: 300 }],
      adminId,
    )

    expect(costed.lines[0]?.unitCostCents).toBe(300)
    expect(costed.uncostedLineCount).toBe(0)

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: eachVariantId } },
      select: { costBasisCents: true },
    })
    expect(level?.costBasisCents).toBe(6000)
  })

  it('applies only the DIFFERENCE when a cost is corrected', async () => {
    const receipt = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 20, unitCostCents: 300 }],
    })

    await setLineCosts(
      admin,
      receipt.id,
      [{ lineId: receipt.lines[0]!.id, unitCostCents: 350 }],
      adminId,
    )

    // 7000, not 6000 + 7000. Re-costing corrects the line rather than receiving it twice.
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: eachVariantId } },
      select: { costBasisCents: true },
    })
    expect(level?.costBasisCents).toBe(7000)
  })

  it('lands the value on what remains when some stock already sold', async () => {
    const receipt = await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      lines: [{ variantId: eachVariantId, quantityBase: 20 }],
    })

    await prisma.stockLevel.update({
      where: { storeId_variantId: { storeId: storeA.id, variantId: eachVariantId } },
      data: { quantityBase: 12 },
    })

    await setLineCosts(
      admin,
      receipt.id,
      [{ lineId: receipt.lines[0]!.id, unitCostCents: 300 }],
      adminId,
    )

    // The full delivery value attaches to the 12 units left, so the average reads high.
    // Documented and accepted: restating the COGS of the 8 that already sold would rewrite
    // figures a sales receipt has already reported.
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: eachVariantId } },
      select: { costBasisCents: true },
    })
    expect(level?.costBasisCents).toBe(6000)
  })

  it('refuses a staff principal', async () => {
    const receipt = await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      lines: [{ variantId: eachVariantId, quantityBase: 20 }],
    })

    await expect(
      setLineCosts(staff, receipt.id, [{ lineId: receipt.lines[0]!.id, unitCostCents: 300 }], staffId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses a line that belongs to another receipt', async () => {
    const one = await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 5 }],
    })
    const two = await createReceipt(admin, {
      storeId: storeB.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 5 }],
    })

    await expect(
      setLineCosts(admin, one.id, [{ lineId: two.lines[0]!.id, unitCostCents: 300 }], adminId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listReceipts', () => {
  it('finds deliveries with an uncosted line for the admin queue', async () => {
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 5, unitCostCents: 100 }],
    })
    const uncosted = await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      lines: [{ variantId: eachVariantId, quantityBase: 5 }],
    })

    const queue = await listReceipts(admin, { uncostedOnly: true })
    expect(queue.map((r) => r.id)).toEqual([uncosted.id])
  })

  it('scopes to one store when asked', async () => {
    await createReceipt(admin, {
      storeId: storeA.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 5 }],
    })
    await createReceipt(admin, {
      storeId: storeB.id,
      userId: adminId,
      lines: [{ variantId: eachVariantId, quantityBase: 5 }],
    })

    expect(await listReceipts(admin, { storeId: storeA.id })).toHaveLength(1)
    expect(await listReceipts(admin, {})).toHaveLength(2)
  })
})

describe('quickCreateProduct', () => {
  it('creates an INACTIVE, unpriced variant staff can receive against', async () => {
    const created = await quickCreateProduct({
      name: 'Mystery Rep Gummies',
      categoryId,
      sku: 'DOCK-001',
    })

    expect(created.needsAdminReview).toBe(true)

    const variant = await prisma.productVariant.findUnique({
      where: { id: created.variantId },
      select: { active: true, priceCents: true, trackingMode: true, product: { select: { active: true } } },
    })
    // Unsellable and invisible until an admin prices it. This is the only shape that lets
    // staff add a product without handing them pricing.
    expect(variant).toMatchObject({ active: false, priceCents: 0, trackingMode: 'EACH' })
    expect(variant?.product.active).toBe(false)

    // …and stock posts against it right away, which is the point.
    const receipt = await createReceipt(staff, {
      storeId: storeA.id,
      userId: staffId,
      lines: [{ variantId: created.variantId, quantityBase: 6 }],
    })
    expect(receipt.lines).toHaveLength(1)
  })

  it('refuses a duplicate SKU', async () => {
    await quickCreateProduct({ name: 'One', categoryId, sku: 'DOCK-002' })
    await expect(
      quickCreateProduct({ name: 'Two', categoryId, sku: 'DOCK-002' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('disambiguates a slug when two products share a name', async () => {
    const first = await quickCreateProduct({ name: 'House Blend', categoryId, sku: 'DOCK-003' })
    const second = await quickCreateProduct({ name: 'House Blend', categoryId, sku: 'DOCK-004' })

    const slugs = await prisma.product.findMany({
      where: { id: { in: [first.productId, second.productId] } },
      select: { slug: true },
    })
    expect(new Set(slugs.map((s) => s.slug)).size).toBe(2)
  })

  it('refuses an unknown category', async () => {
    await expect(
      quickCreateProduct({
        name: 'Nowhere',
        categoryId: 'cjld2cyuq0000t3rmniod1foy',
        sku: 'DOCK-005',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
