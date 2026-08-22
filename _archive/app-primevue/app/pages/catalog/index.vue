<script setup lang="ts">
import {
  STOCK_FILTERS,
  type StockFilter,
  TrackingMode,
  formatCents,
  formatQuantity,
  unsafe,
} from '@huta/shared'
import type { CatalogProduct, CatalogVariant } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { useAuthStore } from '~/stores/auth'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Catalog — filter rail and a table that answers the two questions the screen exists
 * for: what does this cost, and what have we run out of.
 *
 * The previous version could answer neither. Price appeared only on an expanded variant
 * row, and the expander rendered only for multi-variant products, so for 267 of 284
 * products price cost a navigation. There was no stock filter at all while 124 of 309
 * variants sat at zero.
 */

const catalog = useCatalogStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const expanded = ref(new Set<string>())

/** Filter state lives in the URL so a view can be shared or restored. */
function readParam(key: string): string[] {
  const value = route.query[key]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

function readStock(): StockFilter {
  const raw = route.query['stock']
  return typeof raw === 'string' && (STOCK_FILTERS as readonly string[]).includes(raw)
    ? (raw as StockFilter)
    : 'all'
}

const categories = ref<string[]>(readParam('categories'))
const cannabinoids = ref<string[]>(readParam('cannabinoids'))
const search = ref((route.query['search'] as string) ?? '')
const stock = ref<StockFilter>(readStock())
const showInactive = ref(route.query['active'] === 'all')
const page = ref(Number(route.query['page'] ?? 1))

await catalog.loadReference()

// Null is the combined view, and it is the default — an admin has no home store.
catalog.selectedStoreId = (route.query['storeId'] as string) ?? null

const stores = computed(() => catalog.visibleStores)

const scopeLabel = computed(() => {
  if (catalog.selectedStoreId === null) {
    return catalog.stores.length > 1 ? 'All stores combined' : (catalog.stores[0]?.name ?? '—')
  }
  return catalog.stores.find((s) => s.id === catalog.selectedStoreId)?.name ?? '—'
})

const filters = computed(() => ({
  categories: categories.value,
  cannabinoids: cannabinoids.value,
  search: search.value,
  stock: stock.value,
  storeId: catalog.selectedStoreId,
  ...(showInactive.value ? { active: 'all' as const } : {}),
  page: page.value,
}))

/** Fetch for the current filter state, without touching the URL. */
async function runSearch(): Promise<void> {
  await catalog.search(filters.value)
}

/**
 * Write the filter state to the URL, then fetch.
 *
 * Only ever called from a user action. Calling `router.replace` during setup raced the
 * router's own initial navigation and silently dropped the query — so opening a shared
 * filtered link showed all 284 products with no facets lit, which looked like the filters
 * were broken rather than the URL being clobbered.
 */
async function apply(resetPage = true): Promise<void> {
  if (resetPage) page.value = 1
  await router.replace({
    query: {
      ...(categories.value.length > 0 ? { categories: categories.value } : {}),
      ...(cannabinoids.value.length > 0 ? { cannabinoids: cannabinoids.value } : {}),
      ...(search.value ? { search: search.value } : {}),
      ...(stock.value !== 'all' ? { stock: stock.value } : {}),
      ...(catalog.selectedStoreId ? { storeId: catalog.selectedStoreId } : {}),
      ...(showInactive.value ? { active: 'all' } : {}),
      ...(page.value > 1 ? { page: String(page.value) } : {}),
    },
  })
  await runSearch()
}

function toggle(list: 'categories' | 'cannabinoids', id: string): void {
  const target = list === 'categories' ? categories : cannabinoids
  const next = new Set(target.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  target.value = [...next]
  void apply()
}

function setStock(value: StockFilter): void {
  stock.value = value
  void apply()
}

/** Admin-only reach into inactive products — quick-created ones await pricing there. */
function toggleInactive(): void {
  showInactive.value = !showInactive.value
  void apply()
}

/** Changing the store scope changes the summary too — every count is store-relative. */
async function setStore(id: string | null): Promise<void> {
  catalog.selectedStoreId = id
  await Promise.all([apply(), catalog.loadSummary(id)])
}

function clearAll(): void {
  categories.value = []
  cannabinoids.value = []
  search.value = ''
  stock.value = 'all'
  void apply()
}

const hasFilters = computed(
  () =>
    categories.value.length > 0 ||
    cannabinoids.value.length > 0 ||
    search.value !== '' ||
    stock.value !== 'all',
)

/** Applied filters as removable pills, so what is on is visible without reading the rail. */
const appliedPills = computed(() => {
  const byId = new Map((catalog.reference?.categories ?? []).map((c) => [c.id, c.name]))
  const cann = new Map((catalog.reference?.cannabinoids ?? []).map((c) => [c.id, c.name]))
  const pills: Array<{ key: string; group: string; label: string; drop: () => void }> = []

  for (const id of categories.value) {
    pills.push({
      key: `cat:${id}`,
      group: 'Category',
      label: byId.get(id) ?? id,
      drop: () => toggle('categories', id),
    })
  }
  for (const id of cannabinoids.value) {
    pills.push({
      key: `cann:${id}`,
      group: 'Cannabinoid',
      label: cann.get(id) ?? id,
      drop: () => toggle('cannabinoids', id),
    })
  }
  if (stock.value !== 'all') {
    pills.push({
      key: 'stock',
      group: 'Stock',
      label: stock.value === 'out' ? 'Out of stock' : 'Below reorder',
      drop: () => setStock('all'),
    })
  }
  if (search.value) {
    pills.push({
      key: 'search',
      group: 'Search',
      label: search.value,
      drop: () => {
        search.value = ''
        void apply()
      },
    })
  }
  return pills
})

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void apply(), 250)
})

