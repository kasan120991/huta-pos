import { DiscountType, Role, TrackingMode } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import {
  AgeVerificationRequiredError,
  ConflictError,
  ForbiddenError,
  InsufficientStockError,
} from '../../src/errors/index.js'
import { checkout, getSale } from '../../src/sales/sales.service.js'
import { closeShift, openShift } from '../../src/sales/shift.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  giveStock,
  makeAdmin,
  makeCannabinoid,
  makeCategory,
  makePriceGroup,
  makeProduct,
  makePromotion,
  makeStaff,
  makeStore,
  makeSupplier,
  makeTerminal,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Checkout — the first writer of Sale/SaleLine, whose snapshot columns can never be
 * backfilled. These tests are the guarantee that they are right from the first sale.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let category: { id: string }
let adminUser: { id: string }

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a') // factory stores tax at 400 bps
  storeB = await makeStore('Store B', 'store-b')
  adminUser = await makeAdmin()
  const terminal = await makeTerminal(storeA.id, 'sales-test-device-token')
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: terminal.id }
  const staffUser = await makeStaff(storeA.id, '4321')
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: terminal.id,
  }
  category = await makeCategory('Edible', 'edible')
  await openShift(staff, storeA.id, { openingCashCents: 100_00 })
})

/** An EACH product at $10.00, stocked at Store A. */
async function eachProduct(opts: { stock?: number, costBasisCents?: number, priceCents?: number } = {}) {
  const product = await makeProduct({
    name: `Gummies-${Math.random().toString(36).slice(2, 8)}`,
    categoryId: category.id,
    priceCents: opts.priceCents ?? 10_00,
  })
  const variant = product.variants[0]!
  await giveStock(storeA.id, variant.id, opts.stock ?? 10, opts.costBasisCents)
  return { product, variant }
}

describe('a cash sale', () => {
  it('rings, numbers, pays, moves stock, and snapshots everything', async () => {
    const { variant } = await eachProduct({ stock: 10, costBasisCents: 50_00 })

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 2 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 25_00 }],
    })

    // $20.00 + 4% tax = $20.80.
    expect(receipt).toMatchObject({
      number: 1,
      storeId: storeA.id,
      subtotalCents: 20_00,
      discountCents: 0,
      taxCents: 80,
      totalCents: 20_80,
      taxRateBps: 400,
      status: 'COMPLETED',
    })
    expect(receipt.payments).toHaveLength(1)
    expect(receipt.payments[0]).toMatchObject({
      method: 'CASH',
      amountCents: 20_80,
      cashTenderedCents: 25_00,
      cashChangeCents: 4_20,
    })
    expect(receipt.lines[0]).toMatchObject({
      quantityBase: 2,
      unitPriceCents: 10_00,
      pricePerGramCents: null,
      grossCents: 20_00,
      netCents: 20_00,
      taxCents: 80,
      unitCostCents: 5_00, // admin sees the weighted-average snapshot: 5000/10 per item
    })

    const movement = await prisma.inventoryMovement.findFirst({ where: { saleId: receipt.id } })
    expect(movement).toMatchObject({ type: 'SALE', quantityBase: -2 })
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(8)
    // The basis was relieved proportionally: 2/10 of $50.00 left with the goods.
    expect(level!.costBasisCents).toBe(40_00)
  })

  it('keeps the receipt identical after prices, names, and promotions change', async () => {
    const { product, variant } = await eachProduct()
    await makePromotion({
      name: 'Launch 10%',
      scopeType: 'PRODUCT',
      discountType: 'PERCENT_OFF',
      value: 1000,
      productId: product.id,
    })

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 50_00 }],
    })
    expect(receipt.discountCents).toBe(1_00)

    // History rewrites, attempted.
    await prisma.productVariant.update({ where: { id: variant.id }, data: { priceCents: 99_99 } })
    await prisma.product.update({ where: { id: product.id }, data: { name: 'Renamed Entirely' } })
    await prisma.promotion.updateMany({ where: {}, data: { active: false, name: 'Gone' } })
    await prisma.store.update({ where: { id: storeA.id }, data: { taxRateBps: 900 } })

    const again = await getSale(admin, receipt.id)
    expect(again).toEqual(receipt)
  })

  it('snapshots the promotion LIST in application order', async () => {
    const { product, variant } = await eachProduct()
    await makePromotion({
      name: 'Stack A 10%',
      scopeType: 'PRODUCT',
      discountType: 'PERCENT_OFF',
      value: 1000,
      productId: product.id,
      stackable: true,
    })
    await makePromotion({
      name: 'Stack B $1',
      scopeType: 'CATEGORY',
      discountType: 'AMOUNT_OFF',
      value: 1_00,
      categoryId: category.id,
      stackable: true,
    })

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 50_00 }],
    })

    const rows = await prisma.saleLinePromotion.findMany({
      where: { saleLineId: receipt.lines[0]!.id },
      orderBy: { sequence: 'asc' },
    })
    expect(rows).toHaveLength(2)
    // Narrower scope applies first: product beats category.
    expect(rows[0]).toMatchObject({ sequence: 0, nameSnapshot: 'Stack A 10%', discountCents: 1_00 })
    expect(rows[1]).toMatchObject({ sequence: 1, nameSnapshot: 'Stack B $1', discountCents: 1_00 })
    expect(receipt.lines[0]!.promotions.map((p) => p.sequence)).toEqual([0, 1])
  })

  it('records the supplier the product had AT SALE TIME', async () => {
    const supplier = await makeSupplier('Original Supplier', { slug: 'original' })
    const { product, variant } = await eachProduct()
    await prisma.product.update({
      where: { id: product.id },
      data: { primarySupplierId: supplier.id },
    })

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })

    // Switching distributors later must not rewrite this sale's attribution.
    const other = await makeSupplier('New Supplier', { slug: 'new-supplier' })
    await prisma.product.update({ where: { id: product.id }, data: { primarySupplierId: other.id } })

    const line = await prisma.saleLine.findFirst({ where: { saleId: receipt.id } })
    expect(line!.supplierId).toBe(supplier.id)
  })
})

