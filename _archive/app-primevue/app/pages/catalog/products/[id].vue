<script setup lang="ts">
import type { CatalogProductDetail, CatalogVariant, ProductInsights } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Product detail — a tabbed workspace over one product.
 *
 * The page is the orchestrator: it owns the fetches, the URL-synced tab and store scope,
 * and the adjust dialog. The tabs render what they are handed and never fetch product data
 * themselves (History fetches its own ledger, which is per-variant and lazy by design).
 *
 * Two payloads, deliberately: the detail (everyone) and the insights (admins — the whole
 * endpoint is cost-derived and refuses anyone else). Staff render from the detail alone
 * and simply never see the money-shaped cells.
 */

const catalog = useCatalogStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const productId = route.params['id'] as string

const TABS = ['overview', 'inventory', 'history', 'media'] as const
type TabId = (typeof TABS)[number]

/**
 * Tab and store scope live in the URL so a view can be shared or restored — the old page
 * silently fell back to "all stores" on every refresh because the scope lived only in
 * Pinia. `router.replace` is only ever called from a user action; calling it during setup
 * races the router's initial navigation and drops the query (see catalog/index.vue).
 */
const tab = computed<TabId>({
  get: () => {
    const q = route.query['tab']
    return typeof q === 'string' && (TABS as readonly string[]).includes(q) ? (q as TabId) : 'overview'
  },
  set: (value) => {
    void router.replace({
      query: { ...route.query, tab: value === 'overview' ? undefined : value },
    })
  },
})

const storeId = ref<string | null>((route.query['storeId'] as string) ?? catalog.selectedStoreId)

const product = ref<CatalogProductDetail | null>(null)
const insights = ref<ProductInsights | null>(null)
const notFound = ref(false)
const loadError = ref<string | null>(null)
const reloading = ref(false)

async function fetchAll(): Promise<void> {
  loadError.value = null
  try {
    const [detail, econ] = await Promise.all([
      catalog.getProduct(productId, storeId.value),
      // Insights are admin-only and never worth failing the page over.
      auth.isAdmin
        ? catalog.getInsights(productId, storeId.value).catch(() => null)
        : Promise.resolve(null),
    ])
    product.value = detail
    insights.value = econ
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound.value = true
      return
    }
    loadError.value = err instanceof ApiError ? err.message : 'Could not load that product.'
  }
}

await Promise.all([catalog.loadReference(), fetchAll()])

/** Refetch behind a veil — never swap the page for a loading message. */
async function reloadAll(): Promise<void> {
  reloading.value = true
  try {
    await fetchAll()
  } finally {
    reloading.value = false
  }
}

watch(storeId, async (value) => {
  catalog.selectedStoreId = value
  await router.replace({ query: { ...route.query, storeId: value ?? undefined } })
  await reloadAll()
})

// --- stock adjustment ----------------------------------------------------------------------

const adjusting = ref<{
  variant: CatalogVariant
  storeId: string
  storeName: string
  currentBase: number
} | null>(null)

function openAdjust(variant: CatalogVariant, targetStoreId: string, storeName: string): void {
  const current = variant.stock.byStore.find((s) => s.storeId === targetStoreId)
  adjusting.value = {
    variant,
    storeId: targetStoreId,
    storeName,
    currentBase: current?.quantityBase ?? 0,
  }
}

async function onAdjusted(): Promise<void> {
  adjusting.value = null
  await reloadAll()
}

// --- the editors (admin-only affordances; the server refuses anyone else anyway) -----------

const editingProduct = ref(false)
const editingPotency = ref(false)
const editingVariant = ref<CatalogVariant | null>(null)
const creatingVariant = ref(false)

async function onEditorSaved(): Promise<void> {
  editingProduct.value = false
  editingPotency.value = false
  editingVariant.value = null
  creatingVariant.value = false
  await reloadAll()
}

/** Crumbs link back into the FILTERED catalog — the path is a control, not a caption. */
const crumbs = computed(() => {
  if (!product.value) return []
  const trail: Array<{ label: string; to: string | null }> = [
    { label: 'Catalog', to: '/catalog' },
  ]
  const parent = product.value.category.parent
  if (parent) trail.push({ label: parent.name, to: `/catalog?categories=${parent.id}` })
  trail.push({
    label: product.value.category.name,
    to: `/catalog?categories=${product.value.category.id}`,
  })
  return trail
})
</script>