function toggleRow(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/**
 * Products whose image URL failed to load. The catalog's images are hot-linked legacy
 * URLs, so 404s and hotlink blocking are expected — a failed image swaps to the same
 * placeholder tile an imageless product gets, instead of a broken-image glyph.
 */
const imgFailed = ref(new Set<string>())

function markImgFailed(id: string): void {
  const next = new Set(imgFailed.value)
  next.add(id)
  imgFailed.value = next
}

/**
 * A WEIGHT variant has no `priceCents` — its price comes from the price group's per-gram
 * rate, with tiers on top. Reading `priceCents` directly would render "—" for flower.
 */
function variantPrice(variant: CatalogVariant): string {
  if (variant.trackingMode === TrackingMode.WEIGHT) {
    const rate = variant.priceGroup?.basePricePerGramCents
    if (rate === undefined) return '—'
    const suffix = (variant.priceGroup?.tiers.length ?? 0) > 0 ? ' · tiered' : ''
    return `${formatCents(unsafe.cents(rate))}/g${suffix}`
  }
  return variant.priceCents === null ? '—' : formatCents(unsafe.cents(variant.priceCents))
}

/**
 * The product row's price: a single price, or the range its variants span.
 *
 * Formatting a min and a max of prices the server already sent — not deriving a price to
 * charge, which is always the server's job. A WEIGHT product falls through to its
 * variant's per-gram rate rather than being mixed into a range, because a per-gram rate
 * and a per-item price are not the same kind of number.
 */
function productPrice(product: CatalogProduct): string {
  const first = product.variants[0]
  if (!first) return '—'
  if (product.variants.length === 1) return variantPrice(first)

  const prices = product.variants
    .map((v) => v.priceCents)
    .filter((p): p is number => p !== null)

  if (prices.length === 0) return variantPrice(first)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  return min === max
    ? formatCents(unsafe.cents(min))
    : `${formatCents(unsafe.cents(min))} – ${formatCents(unsafe.cents(max))}`
}

/** Cost is absent entirely for a staff principal — optional key, not a null. */
function productCost(product: CatalogProduct): string | null {
  const costs = product.variants
    .map((v) => v.costCents)
    .filter((c): c is number => c !== null && c !== undefined)

  if (costs.length === 0) return null
  const min = Math.min(...costs)
  const max = Math.max(...costs)
  return min === max
    ? formatCents(unsafe.cents(min))
    : `${formatCents(unsafe.cents(min))} – ${formatCents(unsafe.cents(max))}`
}

/** Whether cost is visible at all — drives the column, not just the cell. */
const showCost = computed(() =>
  (catalog.page?.products ?? []).some((p) => p.variants.some((v) => v.costCents !== undefined)),
)

function qty(base: number, mode: TrackingMode | null): string {
  return formatQuantity(unsafe.baseQuantity(base), mode ?? TrackingMode.EACH)
}

/**
 * The product row's badge text.
 *
 * A product's status is its WORST variant, so a tincture family with four healthy
 * potencies and two at zero is OUT while still holding 19 units. A bare "Out" beside "19"
 * reads as a contradiction; "2 of 6 out" says what is actually true.
 */
function rollupLabel(product: CatalogProduct): string | null {
  if (product.stock.variantCount <= 1) return null
  if (product.stock.status === 'OUT') {
    return `${product.stock.outCount} of ${product.stock.variantCount} out`
  }
  return null
}

function variantName(variant: CatalogVariant): string {
  return variant.label ?? variant.sku
}

function openProduct(product: CatalogProduct): void {
  void router.push(`/catalog/products/${product.id}`)
}

const showingRange = computed(() => {
  const p = catalog.page
  if (!p || p.total === 0) return null
  const first = (p.page - 1) * p.pageSize + 1
  const last = Math.min(p.page * p.pageSize, p.total)
  return `Showing ${first}–${last} of ${p.total}`
})

await Promise.all([runSearch(), catalog.loadSummary(catalog.selectedStoreId)])
</script>

<template>
  <section class="catalog">
    <header class="head">
      <h1>Catalog</h1>
      <span v-if="catalog.summary" class="count">
        {{ catalog.summary.products }} products · {{ scopeLabel }}
      </span>
    </header>

    <div class="body">
      <aside class="rail">
        <InputText v-model="search" placeholder="Search name, brand or SKU" class="search" />

        <!--
          A vertical list, not a segmented control: three buttons across a 14rem rail
          truncated "Main Store (Baytree)" to "Main St…", which is not a store anyone can
          recognise at a glance.
        -->
        <div v-if="catalog.stores.length > 1" class="group">
          <div class="key">Store</div>
          <div class="stocklist" role="group" aria-label="Filter by store">
            <button
              type="button"
              class="node"
              :class="{ on: catalog.selectedStoreId === null }"
              :aria-pressed="catalog.selectedStoreId === null"
              @click="setStore(null)"
            >
              <span>All stores</span>
            </button>
            <button
              v-for="store in catalog.stores"
              :key="store.id"
              type="button"
              class="node"
              :class="{ on: catalog.selectedStoreId === store.id }"
              :aria-pressed="catalog.selectedStoreId === store.id"
              @click="setStore(store.id)"
            >
              <span>{{ store.name }}</span>
            </button>
          </div>
        </div>

        <div class="group">
          <div class="key">Stock</div>
          <div class="stocklist" role="group" aria-label="Filter by stock status">
            <button
              type="button"
              class="node"
              :class="{ on: stock === 'all' }"
              :aria-pressed="stock === 'all'"
              @click="setStock('all')"
            >
              <span>All</span>
              <span class="n">{{ catalog.summary?.products ?? '' }}</span>
            </button>
            <button
              type="button"
              class="node"
              :class="{ on: stock === 'out' }"
              :aria-pressed="stock === 'out'"
              @click="setStock('out')"
            >
              <span>Out of stock</span>
              <span class="n">{{ catalog.summary?.productsOutOfStock ?? '' }}</span>
            </button>
            <button
              type="button"
              class="node"
              :class="{ on: stock === 'low' }"
              :aria-pressed="stock === 'low'"
              @click="setStock('low')"
            >
              <span>Below reorder</span>
              <span class="n">{{ catalog.summary?.productsBelowReorder ?? '' }}</span>
            </button>
          </div>
        </div>

        <div v-if="auth.isAdmin" class="group">
          <div class="key">Visibility</div>
          <div class="stocklist" role="group" aria-label="Product visibility">
            <button
              type="button"
              class="node"
              :class="{ on: showInactive }"
              :aria-pressed="showInactive"
              @click="toggleInactive"
            >
              <span>Include inactive</span>
            </button>
          </div>
        </div>

        <div class="group">
          <div class="key">Category</div>
          <CategoryTree
            :tree="catalog.categoryTree"
            :selected="categories"
            @toggle="(id) => toggle('categories', id)"
          />
        </div>

        <div class="group">
          <div class="key">Cannabinoid</div>
          <div class="stocklist" role="group" aria-label="Filter by cannabinoid">
            <!--
              Zero-count cannabinoids are omitted rather than rendered disabled. CBN and CBC
              are seeded because they are standard and will turn up, but a permanently dead
              control is noise until they do.

              Selections AND together — a product must contain EVERY selected cannabinoid.
              The counts stay per-cannabinoid totals, so with two selected they no longer
              predict the result size, and the intersection can legitimately be zero.
            -->
            <button
              v-for="c in (catalog.reference?.cannabinoids ?? []).filter(
                (x) => x.productCount > 0 || cannabinoids.includes(x.id),
              )"
              :key="c.id"
              type="button"
              class="node"
              :class="{ on: cannabinoids.includes(c.id) }"
              :aria-pressed="cannabinoids.includes(c.id)"
              @click="toggle('cannabinoids', c.id)"
            >
              <span>{{ c.name }}</span>
              <span class="n">{{ c.productCount }}</span>
            </button>
          </div>
        </div>
      </aside>

      <div class="main">
        <div v-if="appliedPills.length > 0" class="applied">
          <button
            v-for="pill in appliedPills"
            :key="pill.key"
            type="button"
            class="apill"
            @click="pill.drop()"
          >
            <span class="g">{{ pill.group }}</span>
            {{ pill.label }}
            <span aria-hidden="true">×</span>
            <span class="sr">Remove filter</span>
          </button>
          <button type="button" class="clear" @click="clearAll">Clear all</button>
        </div>

        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th class="rail-col" />
                <th>Product</th>
                <th>Category</th>
                <th class="num">Price</th>
                <th v-if="showCost" class="num">Cost</th>
                <th v-for="store in stores" :key="store.id" class="num qtycol">
                  {{ store.name.replace(/\s*\(.*\)$/, '') }}
                </th>
                <th class="num qtycol">Total</th>
              </tr>
            </thead>

            <tbody v-if="catalog.page">
              <template v-for="product in catalog.page.products" :key="product.id">
                <!--
                  A real focusable control, not a <tr> with a click handler. The previous
                  version made the screen's primary navigation unreachable from a keyboard
                  and gave it no focus state at all.
                -->
                <tr
                  class="prow"
                  tabindex="0"
                  role="link"
                  :aria-label="`Open ${product.name}`"
                  @click="openProduct(product)"
                  @keydown.enter.prevent="openProduct(product)"
                  @keydown.space.prevent="openProduct(product)"
                >
                  <td class="rail-col">
                    <i :class="product.stock.status.toLowerCase()" />
                  </td>
                  <td>
                    <div class="prod">
                      <!--
                        alt="" is deliberate — the product name is the adjacent text in this
                        same cell, and `ProductImage.alt` is never populated. no-referrer
                        defeats most hotlink blocking on these legacy third-party URLs.
                      -->
                      <img
                        v-if="product.imageUrl && !imgFailed.has(product.id)"
                        class="thumb"
                        :src="product.imageUrl"
                        alt=""
                        width="40"
                        height="40"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                        @error="markImgFailed(product.id)"
                      />
                      <span v-else class="thumb ph" aria-hidden="true">
                        {{ product.name.charAt(0) }}
                      </span>
                      <div class="ptext">
                        <div class="pname">
                          {{ product.name }}
                          <span v-if="!product.active" class="inact">Inactive</span>
                          <!--
                            The count IS the control. It used to be inert grey text ~300px from a
                            14x21px grey triangle in the left gutter — the row said "6 variants"
                            in one place and the way to see them lived in another, both in the
                            same weak colour. Merging them removes the hunt rather than making
                            the hunt easier.
                          -->
                          <button
                            v-if="product.variants.length > 1"
                            type="button"
                            class="vbtn"
                            :aria-expanded="expanded.has(product.id)"
                            :aria-label="`${expanded.has(product.id) ? 'Hide' : 'Show'} the ${product.variants.length} variants of ${product.name}`"
                            @click.stop="toggleRow(product.id)"
                            @keydown.enter.stop
                            @keydown.space.stop
                          >
                            <span class="car" aria-hidden="true">
                              {{ expanded.has(product.id) ? '▾' : '▸' }}
                            </span>
                            {{ product.variants.length }} variants
                          </button>
                        </div>
                        <div class="pmeta">
                          <span v-if="product.brand">{{ product.brand.name }}</span>
                          <EmptyValue v-else label="no brand" />
                          <span v-if="product.primarySupplier"> · {{ product.primarySupplier.name }}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td class="cat">
                    <span v-if="product.category.parent" class="parent">
                      {{ product.category.parent.name }} ›
                    </span>
                    {{ product.category.name }}
                  </td>
                  <td class="num">{{ productPrice(product) }}</td>
                  <td v-if="showCost" class="num cost">
                    <template v-if="productCost(product)">{{ productCost(product) }}</template>
                    <EmptyValue v-else label="—" />
                  </td>
                  <td
                    v-for="cell in product.stock.byStore"
                    :key="cell.storeId"
                    class="num"
                    :class="{ zero: cell.quantityBase === 0 }"
                  >
                    {{ qty(cell.quantityBase, product.stock.trackingMode) }}
                  </td>
                  <!--
                    The quantity ALWAYS shows, with the pill beside it. An earlier version
                    replaced the number with the pill for anything not OK, which threw away
                    the one figure that matters on a LOW row: how many are actually left.
                  -->
                  <td class="num total">
                    <StockPill :status="product.stock.status" :label="rollupLabel(product)" />
                    <span class="q">
                      {{ product.stock.quantityBase === null
                        ? '—'
                        : qty(product.stock.quantityBase, product.stock.trackingMode) }}
                    </span>
                  </td>
                </tr>

                <tr
                  v-for="variant in expanded.has(product.id) ? product.variants : []"
                  :key="variant.id"
                  class="vrow"
                >
                  <td class="rail-col"><i :class="variant.stock.status.toLowerCase()" /></td>
                  <td class="vname">
                    {{ variantName(variant) }}
                    <span class="sku">{{ variant.sku }}</span>
                  </td>
                  <td />
                  <td class="num">{{ variantPrice(variant) }}</td>
                  <td v-if="showCost" class="num cost">
                    <template v-if="variant.costCents != null">
                      {{ formatCents(unsafe.cents(variant.costCents)) }}
                    </template>
                    <EmptyValue v-else label="—" />
                  </td>
                  <td
                    v-for="cell in variant.stock.byStore"
                    :key="cell.storeId"
                    class="num"
                    :class="{ zero: cell.quantityBase === 0 }"
                  >
                    {{ qty(cell.quantityBase, variant.trackingMode) }}
                  </td>
                  <td class="num total">
                    <StockPill :status="variant.stock.status" />
                    <span class="q">{{ qty(variant.stock.quantityBase, variant.trackingMode) }}</span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>

          <!--
            An overlay rather than a v-if that replaces the table. Swapping the table for a
            one-line "Loading…" collapsed the page from ~2000px to ~400px and back on every
            debounced keystroke, taking the scroll position with it.
          -->
          <div v-if="catalog.loading" class="veil" aria-live="polite">Loading…</div>
        </div>

        <div v-if="catalog.page && catalog.page.products.length === 0" class="state">
          <p>No products match those filters.</p>
          <button type="button" class="clear" @click="clearAll">Clear filters</button>
        </div>

        <nav v-if="catalog.page && catalog.page.pageCount > 1" class="pager">
          <Button
            label="Previous"
            severity="secondary"
            size="small"
            :disabled="page <= 1"
            @click="page -= 1; apply(false)"
          />
          <span class="pageinfo">
            {{ showingRange }} · Page {{ catalog.page.page }} of {{ catalog.page.pageCount }}
          </span>
          <Button
            label="Next"
            severity="secondary"
            size="small"
            :disabled="page >= catalog.page.pageCount"
            @click="page += 1; apply(false)"
          />
        </nav>
        <p v-else-if="catalog.page && catalog.page.total > 0" class="pageinfo lone">
          {{ showingRange }}<span v-if="hasFilters"> matching</span>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.catalog {
  display: grid;
  gap: 1rem;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 1rem;
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: -0.015em;
}

