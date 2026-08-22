import { Role, TrackingMode } from '@huta/shared'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app.js'
import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import {
  createBrand,
  createProduct,
  createVariant,
  setProductCannabinoids,
  setProductImages,
  updateProduct,
  updateVariant,
} from '../../src/catalog/catalog-admin.service.js'
import { getProduct, listProducts, reference } from '../../src/catalog/catalog.service.js'
import { productInsights } from '../../src/catalog/insights.service.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, NotFoundError, ValidationError } from '../../src/errors/index.js'
import { movementsForVariant } from '../../src/inventory/inventory.service.js'
import { quickCreateProduct } from '../../src/receiving/receiving.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  giveStock,
  makeAdmin,
  makeCannabinoid,
  makeCategory,
  makePriceGroup,
  makeProduct,
  makeStaff,
  makeStore,
  makeSupplier,
  makeTerminal,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'

/**
 * The product editor's server half: admin-only writes, the insights aggregate, and the
 * admin-vs-staff visibility split on reads.
 *
 * Most tests call services directly, matching the rest of the suite. Authorization lives
 * in the ROUTES (`requireAdmin` + `assertCan`), so one HTTP sweep at the end proves every
 * write endpoint and the insights read actually carry the guard — a service test cannot.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')

  // A real user row — the audit trail FKs to User, so a made-up id would violate it,
  // which is itself the audit working as designed.
  const adminUser = await makeAdmin()
  admin = {
    kind: 'admin',
    userId: adminUser.id,
    role: Role.ADMIN,
    storeId: null,
    terminalId: null,
  }
  staff = {
    kind: 'staff',
    userId: 'u-staff',
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: 't-1',
  }
})

describe('variant visibility', () => {
  it('shows an inactive variant to an admin and hides it from staff', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({
      name: 'Gummies',
      categoryId: category.id,
      variants: [{ label: 'Live', priceCents: 1000 }, { label: 'Dormant', priceCents: 2000 }],
    })
    const dormant = product.variants.find((v) => v.label === 'Dormant')!
    await prisma.productVariant.update({ where: { id: dormant.id }, data: { active: false } })

    const adminView = await getProduct(admin, product.id)
    expect(adminView.variants).toHaveLength(2)
    const dormantRow = adminView.variants.find((v) => v.id === dormant.id)
    expect(dormantRow).toMatchObject({ active: false })
    // The sale guardrails ride along for the editor.
    expect(dormantRow).toHaveProperty('minSaleBase')
    expect(dormantRow).toHaveProperty('maxSaleBase')

    const staffView = await getProduct(staff, product.id)
    expect(staffView.variants).toHaveLength(1)
    expect(staffView.variants[0]).toMatchObject({ label: 'Live', active: true })
  })
})

describe('inactive product listing', () => {
  it('reaches inactive products for an admin and never for staff', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Shelved', categoryId: category.id })
    await prisma.product.update({ where: { id: product.id }, data: { active: false } })

    const defaults = await listProducts(admin, { page: 1, pageSize: 50 })
    expect(defaults.products).toHaveLength(0)

    const inactive = await listProducts(admin, { active: 'false', page: 1, pageSize: 50 })
    expect(inactive.products.map((p) => p.name)).toEqual(['Shelved'])

    const all = await listProducts(admin, { active: 'all', page: 1, pageSize: 50 })
    expect(all.products).toHaveLength(1)

    // Staff asking for 'all' are silently narrowed, not refused — the filter is a
    // capability, not a secret worth signalling.
    const staffAll = await listProducts(staff, { active: 'all', page: 1, pageSize: 50 })
    expect(staffAll.products).toHaveLength(0)
  })
})

describe('movement ledger', () => {
  it('returns the flat wire shape, strips cost for staff, and filters by store', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    const variant = product.variants[0]!
    await giveStock(storeA.id, variant.id, 4, 2000)
    await giveStock(storeB.id, variant.id, 2, 900)

    const adminRows = await movementsForVariant(admin, variant.id)
    expect(adminRows).toHaveLength(2)
    expect(adminRows[0]).toMatchObject({ storeName: expect.any(String), userName: null })
    expect(adminRows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    // Admin rows carry the cost keys even when the value is unknown — key presence is the
    // contract the client renders from.
    expect(adminRows[0]).toHaveProperty('unitCostCents')
    expect(findCostKeys(adminRows).length).toBeGreaterThan(0)

    const staffRows = await movementsForVariant(staff, variant.id)
    expect(findCostKeys(staffRows)).toEqual([])

    const only = await movementsForVariant(admin, variant.id, storeB.id)
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ storeId: storeB.id })
  })
})

describe('product insights', () => {
  it('computes value and margin for an EACH variant from the basis, not costCents', async () => {
    const category = await makeCategory('Edible', 'edible')
    // costCents deliberately absurd — margin must never read it.
    const product = await makeProduct({
      name: 'Gummies',
      categoryId: category.id,
      priceCents: 1000,
      costCents: 999_999,
    })
    await giveStock(storeA.id, product.variants[0]!.id, 4, 2000)

    const insights = await productInsights(admin, product.id)
    expect(insights.valueAtCostCents).toBe(2000)
    // Retail 4 × $10 = $40, cost $20 → 50.00% margin.
    expect(insights.marginBps).toBe(5000)
    expect(insights.lossRate90d).toBeNull()
    expect(insights.variants[0]).toMatchObject({ avgUnitCostCents: 500, marginBps: 5000 })
  })

  it('handles WEIGHT stock through the mg↔g factor and reports the loss rate', async () => {
    const flower = await makeCategory('Flower', 'flower')
    const group = await makePriceGroup('Flower Rate', 'flower-rate', 1000)
    const product = await makeWeightProduct({
      name: 'Blue Dream',
      categoryId: flower.id,
      priceGroupId: group.id,
    })
    const variant = product.variants[0]!
    // 14g at $4/g: basis $56 against a $10/g retail rate.
    await giveStock(storeA.id, variant.id, 14_000, 5600)
    await prisma.inventoryMovement.create({
      data: {
        storeId: storeA.id,
        variantId: variant.id,
        type: 'SHRINKAGE',
        quantityBase: -500,
        balanceAfterBase: 13_500,
        reasonCode: 'moisture',
      },
    })

    const insights = await productInsights(admin, product.id)
    // Retail 14g × $10/g = $140; margin (140−56)/140 = 60%. A raw mg×rate product would
    // have been 1000× off — this line is the mg↔g proof.
    expect(insights.marginBps).toBe(6000)
    expect(insights.variants[0]).toMatchObject({ avgUnitCostCents: 400 })
    expect(insights.lossRate90d).toMatchObject({
      receivedBase: 14_000,
      lostBase: 500,
      lossRateBps: 357,
    })
    expect(insights.variants[0]!.variance).toBeDefined()
  })

  it('reports null, never zero or 100%, when cost is unknown', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id, priceCents: 1000 })
    await giveStock(storeA.id, product.variants[0]!.id, 4)

    const insights = await productInsights(admin, product.id)
    expect(insights.valueAtCostCents).toBeNull()
    expect(insights.marginBps).toBeNull()
    expect(insights.variants[0]).toMatchObject({ avgUnitCostCents: null, marginBps: null })
  })

  it('narrows to the requested store', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id, priceCents: 1000 })
    await giveStock(storeA.id, product.variants[0]!.id, 4, 2000)

    const scoped = await productInsights(admin, product.id, storeB.id)
    expect(scoped.valueAtCostCents).toBeNull()
    expect(scoped.variants[0]!.levels).toHaveLength(1)
    expect(scoped.variants[0]!.levels[0]).toMatchObject({ storeId: storeB.id })
  })
})

describe('updateProduct', () => {
  it('regenerates the slug on rename, keeps it on a same-name save, and audits', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })

    const renamed = await updateProduct(admin, product.id, { name: 'Sour Gummies' })
    expect(renamed.slug).toBe('sour-gummies')

    const resaved = await updateProduct(admin, product.id, { name: 'Sour Gummies' })
    expect(resaved.slug).toBe('sour-gummies')

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'catalog.product.update', entityId: product.id },
    })
    expect(auditRow).not.toBeNull()
    expect(auditRow!.before).toMatchObject({ name: 'Gummies' })
  })

  it('refuses an unknown category with a useful message', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    await expect(
      updateProduct(admin, product.id, { categoryId: 'cmzzzzzzzzzzzzzzzzzzzzzzz' }),
    ).rejects.toThrow(NotFoundError)
  })

  it('deactivation removes it from the default list but not the detail', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })

    await updateProduct(admin, product.id, { active: false })

    const listed = await listProducts(admin, { page: 1, pageSize: 50 })
    expect(listed.products).toHaveLength(0)
    const detail = await getProduct(admin, product.id)
    expect(detail.active).toBe(false)
  })
})

describe('cannabinoid links', () => {
  it('replaces the whole set, allowing %-only and potency-unknown links', async () => {
    const category = await makeCategory('Flower', 'flower')
    const d8 = await makeCannabinoid('Delta-8', 'delta-8')
    const thca = await makeCannabinoid('THCA', 'thca')
    const cbg = await makeCannabinoid('CBG', 'cbg')
    const product = await makeProduct({
      name: 'Blue Dream',
      categoryId: category.id,
      cannabinoidIds: [d8.id],
    })

    await setProductCannabinoids(admin, product.id, [
      { cannabinoidId: thca.id, mgPerUnit: null, percentBps: 2430 },
      { cannabinoidId: cbg.id, mgPerUnit: null, percentBps: null },
    ])

    const detail = await getProduct(admin, product.id)
    const bySlug = new Map(detail.cannabinoids.map((c) => [c.cannabinoid.slug, c]))
    expect(bySlug.has('delta-8')).toBe(false)
    expect(bySlug.get('thca')).toMatchObject({ mgPerUnit: null, percentBps: 2430 })
    expect(bySlug.get('cbg')).toMatchObject({ mgPerUnit: null, percentBps: null })
  })

  it('refuses a duplicate cannabinoid', async () => {
    const category = await makeCategory('Flower', 'flower')
    const d8 = await makeCannabinoid('Delta-8', 'delta-8')
    const product = await makeProduct({ name: 'Blue Dream', categoryId: category.id })

    await expect(
      setProductCannabinoids(admin, product.id, [
        { cannabinoidId: d8.id, mgPerUnit: 25, percentBps: null },
        { cannabinoidId: d8.id, mgPerUnit: 50, percentBps: null },
      ]),
    ).rejects.toThrow(ValidationError)
  })
})

describe('images', () => {
  it('persists the array order as the display order', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({
      name: 'Gummies',
      categoryId: category.id,
      images: [
        { url: 'https://cdn.test/a.jpg', sortOrder: 0 },
        { url: 'https://cdn.test/b.jpg', sortOrder: 1 },
      ],
    })

    await setProductImages(admin, product.id, [
      { url: 'https://cdn.test/b.jpg' },
      { url: 'https://cdn.test/a.jpg' },
    ])

    const detail = await getProduct(admin, product.id)
    expect(detail.images.map((i) => i.url)).toEqual([
      'https://cdn.test/b.jpg',
      'https://cdn.test/a.jpg',
    ])
    expect(detail.imageUrl).toBe('https://cdn.test/b.jpg')

    const listed = await listProducts(admin, { page: 1, pageSize: 50 })
    expect(listed.products[0]!.imageUrl).toBe('https://cdn.test/b.jpg')
  })
})

describe('updateVariant', () => {
  it('changes an EACH price and audits it', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id, priceCents: 1000 })
    const variant = product.variants[0]!

    const updated = await updateVariant(admin, variant.id, { priceCents: 1250 })
    expect(updated.priceCents).toBe(1250)

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'catalog.variant.update', entityId: variant.id },
    })
    expect(auditRow!.before).toMatchObject({ priceCents: 1000 })
    expect(auditRow!.after).toMatchObject({ priceCents: 1250 })
  })

  it('refuses a per-item price on a WEIGHT variant, pointing at the Pricing page', async () => {
    const flower = await makeCategory('Flower', 'flower')
    const group = await makePriceGroup('Flower Rate', 'flower-rate', 1000)
    const product = await makeWeightProduct({
      name: 'Blue Dream',
      categoryId: flower.id,
      priceGroupId: group.id,
    })

    await expect(
      updateVariant(admin, product.variants[0]!.id, { priceCents: 999 }),
    ).rejects.toThrow(/Pricing page/)
  })

  it('holds the EACH pricing shape against partial patches', async () => {
    const category = await makeCategory('Edible', 'edible')
    const group = await makePriceGroup('Stray Group', 'stray-group', 1000)
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id, priceCents: 1000 })
    const variant = product.variants[0]!

    await expect(updateVariant(admin, variant.id, { priceGroupId: group.id })).rejects.toThrow(
      ValidationError,
    )
    await expect(updateVariant(admin, variant.id, { priceCents: null })).rejects.toThrow(
      ValidationError,
    )
  })

  it('refuses duplicate SKUs and barcodes with a conflict', async () => {
    const category = await makeCategory('Edible', 'edible')
    const one = await makeProduct({ name: 'Gummies', categoryId: category.id })
    const two = await makeProduct({ name: 'Rings', categoryId: category.id })
    await updateVariant(admin, one.variants[0]!.id, { barcode: '012345678905' })

    await expect(
      updateVariant(admin, two.variants[0]!.id, { sku: one.variants[0]!.sku }),
    ).rejects.toThrow(ConflictError)
    await expect(
      updateVariant(admin, two.variants[0]!.id, { barcode: '012345678905' }),
    ).rejects.toThrow(ConflictError)
    // The message must NAME the owner: someone tagging a shelf with a scanner needs to know
    // which item already holds the code, not merely that something does.
    await expect(
      updateVariant(admin, two.variants[0]!.id, { barcode: '012345678905' }),
    ).rejects.toThrow(/already on Gummies/)
  })

  it('refuses a minimum sale quantity above the maximum', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })

    await expect(
      updateVariant(admin, product.variants[0]!.id, { minSaleBase: 10, maxSaleBase: 5 }),
    ).rejects.toThrow(ValidationError)
  })

  it('deactivating a variant hides it from staff and keeps it for admins', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    const variant = product.variants[0]!

    await updateVariant(admin, variant.id, { active: false })

    const staffView = await getProduct(staff, product.id)
    expect(staffView.variants).toHaveLength(0)
    const adminView = await getProduct(admin, product.id)
    expect(adminView.variants).toHaveLength(1)
  })
})

describe('createVariant', () => {
  it('creates an EACH variant ready to sell, and enforces the pricing shape', async () => {
    const category = await makeCategory('Edible', 'edible')
    const flowerGroup = await makePriceGroup('Flower Rate', 'flower-rate', 1000)
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })

    const created = await createVariant(admin, product.id, {
      sku: 'NEW-1',
      trackingMode: TrackingMode.EACH,
      priceCents: 1500,
      label: '500mg',
    })
    expect(created).toMatchObject({ sku: 'NEW-1', active: true })

    await expect(
      createVariant(admin, product.id, { sku: 'NEW-2', trackingMode: TrackingMode.EACH }),
    ).rejects.toThrow(ValidationError)
    await expect(
      createVariant(admin, product.id, { sku: 'NEW-3', trackingMode: TrackingMode.WEIGHT }),
    ).rejects.toThrow(ValidationError)
    await expect(
      createVariant(admin, product.id, {
        sku: 'NEW-4',
        trackingMode: TrackingMode.WEIGHT,
        priceCents: 999,
        priceGroupId: flowerGroup.id,
      }),
    ).rejects.toThrow(ValidationError)

    const weight = await createVariant(admin, product.id, {
      sku: 'NEW-5',
      trackingMode: TrackingMode.WEIGHT,
      priceGroupId: flowerGroup.id,
    })
    expect(weight).toMatchObject({ trackingMode: 'WEIGHT' })

    await expect(
      createVariant(admin, product.id, { sku: 'NEW-1', trackingMode: TrackingMode.EACH, priceCents: 1 }),
    ).rejects.toThrow(ConflictError)
  })
})

describe('createProduct', () => {
  it('creates a product with its first EACH variant, fully attributed and staff-visible', async () => {
    const category = await makeCategory('Edible', 'edible')
    const brand = await createBrand(admin, 'Hazy Farms')
    const supplier = await makeSupplier()

    const created = await createProduct(admin, {
      name: 'Sunset Gummies',
      categoryId: category.id,
      brandId: brand.id,
      primarySupplierId: supplier.id,
      description: 'Blood-orange 25mg gummies.',
      variant: { sku: 'SUN-25', trackingMode: TrackingMode.EACH, priceCents: 1999 },
    })

    expect(created).toMatchObject({ name: 'Sunset Gummies', slug: 'sunset-gummies', active: true })
    expect(created.variant).toMatchObject({ sku: 'SUN-25', trackingMode: 'EACH', active: true })

    // Active by default means staff can already sell it — the whole point of the endpoint.
    const staffView = await listProducts(staff, { page: 1, pageSize: 50 })
    expect(staffView.products.map((p) => p.name)).toContain('Sunset Gummies')

    // Two audit rows: the product's birth, and a variant-create row in createVariant's shape.
    const productAudit = await prisma.auditLog.findFirst({
      where: { action: 'catalog.product.create', entityId: created.id },
    })
    expect(productAudit!.before).toMatchObject({})
    expect(productAudit!.after).toMatchObject({ name: 'Sunset Gummies', slug: 'sunset-gummies' })
    const variantAudit = await prisma.auditLog.findFirst({
      where: { action: 'catalog.variant.create', entityId: created.variant.id },
    })
    expect(variantAudit!.after).toMatchObject({ sku: 'SUN-25', trackingMode: 'EACH' })
  })

  it('creates a WEIGHT strain on a price group — the flower path', async () => {
    const flower = await makeCategory('Flower', 'flower')
    const group = await makePriceGroup('Flower', 'flower', 1000)

    const created = await createProduct(admin, {
      name: 'Blue Dream',
      categoryId: flower.id,
      strainType: 'HYBRID',
      terpeneProfile: 'Myrcene, Pinene',
      nose: 'Sweet berry',
      variant: { sku: 'BD-1G', trackingMode: TrackingMode.WEIGHT, priceGroupId: group.id },
    })

    const row = await prisma.productVariant.findUnique({ where: { id: created.variant.id } })
    expect(row).toMatchObject({ trackingMode: 'WEIGHT', priceCents: null, priceGroupId: group.id })
    const product = await prisma.product.findUnique({ where: { id: created.id } })
    expect(product).toMatchObject({ strainType: 'HYBRID', nose: 'Sweet berry' })
  })

  it('enforces the pricing shape in all four directions', async () => {
    const category = await makeCategory('Edible', 'edible')
    const group = await makePriceGroup('Flower', 'flower', 1000)
    const base = { name: 'Shape Test', categoryId: category.id }

    await expect(
      createProduct(admin, { ...base, variant: { sku: 'S-1', trackingMode: TrackingMode.EACH } }),
    ).rejects.toThrow(ValidationError)
    await expect(
      createProduct(admin, {
        ...base,
        variant: { sku: 'S-2', trackingMode: TrackingMode.EACH, priceCents: 1, priceGroupId: group.id },
      }),
    ).rejects.toThrow(ValidationError)
    await expect(
      createProduct(admin, { ...base, variant: { sku: 'S-3', trackingMode: TrackingMode.WEIGHT } }),
    ).rejects.toThrow(ValidationError)
    await expect(
      createProduct(admin, {
        ...base,
        variant: { sku: 'S-4', trackingMode: TrackingMode.WEIGHT, priceCents: 1, priceGroupId: group.id },
      }),
    ).rejects.toThrow(ValidationError)

    // Nothing landed under the four refusals.
    expect(await prisma.product.count({ where: { name: 'Shape Test' } })).toBe(0)
  })

  it('dedupes the slug when two products share a name', async () => {
    const category = await makeCategory('Flower', 'flower')
    const group = await makePriceGroup('Flower', 'flower', 1000)
    const make = (sku: string) =>
      createProduct(admin, {
        name: 'Gelato',
        categoryId: category.id,
        variant: { sku, trackingMode: TrackingMode.WEIGHT, priceGroupId: group.id },
      })

    const first = await make('GEL-1')
    const second = await make('GEL-2')
    expect(first.slug).toBe('gelato')
    expect(second.slug).toBe('gelato-2')
  })

  it('refuses a duplicate SKU, an inactive category, and unknown references', async () => {
    const category = await makeCategory('Edible', 'edible')
    const existing = await makeProduct({ name: 'Existing', categoryId: category.id })
    const takenSku = existing.variants[0]!.sku

    await expect(
      createProduct(admin, {
        name: 'Clash',
        categoryId: category.id,
        variant: { sku: takenSku, trackingMode: TrackingMode.EACH, priceCents: 1 },
      }),
    ).rejects.toThrow(ConflictError)

    const retired = await makeCategory('Retired', 'retired')
    await prisma.category.update({ where: { id: retired.id }, data: { active: false } })
    await expect(
      createProduct(admin, {
        name: 'Nope',
        categoryId: retired.id,
        variant: { sku: 'NOPE-1', trackingMode: TrackingMode.EACH, priceCents: 1 },
      }),
    ).rejects.toThrow(NotFoundError)

    await expect(
      createProduct(admin, {
        name: 'Nope',
        categoryId: category.id,
        brandId: 'b-missing',
        variant: { sku: 'NOPE-2', trackingMode: TrackingMode.EACH, priceCents: 1 },
      }),
    ).rejects.toThrow(NotFoundError)
    await expect(
      createProduct(admin, {
        name: 'Nope',
        categoryId: category.id,
        variant: { sku: 'NOPE-3', trackingMode: TrackingMode.WEIGHT, priceGroupId: 'pg-missing' },
      }),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('createBrand', () => {
  it('creates, dedupes the slug, and lands in the reference payload', async () => {
    const first = await createBrand(admin, 'Hazy Farms')
    const second = await createBrand(admin, 'Hazy Farms')
    expect(first.id).not.toBe(second.id)

    const slugs = await prisma.brand.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } })
    expect(slugs.map((b) => b.slug)).toEqual(['hazy-farms', 'hazy-farms-2'])

    const ref = await reference()
    expect(ref.brands.filter((b) => b.name === 'Hazy Farms')).toHaveLength(2)
  })
})

describe('the quick-product rescue flow', () => {
  it('takes a receiving-created product from unpriced to staff-visible', async () => {
    const category = await makeCategory('Edible', 'edible')
    const quick = await quickCreateProduct({
      name: 'Walk-in Gummies',
      sku: 'WALKIN-1',
      categoryId: category.id,
    })

    await updateVariant(admin, quick.variantId, { priceCents: 1999 })
    await updateVariant(admin, quick.variantId, { active: true })
    await updateProduct(admin, quick.productId, { active: true })

    const staffView = await listProducts(staff, { page: 1, pageSize: 50 })
    expect(staffView.products.map((p) => p.name)).toContain('Walk-in Gummies')
    const detail = await getProduct(staff, quick.productId)
    expect(detail.variants[0]).toMatchObject({ priceCents: 1999, active: true })
  })
})

describe('HTTP authorization', () => {
  const app = createApp()
  const DEVICE_TOKEN = 'test-device-token-for-catalog-admin'

  function readCookie(setCookie: string[] | undefined, name: string): string | null {
    for (const raw of setCookie ?? []) {
      const [pair] = raw.split(';')
      const [key, ...rest] = (pair ?? '').split('=')
      if (key === name) return decodeURIComponent(rest.join('='))
    }
    return null
  }

  // `requireAdmin` answers 401 (its house convention), not 403 — what matters here is that
  // every endpoint refuses and nothing writes.
  it('refuses a PIN-attached staff session on every write endpoint and on insights', async () => {
    const staffUser = await makeStaff(storeA.id, '4321')
    await makeTerminal(storeA.id, DEVICE_TOKEN)
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    const variant = product.variants[0]!

    const agent = request(app)
    const primed = await agent.get('/api/auth/me').set('X-Device-Token', DEVICE_TOKEN)
    const jar = (primed.headers['set-cookie'] as unknown as string[]) ?? []
    const csrf = readCookie(jar, 'huta_csrf')
    const attach = await agent
      .post('/api/auth/staff/attach')
      .set('X-Device-Token', DEVICE_TOKEN)
      .set('Cookie', jar)
      .set('X-CSRF-Token', csrf ?? '')
      .send({ userId: staffUser.id, pin: '4321' })
    expect(attach.status).toBe(200)
    const session = attach.headers['set-cookie'] as unknown as string[]
    const sessionCsrf = readCookie(session, 'huta_csrf') ?? csrf ?? ''

    const writes: Array<{ method: 'patch' | 'put' | 'post'; path: string; body: object }> = [
      { method: 'patch', path: `/api/catalog/products/${product.id}`, body: { name: 'X' } },
      { method: 'put', path: `/api/catalog/products/${product.id}/cannabinoids`, body: { links: [] } },
      { method: 'put', path: `/api/catalog/products/${product.id}/images`, body: { images: [] } },
      { method: 'patch', path: `/api/catalog/variants/${variant.id}`, body: { priceCents: 1 } },
      {
        method: 'post',
        path: `/api/catalog/products/${product.id}/variants`,
        body: { sku: 'HTTP-1', trackingMode: 'EACH', priceCents: 1 },
      },
      { method: 'post', path: '/api/catalog/brands', body: { name: 'Nope' } },
      {
        method: 'post',
        path: '/api/catalog/products',
        body: {
          name: 'Nope',
          categoryId: category.id,
          variant: { sku: 'HTTP-2', trackingMode: 'EACH', priceCents: 1 },
        },
      },
    ]

    for (const write of writes) {
      const res = await request(app)
        [write.method](write.path)
        .set('X-Device-Token', DEVICE_TOKEN)
        .set('Cookie', session)
        .set('X-CSRF-Token', sessionCsrf)
        .send(write.body)
      expect(res.status, `${write.method.toUpperCase()} ${write.path}`).toBe(401)
    }

    const insights = await request(app)
      .get(`/api/catalog/products/${product.id}/insights`)
      .set('X-Device-Token', DEVICE_TOKEN)
      .set('Cookie', session)
    expect(insights.status).toBe(401)

    // And nothing changed under the refusals.
    const untouched = await prisma.product.findUnique({ where: { id: product.id } })
    expect(untouched!.name).toBe('Gummies')
  })
})
