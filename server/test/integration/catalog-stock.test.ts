import { Role, TrackingMode } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { listProducts, reference, summary } from '../../src/catalog/catalog.service.js'
import {
  giveStock,
  makeCategory,
  makeProduct,
  makeStore,
  resetDatabase,
} from '../setup/factories.js'

/**
 * The catalog UI pass: rolled-up category counts, resolved stock status, and the stock
 * filter. Each of these replaces something the old screen either got wrong or could not
 * express at all.
 */

let storeA: { id: string; name: string }
let storeB: { id: string; name: string }
let admin: AdminPrincipal
let staff: StaffPrincipal

beforeEach(async () => {
  await resetDatabase()
  // Named so `orderBy: { name: 'asc' }` puts A first and column order is predictable.
  storeA = await makeStore('Alpha Store', 'alpha')
  storeB = await makeStore('Beta Store', 'beta')

  admin = { kind: 'admin', userId: 'u-admin', role: Role.ADMIN, storeId: null, terminalId: null }
  staff = {
    kind: 'staff',
    userId: 'u-staff',
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: 't-1',
  }
})

const PAGE = { page: 1, pageSize: 50 }

describe('category counts', () => {
  it('rolls a parent count up over its descendants', async () => {
    // This is the bug that hid every parent chip: products are filed on the LEAVES, so a
    // parent's direct count is zero, and the filter bar dropped any facet counting zero.
    const parent = await makeCategory('Inhalables', 'inhalables')
    const cartridge = await makeCategory('Cartridge', 'cartridge', parent.id)
    const dab = await makeCategory('Dab', 'dab', parent.id)

    await makeProduct({ name: 'Cart A', categoryId: cartridge.id })
    await makeProduct({ name: 'Cart B', categoryId: cartridge.id })
    await makeProduct({ name: 'Dab A', categoryId: dab.id })

    const ref = await reference()
    const inhalables = ref.categories.find((c) => c.id === parent.id)

    expect(inhalables?.directProductCount).toBe(0)
    expect(inhalables?.productCount).toBe(3)
  })

  it('counts a top-level node that holds products directly', async () => {
    // `Other` is the shape that breaks a "parents are always headings" assumption: a
    // top-level category with products of its own and no children at all.
    const other = await makeCategory('Other', 'other')
    await makeProduct({ name: 'Torch', categoryId: other.id })

    const ref = await reference()
    const node = ref.categories.find((c) => c.id === other.id)

    expect(node?.directProductCount).toBe(1)
    expect(node?.productCount).toBe(1)
  })

  it('selecting a parent returns everything beneath it', async () => {
    const parent = await makeCategory('Inhalables', 'inhalables')
    const cartridge = await makeCategory('Cartridge', 'cartridge', parent.id)
    const unrelated = await makeCategory('Edible', 'edible')

    await makeProduct({ name: 'Cart A', categoryId: cartridge.id })
    await makeProduct({ name: 'Gummy', categoryId: unrelated.id })

    const result = await listProducts(admin, { ...PAGE, categoryIds: [parent.id] })

    expect(result.total).toBe(1)
    expect(result.products[0]?.name).toBe('Cart A')
  })
})