.count {
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.body {
  display: grid;
  grid-template-columns: 14rem minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@container content (max-width: 1100px) {
  .body {
    grid-template-columns: 1fr;
  }
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0.85rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  position: sticky;
  top: 1rem;
  /*
   * The scroll container is `<main>`, which is the viewport MINUS the topbar — so the old
   * `calc(100dvh - 2rem)` overflowed by exactly the topbar's height and pushed the bottom of
   * the filter rail off screen. `--shell-topbar-h` comes from the layout so this and the
   * pricing preview cannot drift apart.
   */
  max-height: calc(100dvh - var(--shell-topbar-h, 0px) - 2rem);
  overflow-y: auto;
}

@container content (max-width: 1100px) {
  .rail {
    position: static;
    max-height: none;
  }
}

.search {
  width: 100%;
  font-size: 0.8125rem;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.key {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.seg {
  display: flex;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.3rem;
  overflow: hidden;
}

.seg button {
  flex: 1;
  padding: 0.25rem 0.3rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  background: var(--p-content-background);
  border: 0;
  border-right: 1px solid var(--p-content-border-color);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.seg button:last-child {
  border-right: 0;
}

.seg button.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
  font-weight: 620;
}

.stocklist {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
}

.node {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.35rem;
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  color: var(--p-text-color);
  background: none;
  border: 0;
  border-radius: 0.25rem;
  cursor: pointer;
}

.node:hover {
  background: var(--p-surface-100);
}

.app-dark .node:hover {
  background: var(--p-surface-800);
}

.node.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
  font-weight: 620;
}

.node .n {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.node.on .n {
  color: var(--p-primary-color);
  opacity: 0.75;
}

.seg button:focus-visible,
.node:focus-visible,
.apill:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.main {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}

.applied {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}

.apill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.45rem;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 620;
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border: 0;
  border-radius: 0.25rem;
  cursor: pointer;
}

.apill .g {
  font-weight: 400;
  opacity: 0.7;
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.clear {
  padding: 0;
  font: inherit;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}

/*
   Row density lives in one place.

   Set to Aura's ACTUAL DataTable padding tokens rather than eyeballed values, so this table
   matches every PrimeVue table in the app:
       small   0.125rem 0.375rem
       normal  0.5rem   0.875rem   <- here
       large   0.75rem  1.125rem
   Swapping density is changing the two numbers below.

   This table previously used a custom 0.42rem/0.6rem — just under normal vertically and well
   under it horizontally, matching no PrimeVue size at all. It read as cramped.
*/
.tablewrap {
  --row-pad-y: 0.5rem;
  --row-pad-x: 0.875rem;
  --row-font: 0.8125rem;
  --row-meta-font: 0.6875rem;

  position: relative;
  overflow-x: auto;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  text-align: left;
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  font-weight: 650;
  padding: calc(var(--row-pad-y) + 0.08rem) var(--row-pad-x);
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}

td {
  padding: var(--row-pad-y) var(--row-pad-x);
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: var(--row-font);
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: 0;
}

th.num,
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  /* A price RANGE is one value — "$39.99 – $139.99" breaking across two lines reads as two
     separate prices. Numeric columns never wrap. */
  white-space: nowrap;
}

/* Quantity columns shrink to content (they never wrap), so Product absorbs the space. */
th.qtycol {
  width: 1%;
}

/* The status rail: a 3px edge that makes a screen of rows scannable without reading. */
th.rail-col,
td.rail-col {
  width: 3px;
  padding: 0;
}

td.rail-col i {
  display: block;
  width: 3px;
  height: 100%;
  min-height: calc(var(--row-pad-y) * 2 + 1.4rem);
  background: transparent;
}

td.rail-col i.out {
  background: var(--p-red-500);
}

td.rail-col i.low {
  background: var(--p-amber-500);
}

.prow {
  cursor: pointer;
}

.prow:hover {
  background: var(--p-surface-50);
}

.app-dark .prow:hover {
  background: var(--p-surface-800);
}

.prow:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -2px;
}

/*
   The variant count, as a button.
   Sized so the click target clears the 24px minimum in the direction that matters for a
   mouse — the old chevron was 14x21px, which is why it read as decoration.
*/
.vbtn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-left: 0.4rem;
  padding: 0.16rem 0.45rem;
  font: inherit;
  font-size: var(--row-meta-font);
  font-weight: 620;
  line-height: 1.35;
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border: 1px solid transparent;
  border-radius: 0.25rem;
  cursor: pointer;
  vertical-align: middle;
}

.vbtn:hover {
  border-color: var(--p-primary-color);
}

.vbtn:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.vbtn .car {
  font-size: 0.625rem;
  opacity: 0.8;
}

.prod {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}

.thumb {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 0.375rem;
  object-fit: cover;
  background: var(--p-surface-100);
  border: 1px solid var(--p-content-border-color);
}

.app-dark .thumb {
  background: var(--p-surface-800);
}

/* Placeholder tile — the product's initial, for the 3 in 4 products with no image. */
.ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9375rem;
  font-weight: 650;
  color: var(--p-text-muted-color);
  user-select: none;
}

