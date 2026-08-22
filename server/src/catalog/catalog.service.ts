import type { StockFilter, TrackingMode } from '@huta/shared'
import { assertCan, can, canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { NotFoundError } from '../errors/index.js'
import { resolveProductStock, resolveVariantStock } from './stock-status.js'
import {
  resolveVariantCannabinoids,
  resolveVariantIdentity,
} from './variant-identity.js'

/**
 * Catalog reads.
 *
 * Cost visibility is decided HERE, by choosing the Prisma `select` — not by fetching
 * everything and deleting keys on the way out. the house rules are explicit that cost must never
 * leave the database for a principal that may not see it, and a delete-on-exit approach is
 * one forgotten code path away from leaking.
 */

export interface ProductFilter {
  readonly categoryIds?: readonly string[]
  readonly cannabinoidIds?: readonly string[]
  readonly search?: string | undefined
  readonly stock?: StockFilter | undefined
  /**
   * Products bought from one supplier.
   *
   * Matches a supplier named at EITHER level, because since the strain work a variant carries
   * its own nullable `supplierId` that overrides the product's (`resolveSupplierId` in
   * `variant-identity.ts`). A flower shelf whose strains come from two distributors therefore
   * appears under both, which is the honest answer — each of them really does supply part of it.
   */
  readonly supplierId?: string | undefined
  /** Which store's numbers to show. Undefined means every active store. */
  readonly storeId?: string | undefined
  /**
   * Admin-only reach into inactive products (quick-created ones await pricing there).
   * Forced to 'true' for anyone without `catalog.manage` — no 403, no leak.
   */
  readonly active?: 'true' | 'false' | 'all' | undefined
  readonly page: number
  readonly pageSize: number
}

/**
 * Map every category to its direct children, once.
 *
 * Shared by `expandCategoryIds` and `reference()` because they need the same walk for
 * opposite reasons — one pushes a selection down the tree, the other pulls counts up it.
 * Two copies of this drifting apart is exactly how the parent chips ended up hidden.
 */
async function categoryTree(): Promise<{
  childrenOf: Map<string, string[]>
  all: Array<{ id: string; parentId: string | null }>
}> {
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } })
  const childrenOf = new Map<string, string[]>()
  for (const category of all) {
    if (!category.parentId) continue
    const siblings = childrenOf.get(category.parentId) ?? []
    siblings.push(category.id)
    childrenOf.set(category.parentId, siblings)
  }
  return { childrenOf, all }
}

/**
 * Expand selected categories to include their descendants.
 *
 * Necessary because the tree is NOT uniformly two-level: `Other` is a top-level category
 * holding 15 products directly, while every other top-level holds none. So a selection
 * must always be `[self, ...descendants]` — expanding to descendants alone would return
 * nothing for `Other`, and self alone would return nothing for `Inhalables`.
 *
 * Done in JS against the whole tree (21 rows) rather than in SQL — a recursive CTE for 21
 * rows is complexity with no payoff.
 */
export async function expandCategoryIds(selected: readonly string[]): Promise<string[]> {
  if (selected.length === 0) return []

  const { childrenOf } = await categoryTree()

  const expanded = new Set<string>()
  const walk = (id: string): void => {
    if (expanded.has(id)) return
    expanded.add(id)
    for (const child of childrenOf.get(id) ?? []) walk(child)
  }
  for (const id of selected) walk(id)

  return [...expanded]
}

