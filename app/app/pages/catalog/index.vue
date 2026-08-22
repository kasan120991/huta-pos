<script setup lang="ts">
import type { CatalogPage, CatalogReference, CatalogSummary } from '@huta/shared/schemas'
import type { StockFilter } from '@huta/shared'
import { Boxes, Layers, PackageX, TriangleAlert } from '@lucide/vue'
import AddProductDialog from '~/components/catalog/AddProductDialog.vue'
import CatalogFilterChip, { type FilterChipItem } from '~/components/catalog/CatalogFilterChip.vue'
import CatalogPanel from '~/components/catalog/CatalogPanel.vue'
import CatalogRow from '~/components/catalog/CatalogRow.vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Spinner } from '~/components/ui/spinner'
import { Input } from '~/components/ui/input'
import { Button } from '~/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Switch } from '~/components/ui/switch'
import { apiFetch } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

/* ————— filter state, mirrored to the URL ————— */
const search = ref('')
const searchInput = ref('')
const categories = ref<string[]>([])
const cannabinoids = ref<string[]>([])
const stock = ref<StockFilter>('all')
const storeId = ref<string | undefined>(undefined)
const includeInactive = ref(false)
const page = ref(1)

function asArray(v: unknown): string[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? (v as string[]) : [String(v)]
}

let syncing = false

function applyFromQuery() {
  syncing = true
  const q = route.query
  search.value = typeof q['q'] === 'string' ? q['q'] : ''
  searchInput.value = search.value
  categories.value = asArray(q['categories'])
  cannabinoids.value = asArray(q['cannabinoids'])
  stock.value =
    q['stock'] === 'low' || q['stock'] === 'out' || q['stock'] === 'on-hand' ? q['stock'] : 'all'
  storeId.value = typeof q['store'] === 'string' ? q['store'] : undefined
  includeInactive.value = q['inactive'] === '1'
  page.value = typeof q['page'] === 'string' ? Math.max(1, Number(q['page']) || 1) : 1
  void nextTick(() => { syncing = false })
}

function writeQuery() {
  if (syncing) return
  void router.replace({
    query: {
      q: search.value || undefined,
      categories: categories.value.length ? categories.value : undefined,
      cannabinoids: cannabinoids.value.length ? cannabinoids.value : undefined,
      stock: stock.value !== 'all' ? stock.value : undefined,
      store: storeId.value,
      inactive: includeInactive.value ? '1' : undefined,
      page: page.value > 1 ? String(page.value) : undefined,
    },
  })
}

applyFromQuery()
watch(() => route.query, applyFromQuery)

/* Search debounce — the table must not refetch per keystroke. */
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (search.value !== value) {
      search.value = value
      page.value = 1
      writeQuery()
    }
  }, 300)
})

/* ————— data ————— */
const reference = ref<CatalogReference | null>(null)
const summary = ref<CatalogSummary | null>(null)
const pageData = ref<CatalogPage | null>(null)
const loading = ref(false)
const selectedProductId = ref<string | null>(null)
const addProductOpen = ref(false)

async function fetchSummary() {
  summary.value = await apiFetch<CatalogSummary>('/catalog/summary', {
    query: { storeId: storeId.value },
  })
}

async function fetchPage() {
  loading.value = true
  try {
    pageData.value = await apiFetch<CatalogPage>('/catalog/products', {
      query: {
        search: search.value || undefined,
        categories: categories.value,
        cannabinoids: cannabinoids.value,
        stock: stock.value,
        storeId: storeId.value,
        active: auth.isAdmin && includeInactive.value ? 'all' : undefined,
        page: page.value,
        pageSize: 50,
      },
    })
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  reference.value = await apiFetch<CatalogReference>('/catalog/reference')
})
watch([storeId], fetchSummary, { immediate: true })
watch(
  [search, categories, cannabinoids, stock, storeId, includeInactive, page],
  fetchPage,
  { immediate: true },
)

/* ————— filter helpers ————— */
function resetPageAndSync() {
  page.value = 1
  writeQuery()
}

/**
 * Category tree, flattened for the chip. Selecting a parent covers its children on the
 * server, so a selected parent renders its children checked-but-implied.
 */
const categoryItems = computed<FilterChipItem[]>(() => {
  if (!reference.value) return []
  const cats = reference.value.categories
  const items: FilterChipItem[] = []
  for (const parent of cats.filter((c) => c.parentId === null)) {
    items.push({ id: parent.id, name: parent.name, count: parent.productCount, depth: 0 })
    for (const child of cats.filter((c) => c.parentId === parent.id)) {
      items.push({
        id: child.id,
        name: child.name,
        count: child.productCount,
        depth: 1,
        implied: categories.value.includes(parent.id),
      })
    }
  }
  return items
})