<template>
  <section class="detail">
    <div v-if="notFound" class="state">
      <p>That product does not exist — it may have been removed, or the link is stale.</p>
      <NuxtLink to="/catalog" class="back">Back to the catalog</NuxtLink>
    </div>

    <Message v-else-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

    <template v-else-if="product">
      <nav class="crumbs" aria-label="Breadcrumb">
        <template v-for="(crumb, index) in crumbs" :key="crumb.label">
          <span v-if="index > 0" aria-hidden="true">›</span>
          <NuxtLink v-if="crumb.to" :to="crumb.to">{{ crumb.label }}</NuxtLink>
          <span v-else>{{ crumb.label }}</span>
        </template>
      </nav>

      <ProductHero v-model:store-id="storeId" :product="product">
        <template v-if="auth.isAdmin" #actions>
          <Button
            label="New variant"
            severity="secondary"
            size="small"
            @click="creatingVariant = true"
          />
          <Button label="Edit product" size="small" @click="editingProduct = true" />
        </template>
      </ProductHero>

      <ProductKpis :product="product" :insights="insights" />

      <Tabs :value="tab" lazy @update:value="tab = $event as typeof tab">
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="inventory">Inventory</Tab>
          <Tab value="history">History</Tab>
          <Tab value="media">Media</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="overview">
            <ProductOverviewTab
              :product="product"
              :insights="insights"
              :can-edit="auth.isAdmin"
              @edit-product="editingProduct = true"
              @edit-potency="editingPotency = true"
              @edit-variant="(variant) => (editingVariant = variant)"
            />
          </TabPanel>
          <TabPanel value="inventory">
            <ProductInventoryTab :product="product" :insights="insights" @adjust="openAdjust" />
          </TabPanel>
          <TabPanel value="history">
            <ProductHistoryTab :product="product" :store-id="storeId" />
          </TabPanel>
          <TabPanel value="media">
            <ProductMediaTab :product="product" :can-edit="auth.isAdmin" @saved="reloadAll" />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <div v-if="reloading" class="veil" aria-live="polite">Loading…</div>

      <ProductEditDialog
        v-if="editingProduct"
        :product="product"
        @close="editingProduct = false"
        @saved="onEditorSaved"
      />

      <ProductPotencyDialog
        v-if="editingPotency"
        :product="product"
        @close="editingPotency = false"
        @saved="onEditorSaved"
      />

      <ProductVariantDialog
        v-if="editingVariant"
        :product-id="product.id"
        :product-name="product.name"
        :variant="editingVariant"
        @close="editingVariant = null"
        @saved="onEditorSaved"
      />

      <ProductVariantDialog
        v-if="creatingVariant"
        :product-id="product.id"
        :product-name="product.name"
        @close="creatingVariant = false"
        @saved="onEditorSaved"
      />

      <AdjustStockDialog
        v-if="adjusting"
        :variant-id="adjusting.variant.id"
        :variant-label="adjusting.variant.label ?? 'Standard'"
        :sku="adjusting.variant.sku"
        :product-name="product.name"
        :store-id="adjusting.storeId"
        :store-name="adjusting.storeName"
        :current-base="adjusting.currentBase"
        :tracking-mode="adjusting.variant.trackingMode"
        @close="adjusting = null"
        @adjusted="onAdjusted"
      />
    </template>
  </section>
</template>

<style scoped>
.detail {
  position: relative;
  display: grid;
  gap: 1rem;
  max-width: 72rem;
}

.crumbs {
  display: flex;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.crumbs a {
  color: var(--p-primary-color);
  text-decoration: none;
}

.crumbs a:hover {
  text-decoration: underline;
}

.state {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.state p {
  margin: 0 0 0.5rem;
}

.back {
  color: var(--p-primary-color);
}

.veil {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 6rem;
  background: color-mix(in srgb, var(--p-content-background) 65%, transparent);
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}
</style>