function buildWhere(
  categoryIds: string[],
  filter: ProductFilter,
  active: 'true' | 'false' | 'all',
) {
  const search = filter.search?.trim()

  /*
   * Every facet is an entry in ONE top-level AND, and that is structural rather than
   * stylistic: two facets that each need an `OR` cannot both be spread as a top-level `OR`
   * key, because the second silently overwrites the first. Supplier and search are exactly
   * that pair, and composing them as sibling AND entries is what keeps
   * "Huta Essentials" AND "blue dream" from collapsing into a plain search.
   *
   * Within a facet the rules differ on purpose: categories and search OR (any match counts),
   * cannabinoids AND (a gummy containing BOTH Delta-8 and CBD).
   */
  const facets: Array<Record<string, unknown>> = []

  if (filter.cannabinoidIds && filter.cannabinoidIds.length > 0) {
    for (const id of filter.cannabinoidIds) {
      facets.push({ cannabinoids: { some: { cannabinoidId: id } } })
    }
  }

  if (filter.supplierId) {
    facets.push({
      OR: [
        { primarySupplierId: filter.supplierId },
        { variants: { some: { supplierId: filter.supplierId } } },
      ],
    })
  }

  if (search) {
    facets.push({
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { brand: { name: { contains: search, mode: 'insensitive' as const } } },
        { variants: { some: { sku: { contains: search, mode: 'insensitive' as const } } } },
        // The variant LABEL, because since 2026-08-21 a strain IS a label: Blue Dream is
        // a variant of `Regular Flower`, so without this clause the most-asked-for name
        // on the shelf matches nothing while every screen still prints it as
        // "Regular Flower · Blue Dream". Flavours and strengths ("Mango", "1000mg")
        // become searchable by the same clause.
        { variants: { some: { label: { contains: search, mode: 'insensitive' as const } } } },
        // A barcode scan types digits into the same search box — without this clause
        // the register's scan-and-stack could only ever match SKU-shaped scans.
        { variants: { some: { barcode: { contains: search } } } },
      ],
    })
  }

  return {
    ...(active === 'all' ? {} : { active: active === 'true' }),
    ...(categoryIds.length > 0 ? { categoryId: { in: categoryIds } } : {}),
    ...(facets.length > 0 ? { AND: facets } : {}),
  }
}

/** The variant `select`, with cost included only when the principal may see it. */
/**
 * @param detail  Detail pages only. Adds the strain-identity columns, the variant's own
 *   cannabinoid links and its supplier. The LIST deliberately omits them: it already ships
 *   ~135KB across 300-odd variants, and a per-variant potency join on every row would buy
 *   nothing — no list surface renders potency, and the inspector that does fetches the
 *   detail payload anyway.
 */
function variantSelect(principal: Principal, detail = false) {
  return {
    id: true,
    sku: true,
    barcode: true,
    label: true,
    trackingMode: true,
    priceCents: true,
    taxable: true,
    active: true,
    minSaleBase: true,
    maxSaleBase: true,
    // Strain identity, resolved against the product by resolveVariantIdentity(). Selected
    // RAW so the resolver can report which side each value came from; callers that only
    // render the answer read the resolved block, never these columns.
    ...(detail
      ? {
          strainType: true as const,
          terpeneProfile: true as const,
          nose: true as const,
          coaUrl: true as const,
          description: true as const,
          supplier: { select: { id: true, name: true } },
          cannabinoids: {
            select: {
              mgPerUnit: true,
              percentBps: true,
              cannabinoid: { select: { id: true, name: true, slug: true, sortOrder: true } },
            },
            orderBy: { cannabinoid: { sortOrder: 'asc' as const } },
          },
        }
      : {}),
    // The ONE place cost is decided. Everything downstream simply never receives it.
    ...(canSeeCost(principal) ? { costCents: true } : {}),
    priceGroup: {
      select: {
        id: true,
        name: true,
        slug: true,
        basePricePerGramCents: true,
        tiers: {
          select: { minQuantityBase: true, totalPriceCents: true },
          orderBy: { minQuantityBase: 'asc' as const },
        },
      },
    },
    stockLevels: {
      select: { storeId: true, quantityBase: true, reorderPointBase: true },
    },
  }
}

/**
 * Variant display order.
 *
 * NOT by SKU. Every SKU in this database is a legacy id, so ordering by it rendered Naysa
 * CBD Drops as 3500 · 250 · 5000 · 900 · 1500 · 1000 — a potency ladder in arbitrary
 * order, on the one product family where the variant axis is the entire point.
 *
 * Price ascending is the universal rule: it agrees with potency almost always, and it
 * still produces a sensible order when the label is "Blue Raspberry" or "2 Pack", which
 * parsing mg out of the label does not. `nulls: 'last'` matters because WEIGHT variants
 * have no `priceCents` at all — they price through a group.
 */