describe('tax', () => {
  it('allocates odd cents largest-remainder so lines sum exactly to the sale', async () => {
    const a = await eachProduct({ priceCents: 3_33 })
    const b = await eachProduct({ priceCents: 3_33 })
    const c = await eachProduct({ priceCents: 3_35 })

    const receipt = await checkout(admin, {
      lines: [
        { variantId: a.variant.id, quantityBase: 1 },
        { variantId: b.variant.id, quantityBase: 1 },
        { variantId: c.variant.id, quantityBase: 1 },
      ],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })

    // 10.01 at 4% = 40.04 → 40 cents, split across the three lines.
    expect(receipt.taxCents).toBe(40)
    expect(receipt.lines.reduce((sum, l) => sum + l.taxCents, 0)).toBe(receipt.taxCents)
    expect(receipt.totalCents).toBe(10_01 + 40)
  })

  it('exempts non-taxable lines from the base and gives them zero tax', async () => {
    const taxed = await eachProduct({ priceCents: 10_00 })
    const exempt = await eachProduct({ priceCents: 10_00 })
    await prisma.productVariant.update({
      where: { id: exempt.variant.id },
      data: { taxable: false },
    })

    const receipt = await checkout(admin, {
      lines: [
        { variantId: taxed.variant.id, quantityBase: 1 },
        { variantId: exempt.variant.id, quantityBase: 1 },
      ],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 25_00 }],
    })

    expect(receipt.taxCents).toBe(40) // 4% of the taxable $10 only
    const exemptLine = receipt.lines.find((l) => l.variantId === exempt.variant.id)
    expect(exemptLine!.taxCents).toBe(0)
  })

  it('handles a zero-rate store', async () => {
    await prisma.store.update({ where: { id: storeA.id }, data: { taxRateBps: 0 } })
    const { variant } = await eachProduct()
    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 10_00 }],
    })
    expect(receipt.taxCents).toBe(0)
    expect(receipt.totalCents).toBe(10_00)
  })
})

describe('age verification', () => {
  it('requires the attestation for a cannabinoid-bearing cart and records WHO verified', async () => {
    const d8 = await makeCannabinoid('Delta-8', 'delta-8')
    const product = await makeProduct({
      name: 'D8 Gummies',
      categoryId: category.id,
      cannabinoidIds: [d8.id],
    })
    const variant = product.variants[0]!
    await giveStock(storeA.id, variant.id, 5)

    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
      }),
    ).rejects.toThrow(AgeVerificationRequiredError)
    expect(await prisma.sale.count()).toBe(0)

    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: true,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })
    const sale = await prisma.sale.findUnique({ where: { id: receipt.id } })
    expect(sale).toMatchObject({ ageVerified: true, ageVerifiedById: adminUser.id })
  })

  it('needs nothing for a cart with no cannabinoid-bearing products', async () => {
    const { variant } = await eachProduct()
    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })
    expect(receipt.ageVerified).toBe(false)
  })
})