.ptext {
  min-width: 0;
}

.pname {
  font-weight: 600;
}

.inact {
  margin-left: 0.3rem;
  padding: 0.08rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  vertical-align: middle;
  background: color-mix(in srgb, var(--p-amber-500) 16%, transparent);
  color: var(--p-amber-600, #b45309);
}

.pmeta {
  margin-top: 1px;
  font-size: var(--row-meta-font);
  color: var(--p-text-muted-color);
}

.cat {
  white-space: nowrap;
  font-size: calc(var(--row-font) - 0.0625rem);
}

.cat .parent {
  color: var(--p-text-muted-color);
}

td.num.zero {
  color: var(--p-text-muted-color);
}

td.total {
  white-space: nowrap;
}

td.total .q {
  margin-left: 0.35rem;
}

.vrow td {
  background: var(--p-surface-50);
  font-size: calc(var(--row-font) - 0.03125rem);
}

.app-dark .vrow td {
  background: var(--p-surface-950);
}

/* Variant rows indent to where the product TEXT starts — past the 40px thumbnail. */
.vname {
  padding-left: calc(var(--row-pad-x) + 40px + 0.6rem) !important;
}

.sku {
  margin-left: 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

.veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 4rem;
  background: color-mix(in srgb, var(--p-content-background) 65%, transparent);
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.state {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.pager {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-content: center;
}

.pageinfo {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.pageinfo.lone {
  margin: 0;
  text-align: right;
}
</style>