const VARIANT_ORDER = [
  { priceCents: { sort: 'asc' as const, nulls: 'last' as const } },
  { label: { sort: 'asc' as const, nulls: 'last' as const } },
  { sku: 'asc' as const },
]

/**
 * Which stores' numbers this request sees.
 *
 * The catalog's store selector is a view over the read-only cross-store stock lookup that
 * the permission matrix grants to everyone, so this is not `scopeStoreId` — that helper throws for an
 * admin naming no store, which is right for a store-scoped write and wrong for a
 * deliberately cross-store read. The capability check stays explicit rather than implied.
 */
export async function resolveStoreIds(
  principal: Principal,
  requestedStoreId: string | undefined,
): Promise<Array<{ id: string; name: string }>> {
  const stores = await prisma.store.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  if (requestedStoreId === undefined) {
    if (stores.length > 1) assertCan(principal, 'inventory.view.other')
    return stores
  }

  const match = stores.find((s) => s.id === requestedStoreId)
  if (!match) throw new NotFoundError('That store does not exist.')
  if (principal.storeId !== requestedStoreId) assertCan(principal, 'inventory.view.other')
  return [match]
}

/** The minimal shape needed to judge stock, without pulling prices or cost. */
const STOCK_SHAPE = {
  id: true,
  category: { select: { defaultReorderBase: true } },
  variants: {
    where: { active: true },
    select: {
      trackingMode: true,
      stockLevels: { select: { storeId: true, quantityBase: true, reorderPointBase: true } },
    },
  },
} as const

type StockShape = {
  id: string
  category: { defaultReorderBase: number | null }
  variants: Array<{
    trackingMode: TrackingMode
    stockLevels: Array<{ storeId: string; quantityBase: number; reorderPointBase: number | null }>
  }>
}

function judge(product: StockShape, storeIds: readonly string[]) {
  const variants = product.variants.map((v) =>
    resolveVariantStock(
      {
        trackingMode: v.trackingMode,
        stockLevels: v.stockLevels,
        categoryDefaultReorderBase: product.category.defaultReorderBase,
      },
      storeIds,
    ),
  )
  return {
    variants,
    product: resolveProductStock(
      variants,
      product.variants.map((v) => v.trackingMode),
      storeIds,
    ),
  }
}

/**
 * Product ids matching a stock filter, or null when there is no stock filter.
 *
 * Two queries rather than one, because "below reorder" compares an aggregate quantity
 * against a threshold that falls back through the category — not something a Prisma
 * `where` can express. The extra query reads ~300 rows and is measured in single-digit
 * milliseconds at this catalog size; revisit if it ever stops being.
 */
async function productIdsByStock(
  where: ReturnType<typeof buildWhere>,
  storeIds: readonly string[],
  stock: StockFilter | undefined,
): Promise<string[] | null> {
  if (stock === undefined || stock === 'all') return null

  const candidates = (await prisma.product.findMany({ where, select: STOCK_SHAPE })) as StockShape[]

  return candidates
    .filter((p) => {
      // A product with no active variants has nothing to be out OF, so it matches no
      // stock filter rather than counting as out of stock.
      if (p.variants.length === 0) return false
      // Quantity-based, not status-based: the roll-up status is worst-of-variants, so a
      // product can be OUT (one empty variant) while another variant holds real stock.
      if (stock === 'on-hand') {
        return p.variants.some((v) =>
          v.stockLevels.some((sl) => storeIds.includes(sl.storeId) && sl.quantityBase > 0),
        )
      }
      const { product } = judge(p, storeIds)
      return stock === 'out' ? product.status === 'OUT' : product.status === 'LOW'
    })
    .map((p) => p.id)
}