describe('stock', () => {
  it('gives the last unit to exactly one of two concurrent sales', async () => {
    const { variant } = await eachProduct({ stock: 1 })

    const results = await Promise.allSettled([
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
      }),
      checkout(staff, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
      }),
    ])

    const wins = results.filter((r) => r.status === 'fulfilled')
    expect(wins).toHaveLength(1)
    expect(await prisma.sale.count()).toBe(1)
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(0)
  })

  it('sells flower down to exactly zero, and by the partial gram', async () => {
    const flowerCategory = await makeCategory('Flower', 'flower')
    const group = await makePriceGroup('Flower', 'flower', 10_00)
    const product = await makeWeightProduct({
      name: 'Test Strain',
      categoryId: flowerCategory.id,
      priceGroupId: group.id,
    })
    const variant = product.variants[0]!
    await giveStock(storeA.id, variant.id, 7000)

    const partial = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 3530 }], // 3.53 g typed at the scale
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
    })
    expect(partial.lines[0]).toMatchObject({ quantityBase: 3530, unitPriceCents: null })
    expect(partial.lines[0]!.pricePerGramCents).not.toBeNull()

    const rest = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 3470 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
    })
    expect(rest.number).toBe(2)

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(0)
  })

  it('rolls the whole sale back when any line oversells', async () => {
    const ok = await eachProduct({ stock: 10 })
    const scarce = await eachProduct({ stock: 1 })

    await expect(
      checkout(admin, {
        lines: [
          { variantId: ok.variant.id, quantityBase: 1 },
          { variantId: scarce.variant.id, quantityBase: 5 },
        ],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 200_00 }],
      }),
    ).rejects.toThrow(InsufficientStockError)

    expect(await prisma.sale.count()).toBe(0)
    expect(await prisma.inventoryMovement.count({ where: { type: 'SALE' } })).toBe(0)
    const untouched = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: ok.variant.id } },
    })
    expect(untouched!.quantityBase).toBe(10)
  })

  it('enforces the variant sale bounds', async () => {
    const { variant } = await eachProduct({ stock: 50 })
    await prisma.productVariant.update({
      where: { id: variant.id },
      data: { minSaleBase: 2, maxSaleBase: 5 },
    })
    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
      }),
    ).rejects.toThrow(ConflictError)
    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 6 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
      }),
    ).rejects.toThrow(ConflictError)
  })
})

describe('cash', () => {
  it('refuses short tender without writing anything, and computes change exactly', async () => {
    const { variant } = await eachProduct()

    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 10_00 }], // total is 10.40 with tax
      }),
    ).rejects.toThrow(ConflictError)
    expect(await prisma.sale.count()).toBe(0)

    const exact = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 10_40 }],
    })
    expect(exact.payments[0]).toMatchObject({ method: 'CASH', cashChangeCents: 0 })

    const withChange = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })
    expect(withChange.payments[0]).toMatchObject({ method: 'CASH', cashChangeCents: 9_60 })
  })
})

describe('cost snapshots', () => {
  it('snapshots the per-gram weighted cost for WEIGHT, and null for uncosted stock', async () => {
    const flowerCategory = await makeCategory('Flower', 'flower')
    const group = await makePriceGroup('Flower', 'flower', 10_00)
    const costed = await makeWeightProduct({
      name: 'Costed Strain',
      categoryId: flowerCategory.id,
      priceGroupId: group.id,
    })
    await giveStock(storeA.id, costed.variants[0]!.id, 28_000, 112_00) // $4.00/g basis

    const uncosted = await eachProduct() // giveStock default: no basis

    const receipt = await checkout(admin, {
      lines: [
        { variantId: costed.variants[0]!.id, quantityBase: 3500 },
        { variantId: uncosted.variant.id, quantityBase: 1 },
      ],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
    })

    const weightLine = receipt.lines.find((l) => l.variantId === costed.variants[0]!.id)
    expect(weightLine!.unitCostCents).toBe(4_00) // per GRAM, not per milligram
    const uncostedLine = receipt.lines.find((l) => l.variantId === uncosted.variant.id)
    expect(uncostedLine!.unitCostCents).toBeNull() // unknown is null, NEVER zero
  })

  it('strips cost for staff in both directions', async () => {
    const { variant } = await eachProduct({ costBasisCents: 50_00 })

    const staffReceipt = await checkout(staff, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })
    expect(findCostKeys(staffReceipt)).toEqual([])

    // …and the SAME sale carries cost for an admin — the staff assertion is not vacuous.
    const adminView = await getSale(admin, staffReceipt.id)
    expect(adminView.lines[0]!.unitCostCents).toBe(5_00)
  })
})

