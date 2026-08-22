import { Role, TrackingMode } from '@huta/shared'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { listProducts, expandCategoryIds } from '../../src/catalog/catalog.service.js'
import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  giveStock,
  makeCannabinoid,
  makeCategory,
  makeProduct,
  makeStore,
  makeSupplier,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Catalog reads against a real database.
 *
 * The first test here is the one the house rules has demanded since phase 1 and that no phase
 * has been able to write, because until now nothing returned a cost-bearing payload.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal

beforeAll(() => {
  // Nothing global — each test builds its own world.
})

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')

  admin = {
    kind: 'admin',
    userId: 'u-admin',
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

describe('cost visibility', () => {
  it('never sends a cost field to a staff principal, anywhere in the payload', async () => {
    const category = await makeCategory('Edible', 'edible')
    await makeProduct({
      name: 'Gummies',
      categoryId: category.id,
      priceCents: 4000,
      costCents: 2000,
    })

    const staffView = await listProducts(staff, { page: 1, pageSize: 50 })
    // Asserted by walking the whole object rather than checking one known key — the rule
    // is "no cost anywhere", and a nested include is exactly how it would leak.
    expect(findCostKeys(staffView)).toEqual([])
  })

  it('does send cost to an admin, so the test above is proving something', async () => {
    const category = await makeCategory('Edible', 'edible')
    await makeProduct({
      name: 'Gummies',
      categoryId: category.id,
      priceCents: 4000,
      costCents: 2000,
    })

    const adminView = await listProducts(admin, { page: 1, pageSize: 50 })
    expect(adminView.products[0]?.variants[0]).toMatchObject({ costCents: 2000 })
    expect(findCostKeys(adminView).length).toBeGreaterThan(0)
  })
})

describe('category expansion', () => {
  it('includes the selected node AND its descendants', async () => {
    const parent = await makeCategory('Inhalables', 'inhalables')
    const child = await makeCategory('Cartridge', 'cartridge', parent.id)

    const expanded = await expandCategoryIds([parent.id])
    expect(expanded.sort()).toEqual([parent.id, child.id].sort())
  })

  it('handles a childless top-level category that holds products directly', async () => {
    // This is `Other` in the real data: top-level, no children, 15 products attached.
    // Expanding to descendants alone would return nothing and hide all 15.
    const other = await makeCategory('Other', 'other')
    await makeProduct({ name: 'Lighter', categoryId: other.id })

    const expanded = await expandCategoryIds([other.id])
    expect(expanded).toEqual([other.id])

    const result = await listProducts(admin, {
      categoryIds: [other.id],
      page: 1,
      pageSize: 50,
    })
    expect(result.total).toBe(1)
  })
})

describe('filtering', () => {
  it('ORs within the category facet and ANDs across facets', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const vape = await makeCategory('Vape', 'vape')
    const tray = await makeCategory('Trays', 'trays')
    const d8 = await makeCannabinoid('Delta-8', 'delta-8')

    await makeProduct({ name: 'Edible D8', categoryId: edible.id, cannabinoidIds: [d8.id] })
    await makeProduct({ name: 'Vape D8', categoryId: vape.id, cannabinoidIds: [d8.id] })
    // Right category, no cannabinoid — excluded by the AND across facets.
    await makeProduct({ name: 'Edible plain', categoryId: edible.id })
    // Right cannabinoid, wrong category — also excluded.
    await makeProduct({ name: 'Tray D8', categoryId: tray.id, cannabinoidIds: [d8.id] })

    const result = await listProducts(admin, {
      categoryIds: [edible.id, vape.id],
      cannabinoidIds: [d8.id],
      page: 1,
      pageSize: 50,
    })

    expect(result.products.map((p) => p.name).sort()).toEqual(['Edible D8', 'Vape D8'])
  })

  it('requires EVERY selected cannabinoid — AND within the facet', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const d8 = await makeCannabinoid('Delta-8', 'delta-8')
    const cbd = await makeCannabinoid('CBD', 'cbd')

    await makeProduct({ name: 'Both Gummies', categoryId: edible.id, cannabinoidIds: [d8.id, cbd.id] })
    // Each carries only one of the two — included under the old OR, excluded now.
    await makeProduct({ name: 'D8 Gummies', categoryId: edible.id, cannabinoidIds: [d8.id] })
    await makeProduct({ name: 'CBD Gummies', categoryId: edible.id, cannabinoidIds: [cbd.id] })

    const result = await listProducts(admin, {
      cannabinoidIds: [d8.id, cbd.id],
      // Matches all three names — here to prove the search facet's own top-level `OR`
      // composes with the cannabinoid facet's explicit top-level `AND`.
      search: 'gummies',
      page: 1,
      pageSize: 50,
    })

    expect(result.products.map((p) => p.name)).toEqual(['Both Gummies'])
  })

  it('searches name and SKU', async () => {
    const category = await makeCategory('Edible', 'edible')
    await makeProduct({ name: 'Blueberry Gummies', categoryId: category.id })
    await makeProduct({ name: 'Peach Rings', categoryId: category.id })

    const byName = await listProducts(admin, { search: 'blue', page: 1, pageSize: 50 })
    expect(byName.products.map((p) => p.name)).toEqual(['Blueberry Gummies'])
  })

  /**
   * Since 2026-08-21 a strain IS a variant label — Blue Dream is a variant of `Regular
   * Flower` — so a search that ignored the label made the single most-asked-for name on
   * the shelf unfindable, while every screen still printed it as "Regular Flower · Blue
   * Dream". Found live in the transfer composer, where typing the strain returned nothing.
   */
  it('searches the variant LABEL — a strain is a label, not a product name', async () => {
    const flower = await makeCategory('Flower', 'flower')
    await makeProduct({
      name: 'Regular Flower',
      categoryId: flower.id,
      variants: [
        { label: 'Blue Dream', trackingMode: TrackingMode.WEIGHT },
        { label: 'Purple Haze', trackingMode: TrackingMode.WEIGHT },
      ],
    })
    await makeProduct({ name: 'Rolling Papers', categoryId: flower.id })

    const byLabel = await listProducts(admin, { search: 'blue dream', page: 1, pageSize: 50 })
    expect(byLabel.products.map((p) => p.name)).toEqual(['Regular Flower'])

    // Case-insensitive and partial, the way a cashier types under a queue.
    const partial = await listProducts(admin, { search: 'HAZE', page: 1, pageSize: 50 })
    expect(partial.products.map((p) => p.name)).toEqual(['Regular Flower'])

    // Not vacuous: a term matching no name, brand, SKU, barcode OR label still finds nothing.
    const miss = await listProducts(admin, { search: 'gelato', page: 1, pageSize: 50 })
    expect(miss.products).toEqual([])
  })

  /**
   * Products can name a supplier at TWO levels since the strain work — the product's
   * `primarySupplierId` and a variant's own override — so the filter has to match either,
   * or a strain bought from a different distributor vanishes from that distributor's page.
   */
  it('filters by supplier, matching the product OR one of its variants', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const flower = await makeCategory('Flower', 'flower')
    const theirs = await makeSupplier('Huta Essentials', { slug: 'huta-essentials' })
    const other = await makeSupplier('Binoid CBD', { slug: 'binoid-cbd' })

    const byProduct = await makeProduct({ name: 'Their Gummies', categoryId: edible.id })
    await prisma.product.update({
      where: { id: byProduct.id },
      data: { primarySupplierId: theirs.id },
    })

    // The flower shelf itself belongs to nobody; one strain on it is theirs.
    const shelf = await makeProduct({
      name: 'Regular Flower',
      categoryId: flower.id,
      variants: [
        { label: 'Blue Dream', trackingMode: TrackingMode.WEIGHT },
        { label: 'Purple Haze', trackingMode: TrackingMode.WEIGHT },
      ],
    })
    await prisma.productVariant.update({
      where: { id: shelf.variants[0]!.id },
      data: { supplierId: theirs.id },
    })

    const notTheirs = await makeProduct({ name: 'Someone Else Rings', categoryId: edible.id })
    await prisma.product.update({
      where: { id: notTheirs.id },
      data: { primarySupplierId: other.id },
    })

    const result = await listProducts(admin, {
      supplierId: theirs.id,
      page: 1,
      pageSize: 50,
    })
    expect(result.products.map((p) => p.name).sort()).toEqual(['Regular Flower', 'Their Gummies'])
  })

  /**
   * Supplier and search are the pair that exposed it: both need their own `OR`, and spreading
   * two `OR` keys into one object literal silently drops the first. The facets are composed as
   * sibling entries of a single AND precisely so this cannot happen.
   */
  it('ANDs the supplier facet against search rather than letting one overwrite the other', async () => {
    const edible = await makeCategory('Edible', 'edible')
    const theirs = await makeSupplier('Huta Essentials', { slug: 'huta-essentials' })
    const other = await makeSupplier('Binoid CBD', { slug: 'binoid-cbd' })

    const wanted = await makeProduct({ name: 'Mango Gummies', categoryId: edible.id })
    await prisma.product.update({
      where: { id: wanted.id },
      data: { primarySupplierId: theirs.id },
    })
    // Matches the SEARCH but the wrong supplier — the row a dropped supplier facet returns.
    const decoy = await makeProduct({ name: 'Mango Rings', categoryId: edible.id })
    await prisma.product.update({
      where: { id: decoy.id },
      data: { primarySupplierId: other.id },
    })
    // Matches the SUPPLIER but not the search — the row a dropped search facet returns.
    const otherProduct = await makeProduct({ name: 'Peach Drops', categoryId: edible.id })
    await prisma.product.update({
      where: { id: otherProduct.id },
      data: { primarySupplierId: theirs.id },
    })

    const result = await listProducts(admin, {
      supplierId: theirs.id,
      search: 'mango',
      page: 1,
      pageSize: 50,
    })
    expect(result.products.map((p) => p.name)).toEqual(['Mango Gummies'])
  })

  it('searches barcode — a scan types digits into the same search box', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Scannable Gummies', categoryId: category.id })
    await prisma.productVariant.update({
      where: { id: product.variants[0]!.id },
      data: { barcode: '012345678905' },
    })
    await makeProduct({ name: 'Unscannable Rings', categoryId: category.id })

    const byBarcode = await listProducts(admin, { search: '012345678905', page: 1, pageSize: 50 })
    expect(byBarcode.products.map((p) => p.name)).toEqual(['Scannable Gummies'])
  })
})