export async function listProducts(principal: Principal, filter: ProductFilter) {
  const stores = await resolveStoreIds(principal, filter.storeId)
  const storeIds = stores.map((s) => s.id)

  const categoryIds = await expandCategoryIds(filter.categoryIds ?? [])
  const active = can(principal, 'catalog.manage') ? (filter.active ?? 'true') : 'true'
  const baseWhere = buildWhere(categoryIds, filter, active)

  const stockIds = await productIdsByStock(baseWhere, storeIds, filter.stock)
  const where = stockIds === null ? baseWhere : { ...baseWhere, id: { in: stockIds } }

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      select: {
        id: true,
        name: true,
        slug: true,
        active: true,
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            defaultReorderBase: true,
            parent: { select: { id: true, name: true, slug: true } },
          },
        },
        brand: { select: { id: true, name: true } },
        primarySupplier: { select: { id: true, name: true } },
        images: { select: { url: true }, orderBy: { sortOrder: 'asc' as const }, take: 1 },
        cannabinoids: {
          select: {
            mgPerUnit: true,
            percentBps: true,
            cannabinoid: { select: { id: true, name: true, slug: true, sortOrder: true } },
          },
          orderBy: { cannabinoid: { sortOrder: 'asc' } },
        },
        variants: {
          where: { active: true },
          select: variantSelect(principal),
          orderBy: VARIANT_ORDER,
        },
      },
    }),
  ])

  return {
    products: products.map(({ images, ...p }) => ({
      ...withStock(p, storeIds),
      imageUrl: images[0]?.url ?? null,
    })),
    stores,
    total,
    page: filter.page,
    pageSize: filter.pageSize,
    pageCount: Math.max(1, Math.ceil(total / filter.pageSize)),
  }
}

/** Attach resolved stock to each variant and roll the product up from them. */
function withStock<
  P extends {
    category: { defaultReorderBase: number | null }
    variants: ReadonlyArray<{
      trackingMode: TrackingMode
      stockLevels: ReadonlyArray<{
        storeId: string
        quantityBase: number
        reorderPointBase: number | null
      }>
    }>
  },
>(product: P, storeIds: readonly string[]) {
  const variantStocks = product.variants.map((v) =>
    resolveVariantStock(
      {
        trackingMode: v.trackingMode,
        stockLevels: v.stockLevels,
        categoryDefaultReorderBase: product.category.defaultReorderBase,
      },
      storeIds,
    ),
  )

  return {
    ...product,
    variants: product.variants.map((v, i) => ({ ...v, stock: variantStocks[i]! })),
    stock: resolveProductStock(
      variantStocks,
      product.variants.map((v) => v.trackingMode),
      storeIds,
    ),
  }
}

export async function getProduct(principal: Principal, id: string, storeId?: string) {
  const stores = await resolveStoreIds(principal, storeId)

  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      coaUrl: true,
      active: true,
      strainType: true,
      terpeneProfile: true,
      nose: true,
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
          defaultReorderBase: true,
          parent: { select: { id: true, name: true, slug: true } },
        },
      },
      brand: { select: { id: true, name: true } },
      primarySupplier: { select: { id: true, name: true } },
      images: { select: { url: true, alt: true }, orderBy: { sortOrder: 'asc' } },
      cannabinoids: {
        select: {
          mgPerUnit: true,
          percentBps: true,
          cannabinoid: { select: { id: true, name: true, slug: true, sortOrder: true } },
        },
        orderBy: { cannabinoid: { sortOrder: 'asc' } },
      },
      variants: {
        // Admins see inactive variants too — a quick-created variant's stock is real stock
        // and the editor is the only place it can be priced and activated. Staff and
        // terminals keep the selling view.
        where: can(principal, 'catalog.manage') ? {} : { active: true },
        select: variantSelect(principal, true),
        orderBy: VARIANT_ORDER,
      },
    },
  })

  if (!product) throw new NotFoundError('That product does not exist.')

  const shaped = withStock(product, stores.map((s) => s.id))
  return {
    ...shaped,
    /**
     * Each variant carries its identity ALREADY RESOLVED against the product, so no client
     * re-implements the fallback and no screen can disagree with checkout about which
     * supplier or potency a strain has. The raw columns are dropped on the way out — a
     * caller reading `variant.strainType` directly would silently get the un-inherited
     * value, which is the bug this whole module exists to prevent.
     */
    variants: shaped.variants.map((v) => {
      const { strainType, terpeneProfile, nose, coaUrl, description, cannabinoids, supplier, ...rest } =
        v as typeof v & {
          strainType?: string | null
          terpeneProfile?: string | null
          nose?: string | null
          coaUrl?: string | null
          description?: string | null
          cannabinoids?: readonly { mgPerUnit: number | null, percentBps: number | null, cannabinoid: { id: string, name: string, slug: string, sortOrder: number } }[]
          supplier?: { id: string, name: string } | null
        }
      const potency = resolveVariantCannabinoids(cannabinoids, product.cannabinoids)
      return {
        ...rest,
        identity: {
          ...resolveVariantIdentity(
            { strainType, terpeneProfile, nose, coaUrl, description },
            product,
          ),
          cannabinoids: potency.links,
          cannabinoidSource: potency.source,
          supplier: supplier ?? product.primarySupplier,
          supplierSource: supplier ? ('variant' as const) : ('product' as const),
        },
      }
    }),
    imageUrl: product.images[0]?.url ?? null,
    stores,
  }
}