function toggleCategory(id: string) {
  const cats = reference.value?.categories ?? []
  const isParent = cats.some((c) => c.parentId === id)
  if (categories.value.includes(id)) {
    categories.value = categories.value.filter((c) => c !== id)
  } else {
    const next = [...categories.value, id]
    // A newly selected parent absorbs any individually selected children.
    categories.value = isParent
      ? next.filter((c) => cats.find((cat) => cat.id === c)?.parentId !== id)
      : next
  }
  resetPageAndSync()
}

const cannabinoidItems = computed<FilterChipItem[]>(() =>
  (reference.value?.cannabinoids ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    count: c.productCount,
  })),
)

function toggleCannabinoid(id: string) {
  cannabinoids.value = cannabinoids.value.includes(id)
    ? cannabinoids.value.filter((c) => c !== id)
    : [...cannabinoids.value, id]
  resetPageAndSync()
}

const stockItems = computed<FilterChipItem[]>(() => [
  { id: 'on-hand', name: 'On hand', count: summary.value?.productsOnHand },
  { id: 'low', name: 'Below reorder', count: summary.value?.productsBelowReorder },
  { id: 'out', name: 'Out of stock', count: summary.value?.productsOutOfStock },
])

function toggleStock(id: string) {
  stock.value = stock.value === id ? 'all' : (id as StockFilter)
  resetPageAndSync()
}

/** Active-filter pills under the toolbar. */
const activePills = computed(() => {
  const pills: Array<{ key: string, label: string, remove: () => void }> = []
  const cats = reference.value?.categories ?? []
  for (const id of categories.value) {
    const cat = cats.find((c) => c.id === id)
    if (cat) pills.push({ key: `cat-${id}`, label: cat.name, remove: () => toggleCategory(id) })
  }
  for (const id of cannabinoids.value) {
    const can = reference.value?.cannabinoids.find((c) => c.id === id)
    if (can) pills.push({ key: `can-${id}`, label: can.name, remove: () => toggleCannabinoid(id) })
  }
  if (stock.value !== 'all') {
    pills.push({
      key: 'stock',
      label:
        stock.value === 'low' ? 'Below reorder' : stock.value === 'out' ? 'Out of stock' : 'On hand',
      remove: () => toggleStock(stock.value),
    })
  }
  return pills
})

function clearAll() {
  categories.value = []
  cannabinoids.value = []
  stock.value = 'all'
  searchInput.value = ''
  search.value = ''
  resetPageAndSync()
}

/* ————— derived display ————— */
const showingLabel = computed(() => {
  const d = pageData.value
  if (!d || d.total === 0) return null
  const from = (d.page - 1) * d.pageSize + 1
  const to = Math.min(d.page * d.pageSize, d.total)
  return `Showing ${from}–${to} of ${d.total}`
})