describe('stock status', () => {
  it('is OUT when a store has no stock row at all, not unknown', async () => {
    // Ashley had no StockLevel rows in production, so this is the common case rather than
    // an edge one. Absent must read as zero.
    const category = await makeCategory('Edible', 'edible', undefined, 6)
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })

    const result = await listProducts(admin, { ...PAGE })
    const variant = result.products[0]?.variants[0]

    expect(variant?.stock.status).toBe('OUT')
    expect(variant?.stock.quantityBase).toBe(0)
    expect(variant?.stock.byStore).toHaveLength(2)
    expect(variant?.stock.byStore.every((s) => s.quantityBase === 0)).toBe(true)
    expect(product.variants[0]).toBeDefined()
  })

  it('falls back to the category default when the stock row sets no reorder point', async () => {
    const category = await makeCategory('Edible', 'edible', undefined, 6)
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    const variantId = product.variants[0]!.id

    // 4 total against a threshold of 6 per store = 12 combined. Below it.
    await giveStock(storeA.id, variantId, 4)

    const result = await listProducts(admin, { ...PAGE })
    const stock = result.products[0]!.variants[0]!.stock

    expect(stock.quantityBase).toBe(4)
    expect(stock.reorderBase).toBe(12)
    expect(stock.status).toBe('LOW')
  })

  it('cannot be LOW when neither the stock row nor the category sets a threshold', async () => {
    // Honest by design: with no reorder point recorded anywhere, "below reorder" would be
    // a guess dressed as a fact. Only OUT is knowable.
    const category = await makeCategory('Novelty', 'novelty')
    const product = await makeProduct({ name: 'Torch', categoryId: category.id })
    await giveStock(storeA.id, product.variants[0]!.id, 1)

    const stock = (await listProducts(admin, { ...PAGE })).products[0]!.variants[0]!.stock

    expect(stock.reorderBase).toBeNull()
    expect(stock.status).toBe('OK')
  })

  it('judges a WEIGHT variant in milligrams, not against a bare 3', async () => {
    // The old cell compared raw base units against a hardcoded 3, so a gram of flower —
    // 1000 base units — read as healthy and only turned amber at 3mg.
    const flower = await makeCategory('Flower', 'flower', undefined, 14_000)
    const product = await makeProduct({
      name: 'Blue Dream',
      categoryId: flower.id,
      variants: [{ trackingMode: TrackingMode.WEIGHT }],
    })
    // One gram, at a store whose reorder point is half an ounce.
    await giveStock(storeA.id, product.variants[0]!.id, 1_000)

    const stock = (await listProducts(admin, { ...PAGE })).products[0]!.variants[0]!.stock

    expect(stock.quantityBase).toBe(1_000)
    expect(stock.reorderBase).toBe(28_000)
    expect(stock.status).toBe('LOW')
  })

  it('rolls a product up to its WORST variant', async () => {
    // Five healthy potencies and one at zero is a product that needs attention. A row
    // reporting OK would hide the only fact worth acting on.
    const category = await makeCategory('Tincture', 'tincture', undefined, 3)
    const product = await makeProduct({
      name: 'Drops',
      categoryId: category.id,
      variants: [{ label: '250mg', priceCents: 3999 }, { label: '1000mg', priceCents: 6999 }],
    })
    await giveStock(storeA.id, product.variants[0]!.id, 50)
    await giveStock(storeB.id, product.variants[0]!.id, 50)
    // Second variant left with no stock at all.

    const rolled = (await listProducts(admin, { ...PAGE })).products[0]!.stock

    expect(rolled.status).toBe('OUT')
    expect(rolled.outCount).toBe(1)
    expect(rolled.variantCount).toBe(2)
  })

  it('reports no total for a product mixing EACH and WEIGHT variants', async () => {
    // House rule: "units sold is meaningless across a gummy and a gram."
    const category = await makeCategory('Odd', 'odd')
    const product = await makeProduct({
      name: 'Mixed',
      categoryId: category.id,
      variants: [{ priceCents: 1000 }, { trackingMode: TrackingMode.WEIGHT }],
    })
    await giveStock(storeA.id, product.variants[0]!.id, 5)
    await giveStock(storeA.id, product.variants[1]!.id, 3_500)

    const rolled = (await listProducts(admin, { ...PAGE })).products[0]!.stock

    expect(rolled.quantityBase).toBeNull()
    expect(rolled.trackingMode).toBeNull()
  })

  it('changes with the store scope', async () => {
    const category = await makeCategory('Edible', 'edible', undefined, 6)
    const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
    await giveStock(storeA.id, product.variants[0]!.id, 40)

    const both = await listProducts(admin, { ...PAGE })
    expect(both.products[0]!.variants[0]!.stock.status).toBe('OK')

    // Beta has none of it, so scoped to Beta the same variant is out.
    const beta = await listProducts(admin, { ...PAGE, storeId: storeB.id })
    expect(beta.products[0]!.variants[0]!.stock.status).toBe('OUT')
    expect(beta.products[0]!.variants[0]!.stock.byStore).toHaveLength(1)
    expect(beta.stores.map((s) => s.name)).toEqual(['Beta Store'])
  })
})