/**
 * Filter options with live counts.
 *
 * Counts come from the database rather than `CATEGORY_SEED`, because the seed constants
 * carry no ids and no counts — the house rules are explicit that the database is authoritative at
 * runtime and the constants exist for the seed script.
 */
export async function reference() {
  const [categories, cannabinoids, stores, brands, tree] = await Promise.all([
    prisma.category.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        slug: true,
        parentId: true,
        sortOrder: true,
        _count: { select: { products: true } },
      },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.cannabinoid.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        slug: true,
        sortOrder: true,
        _count: { select: { products: true } },
      },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.brand.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    categoryTree(),
  ])

  const directCount = new Map(categories.map((c) => [c.id, c._count.products]))

  /**
   * Roll each node's count up over its descendants.
   *
   * `_count.products` is the DIRECT count, which is zero for all five real parents — and
   * the filter bar hid any chip whose count was zero, so Inhalables and its siblings never
   * rendered and `expandCategoryIds` had nothing that could invoke it. A parent's count
   * must describe what selecting it actually returns, which is self plus descendants.
   */
  const rolledUp = (id: string): number =>
    (directCount.get(id) ?? 0) +
    (tree.childrenOf.get(id) ?? []).reduce((sum, child) => sum + rolledUp(child), 0)

  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
      productCount: rolledUp(c.id),
      directProductCount: c._count.products,
    })),
    cannabinoids: cannabinoids.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      productCount: c._count.products,
    })),
    stores,
    brands,
  }
}

/**
 * Counts for the filter rail's stock chips (and the header's product count).
 *
 * No money, by decision: inventory valuation is cost-derived and therefore admin-only, and
 * a payload that renders differently per role is a payload that leaks the difference. Valuation
 * belongs on the Phase 11 reporting dashboard, which is admin-gated as a whole. Everything
 * here is a count, so this endpoint needs no cost gating at all.
 */
export async function summary(principal: Principal, storeId?: string) {
  const stores = await resolveStoreIds(principal, storeId)
  const storeIds = stores.map((s) => s.id)

  const products = (await prisma.product.findMany({
    where: { active: true },
    select: STOCK_SHAPE,
  })) as StockShape[]

  let variants = 0
  let outOfStock = 0
  let belowReorder = 0
  let productsOutOfStock = 0
  let productsBelowReorder = 0
  let productsOnHand = 0

  for (const product of products) {
    if (product.variants.length === 0) continue
    const judged = judge(product, storeIds)

    variants += judged.variants.length
    for (const v of judged.variants) {
      if (v.status === 'OUT') outOfStock += 1
      else if (v.status === 'LOW') belowReorder += 1
    }

    if (judged.product.status === 'OUT') productsOutOfStock += 1
    else if (judged.product.status === 'LOW') productsBelowReorder += 1

    // Same quantity-based predicate as the 'on-hand' filter, so the chip's count can
    // never disagree with what selecting it returns.
    if (
      product.variants.some((v) =>
        v.stockLevels.some((sl) => storeIds.includes(sl.storeId) && sl.quantityBase > 0),
      )
    ) {
      productsOnHand += 1
    }
  }

  return {
    products: products.length,
    variants,
    outOfStock,
    belowReorder,
    productsOutOfStock,
    productsBelowReorder,
    productsOnHand,
  }
}