const kpis = computed(() => [
  { key: 'products', label: 'Products', value: summary.value?.products, icon: Boxes, tone: 'text-primary bg-primary/10', filter: null as StockFilter | null },
  { key: 'variants', label: 'Variants', value: summary.value?.variants, icon: Layers, tone: 'text-primary bg-primary/10', filter: null as StockFilter | null },
  { key: 'low', label: 'Below reorder', value: summary.value?.productsBelowReorder, icon: TriangleAlert, tone: 'text-amber-500 bg-amber-500/10', filter: 'low' as StockFilter },
  { key: 'out', label: 'Out of stock', value: summary.value?.productsOutOfStock, icon: PackageX, tone: 'text-red-400 bg-red-400/10', filter: 'out' as StockFilter },
])
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-baseline gap-2">
      <h1 class="text-xl font-semibold tracking-tight">Catalog</h1>
      <span v-if="summary" class="text-sm text-muted-foreground">{{ summary.products }} products</span>
      <Button
        v-if="auth.isAdmin"
        class="ml-auto self-center"
        size="sm"
        :disabled="!reference"
        @click="addProductOpen = true"
      >
        ＋ Add product
      </Button>
    </div>

    <!-- KPI strip: scoped to the store select, deliberately NOT to the filters. -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <component
        :is="kpi.filter ? 'button' : 'div'"
        v-for="kpi in kpis"
        :key="kpi.key"
        :type="kpi.filter ? 'button' : undefined"
        class="flex items-center gap-3 rounded-xl border bg-card p-3 text-left"
        :class="[
          kpi.filter ? 'cursor-pointer transition-colors hover:bg-accent/40' : '',
          kpi.filter && stock === kpi.filter ? 'border-primary/50' : '',
        ]"
        @click="kpi.filter && toggleStock(kpi.filter)"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg" :class="kpi.tone">
          <component :is="kpi.icon" class="size-4.5" />
        </span>
        <span>
          <span class="block text-lg font-semibold leading-tight tabular-nums">{{ kpi.value ?? '—' }}</span>
          <span class="block text-xs text-muted-foreground">{{ kpi.label }}</span>
        </span>
      </component>
    </div>

    <!-- toolbar -->
    <div class="flex flex-wrap items-center gap-2">
      <SearchInput
        v-model="searchInput"
        placeholder="Search products…"
        class="h-8 w-56"
        aria-label="Search products"
      />
      <CatalogFilterChip
        label="Category"
        :items="categoryItems"
        :selected="categories"
        @toggle="toggleCategory"
        @clear="categories = []; resetPageAndSync()"
      />
      <CatalogFilterChip
        label="Cannabinoid"
        :items="cannabinoidItems"
        :selected="cannabinoids"
        footnote="Products must contain ALL selected cannabinoids. Counts are catalog totals."
        @toggle="toggleCannabinoid"
        @clear="cannabinoids = []; resetPageAndSync()"
      />
      <CatalogFilterChip
        label="Stock"
        :items="stockItems"
        :selected="stock === 'all' ? [] : [stock]"
        @toggle="toggleStock"
        @clear="stock = 'all'; resetPageAndSync()"
      />
      <div class="ml-auto flex items-center gap-3">
        <Select
          :model-value="storeId ?? 'all'"
          @update:model-value="(v) => { storeId = v === 'all' ? undefined : (v as string); resetPageAndSync() }"
        >
          <SelectTrigger class="h-8 w-40" aria-label="Store scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stores</SelectItem>
            <SelectItem v-for="store in reference?.stores ?? []" :key="store.id" :value="store.id">
              {{ store.name }}
            </SelectItem>
          </SelectContent>
        </Select>
        <label v-if="auth.isAdmin" class="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Switch
            :model-value="includeInactive"
            @update:model-value="(v: boolean) => { includeInactive = v; resetPageAndSync() }"
          />
          Include inactive
        </label>
      </div>
    </div>

    <div v-if="activePills.length" class="flex flex-wrap items-center gap-1.5">
      <button
        v-for="pill in activePills"
        :key="pill.key"
        type="button"
        class="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs hover:bg-accent/70"
        @click="pill.remove()"
      >
        {{ pill.label }}
        <span class="text-muted-foreground">×</span>
      </button>
      <Button variant="ghost" size="sm" class="h-6 px-2 text-xs text-muted-foreground" @click="clearAll">
        Clear all
      </Button>
    </div>

    <!-- rows: veil over existing content while loading, never a swap -->
    <div class="relative rounded-xl border">
      <div class="grid grid-cols-[24px_40px_minmax(0,1fr)_110px_90px_110px_130px_80px] gap-3 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <span /><span />
        <span>Product</span>
        <span>Category</span>
        <span>Variants</span>
        <span>Price</span>
        <span>Inventory</span>
        <span>Status</span>
      </div>
      <div v-if="pageData?.products.length" :class="loading ? 'pointer-events-none opacity-50' : ''">
        <CatalogRow
          v-for="product in pageData.products"
          :key="product.id"
          :product="product"
          @open="selectedProductId = product.id"
        />
      </div>
      <div v-else-if="loading" class="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />Loading…
      </div>
      <Empty v-else class="flex-none border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><PackageX /></EmptyMedia>
          <EmptyTitle>No products match</EmptyTitle>
          <EmptyDescription>Try widening the filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>

    <div v-if="pageData && pageData.pageCount > 0" class="flex items-center gap-3 text-sm text-muted-foreground">
      <span>{{ showingLabel }}</span>
      <div class="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="page <= 1"
          @click="page -= 1; writeQuery()"
        >
          Previous
        </Button>
        <span class="tabular-nums">Page {{ pageData.page }} of {{ pageData.pageCount }}</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="page >= pageData.pageCount"
          @click="page += 1; writeQuery()"
        >
          Next
        </Button>
      </div>
    </div>

    <CatalogPanel
      :product-id="selectedProductId"
      :store-id="storeId"
      @close="selectedProductId = null"
    />

    <AddProductDialog
      v-if="reference"
      :open="addProductOpen"
      :reference="reference"
      @close="addProductOpen = false"
    />
  </div>
</template>