describe('discounts', () => {
  it('applies a manual line percentage and an order amount, exactly', async () => {
    const a = await eachProduct({ priceCents: 20_00 })
    const b = await eachProduct({ priceCents: 10_00 })

    const receipt = await checkout(admin, {
      lines: [
        {
          variantId: a.variant.id,
          quantityBase: 1,
          manualDiscount: { discountType: DiscountType.PERCENT_OFF, value: 1000 }, // 10%
        },
        { variantId: b.variant.id, quantityBase: 1 },
      ],
      orderDiscount: { discountType: DiscountType.AMOUNT_OFF, value: 3_00 },
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 50_00 }],
    })

    // 30.00 gross − 2.00 line − 3.00 order = 25.00 net; lines reconcile exactly.
    expect(receipt.subtotalCents).toBe(30_00)
    expect(receipt.discountCents).toBe(5_00)
    expect(receipt.lines.reduce((sum, l) => sum + l.netCents, 0)).toBe(25_00)
    for (const line of receipt.lines) {
      expect(line.netCents).toBe(line.grossCents - line.discountCents)
    }
  })

  it('keeps duplicate-variant lines separate with their own snapshots', async () => {
    const { variant } = await eachProduct({ stock: 10 })
    const receipt = await checkout(admin, {
      lines: [
        { variantId: variant.id, quantityBase: 1 },
        {
          variantId: variant.id,
          quantityBase: 2,
          manualDiscount: { discountType: DiscountType.PERCENT_OFF, value: 5000 },
        },
      ],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 50_00 }],
    })
    expect(receipt.lines).toHaveLength(2)
    expect(receipt.lines[0]!.discountCents).toBe(0)
    expect(receipt.lines[1]!.discountCents).toBe(10_00)
    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId: variant.id } },
    })
    expect(level!.quantityBase).toBe(7)
  })
})

describe('gates and scoping', () => {
  it('refuses without an open shift, and after the shift closes', async () => {
    const { variant } = await eachProduct()
    const shift = await prisma.shift.findFirstOrThrow({ where: { storeId: storeA.id } })
    await closeShift(staff, shift.id, { countedCashCents: 100_00 })

    await expect(
      checkout(admin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
      }),
    ).rejects.toThrow(ConflictError)
  })

  it('requires terminal attachment — a desk admin cannot ring', async () => {
    const { variant } = await eachProduct()
    const deskAdmin: AdminPrincipal = { ...admin, terminalId: null }
    await expect(
      checkout(deskAdmin, {
        lines: [{ variantId: variant.id, quantityBase: 1 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
      }),
    ).rejects.toThrow(ForbiddenError)
  })

  it('pins staff reads to their own store', async () => {
    const { variant } = await eachProduct()
    const receipt = await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
    })

    const staffB: StaffPrincipal = {
      kind: 'staff',
      userId: (await makeStaff(storeB.id, '9876', 'staff-b@test.local')).id,
      role: Role.STAFF,
      storeId: storeB.id,
      terminalId: (await makeTerminal(storeB.id, 'sales-test-b-token')).id,
    }
    await expect(getSale(staffB, receipt.id)).rejects.toThrow(ForbiddenError)
  })

  it('numbers five concurrent sales 1..5 with no gaps', async () => {
    const { variant } = await eachProduct({ stock: 50 })
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        checkout(admin, {
          lines: [{ variantId: variant.id, quantityBase: 1 }],
          ageVerified: false,
          tenders: [{ method: 'CASH', tenderedCents: 20_00 }],
        }),
      ),
    )
    expect(results.map((r) => r.number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
  })
})