describe('list images', () => {
  it('returns the first image by sortOrder as imageUrl, or null, and not the array', async () => {
    const category = await makeCategory('Edible', 'edible')
    await makeProduct({
      name: 'Pictured',
      categoryId: category.id,
      // Insert order deliberately disagrees with sortOrder — the query must sort.
      images: [
        { url: 'https://cdn.test/second.jpg', sortOrder: 2 },
        { url: 'https://cdn.test/first.jpg', sortOrder: 1 },
      ],
    })
    await makeProduct({ name: 'Unpictured', categoryId: category.id })

    const result = await listProducts(admin, { page: 1, pageSize: 50 })
    const byName = new Map(result.products.map((p) => [p.name, p]))
    expect(byName.get('Pictured')?.imageUrl).toBe('https://cdn.test/first.jpg')
    expect(byName.get('Unpictured')?.imageUrl).toBeNull()
    // The list stays minimal — the full array belongs to the detail payload only.
    expect(byName.get('Pictured')).not.toHaveProperty('images')
  })
})

describe('stock on the product payload', () => {
  it('returns no stock row for a store that has none, rather than failing', async () => {
    const category = await makeCategory('Edible', 'edible')
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    await giveStock(storeA.id, product.variants[0]!.id, 12)

    const result = await listProducts(admin, { page: 1, pageSize: 50 })
    const levels = result.products[0]!.variants[0]!.stockLevels

    // Store B genuinely has no row — this is the real shape at Ashley, and the UI must
    // render the absence as 0 rather than treating it as an error.
    expect(levels).toHaveLength(1)
    expect(levels[0]).toMatchObject({ storeId: storeA.id, quantityBase: 12 })
    expect(levels.find((l) => l.storeId === storeB.id)).toBeUndefined()
  })
})