describe('stock filter', () => {
  beforeEach(async () => {
    const category = await makeCategory('Edible', 'edible', undefined, 6)
    const healthy = await makeProduct({ name: 'Healthy', categoryId: category.id })
    const low = await makeProduct({ name: 'Low', categoryId: category.id })
    await makeProduct({ name: 'Empty', categoryId: category.id })

    await giveStock(storeA.id, healthy.variants[0]!.id, 100)
    await giveStock(storeA.id, low.variants[0]!.id, 2)
  })

  it('returns only out-of-stock products', async () => {
    const result = await listProducts(admin, { ...PAGE, stock: 'out' })
    expect(result.products.map((p) => p.name)).toEqual(['Empty'])
    expect(result.total).toBe(1)
  })

  it('returns only below-reorder products, excluding the ones at zero', async () => {
    const result = await listProducts(admin, { ...PAGE, stock: 'low' })
    expect(result.products.map((p) => p.name)).toEqual(['Low'])
  })

  it('returns everything when the filter is absent or "all"', async () => {
    expect((await listProducts(admin, { ...PAGE })).total).toBe(3)
    expect((await listProducts(admin, { ...PAGE, stock: 'all' })).total).toBe(3)
  })

  it('"on-hand" is quantity-based, so a worst-OUT product with real stock still matches', async () => {
    const category = await makeCategory('Vape', 'vape')
    // One variant holds stock, the other sits at zero: the roll-up status is OUT
    // (worst-of-variants), but there IS product on the shelf.
    const split = await makeProduct({
      name: 'Split',
      categoryId: category.id,
      variants: [{ priceCents: 1000 }, { priceCents: 2000 }],
    })
    await giveStock(storeA.id, split.variants[0]!.id, 5)

    const onHand = await listProducts(admin, { ...PAGE, stock: 'on-hand' })
    expect(onHand.products.map((p) => p.name).sort()).toEqual(['Healthy', 'Low', 'Split'])

    // The same product ALSO matches 'out' — both filters are telling the truth.
    const out = await listProducts(admin, { ...PAGE, stock: 'out' })
    expect(out.products.map((p) => p.name).sort()).toEqual(['Empty', 'Split'])
  })

  it('composes with the category and cannabinoid facets', async () => {
    const other = await makeCategory('Other', 'other')
    await makeProduct({ name: 'Also Empty', categoryId: other.id })

    const all = await listProducts(admin, { ...PAGE, stock: 'out' })
    expect(all.total).toBe(2)

    const scoped = await listProducts(admin, { ...PAGE, stock: 'out', categoryIds: [other.id] })
    expect(scoped.products.map((p) => p.name)).toEqual(['Also Empty'])
  })
})

describe('variant ordering', () => {
  it('orders by price ascending, never by SKU', async () => {
    // The production symptom: every SKU is a legacy id, so Naysa CBD Drops rendered
    // 3500 · 250 · 5000 · 900 · 1500 · 1000. The factory assigns descending SKUs on
    // purpose, so an ordering that fell back to SKU would reverse this list.
    const category = await makeCategory('Tincture', 'tincture')
    await makeProduct({
      name: 'Drops',
      categoryId: category.id,
      variants: [
        { label: '250mg', priceCents: 3999 },
        { label: '900mg', priceCents: 6999 },
        { label: '1500mg', priceCents: 8999 },
        { label: '5000mg', priceCents: 13_999 },
      ],
    })

    const result = await listProducts(admin, { ...PAGE })

    expect(result.products[0]!.variants.map((v) => v.label)).toEqual([
      '250mg',
      '900mg',
      '1500mg',
      '5000mg',
    ])
  })

  it('puts a WEIGHT variant last rather than first, since it has no per-item price', async () => {
    // `nulls: 'last'`. Postgres sorts NULLs last on ASC by default, but relying on a
    // default that differs by direction is how this breaks the day someone adds DESC.
    const category = await makeCategory('Mixed', 'mixed')
    await makeProduct({
      name: 'Range',
      categoryId: category.id,
      variants: [
        { label: 'Bulk', trackingMode: TrackingMode.WEIGHT },
        { label: 'Single', priceCents: 500 },
      ],
    })

    const variants = (await listProducts(admin, { ...PAGE })).products[0]!.variants
    expect(variants.map((v) => v.label)).toEqual(['Single', 'Bulk'])
  })
})

describe('summary', () => {
  it('counts variants and products by status, and carries no money', async () => {
    const category = await makeCategory('Edible', 'edible', undefined, 6)
    const healthy = await makeProduct({ name: 'Healthy', categoryId: category.id })
    const low = await makeProduct({ name: 'Low', categoryId: category.id })
    await makeProduct({ name: 'Empty', categoryId: category.id, costCents: 500 })

    await giveStock(storeA.id, healthy.variants[0]!.id, 100)
    await giveStock(storeA.id, low.variants[0]!.id, 2)

    const result = await summary(admin)

    expect(result.products).toBe(3)
    expect(result.variants).toBe(3)
    expect(result.outOfStock).toBe(1)
    expect(result.belowReorder).toBe(1)
    expect(result.productsOutOfStock).toBe(1)
    expect(result.productsBelowReorder).toBe(1)

    // The decision was counts only. A money field appearing here would need a capability
    // check and a staff-payload test, so fail loudly if one is ever added silently.
    expect(Object.keys(result).some((k) => /cost|value|margin|price/i.test(k))).toBe(false)
  })

  it('is identical for a staff principal, because it carries no cost-derived figure', async () => {
    const category = await makeCategory('Edible', 'edible', undefined, 6)
    await makeProduct({ name: 'Gummies', categoryId: category.id, costCents: 500 })

    expect(await summary(staff, storeA.id)).toEqual(await summary(admin, storeA.id))
  })
})
