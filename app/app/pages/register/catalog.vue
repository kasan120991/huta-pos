<script setup lang="ts">
import type {
  CatalogPage,
  CatalogProduct,
  CatalogProductDetail,
  CatalogReference,
  CatalogVariant,
} from '@huta/shared/schemas'
import type { BaseQuantity, Cents } from '@huta/shared'
import { formatCents, formatGrams, formatQuantity } from '@huta/shared'
import { ExternalLink, PackageSearch, Search, SearchX } from '@lucide/vue'
import { Spinner } from '~/components/ui/spinner'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Button } from '~/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { apiFetch } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * The register catalog — a LOOKUP surface for the counter, read-only by design.
 *
 * It answers the four questions staff actually get asked: do we have it, what does it
 * cost (including the flower tier ladder), how strong is it, and does the other store
 * have it. The browse grid is scoped to THIS store (the badge means "out here"); the
 * inspector fetches the product without a store scope, which is the read-only
 * cross-store visibility staff have always been granted. Nothing here computes money —
 * prices and ladders render the catalog payload verbatim, and selling happens on the
 * sale screen via the Ring-it-up handoff.
 */
definePageMeta({ layout: 'register' })

const router = useRouter()
const auth = useAuthStore()
const booted = ref(false)

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')
  booted.value = true

  reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  await loadProducts()
  focusSearch()
})

const fmt = (cents: number) => formatCents(cents as Cents)
const hereId = computed(() => auth.terminal?.store.id ?? null)

/* ————— browse: search + chips + grid ————— */
const reference = ref<CatalogReference | null>(null)
const categoryId = ref<string | null>(null)
const cannabinoidIds = ref<string[]>([])
const parents = computed(() =>
  (reference.value?.categories ?? []).filter((c) => c.parentId === null),
)
const cannabinoidItems = computed(() =>
  (reference.value?.cannabinoids ?? [])
    .filter((c) => c.productCount > 0)
    .map((c) => ({ id: c.id, name: c.name, count: c.productCount })),
)

const products = ref<CatalogProduct[]>([])

/**
 * Paging. The grid used to fetch page 1 at pageSize 24 and stop, with no count and no way
 * forward — so "Ingestibles" showed 24 of its 108 and nothing on screen distinguished
 * "that's all of them" from "that's the first fifth". `total` comes off the payload, which
 * has always carried it.
 */
const PAGE_SIZE = 24
const page = ref(1)
const total = ref(0)
const loadingMore = ref(false)
const hasMore = computed(() => products.value.length < total.value)
const loadingProducts = ref(false)
const term = ref('')
const searchInput = ref<{ focus: () => void } | null>(null)

function focusSearch() {
  void nextTick(() => searchInput.value?.focus())
}

const looksScanned = (q: string) => /^\d{6,}$/.test(q)

/* ————— camera scanning (C: a drop-down panel, CONTINUOUS) ————— */
const scannerOpen = ref(false)
const scannerFeedback = ref<{ seq: number, text: string } | null>(null)
let feedbackSeq = 0
const toastScanner = (text: string) => (scannerFeedback.value = { seq: ++feedbackSeq, text })

async function onCameraScanned(code: string) {
  try {
    const page = await apiFetch<CatalogPage>('/catalog/products', {
      query: {
        search: code,
        pageSize: 8,
        ...(auth.terminal ? { storeId: auth.terminal.store.id } : {}),
      },
    })
    const products = page.products as CatalogProduct[]
    if (products.length === 1) {
      void select(products[0]!.id)
      toastScanner(`✓ ${products[0]!.name}`)
    } else {
      toastScanner(products.length ? 'Several matches — search by name' : 'No match in the catalog')
    }
  } catch {
    toastScanner('Could not search the catalog')
  }
}

async function loadProducts(append = false) {
  if (append) loadingMore.value = true
  else loadingProducts.value = true
  try {
    const q = term.value.trim()
    const wanted = append ? page.value + 1 : 1
    const res = await apiFetch<CatalogPage>('/catalog/products', {
      query: {
        ...(q.length >= 2 ? { search: q } : {}),
        ...(categoryId.value ? { categories: [categoryId.value] } : {}),
        ...(cannabinoidIds.value.length ? { cannabinoids: cannabinoidIds.value } : {}),
        // The grid is scoped HERE — its badges mean "out at this counter".
        ...(auth.terminal ? { storeId: auth.terminal.store.id } : {}),
        page: wanted,
        pageSize: PAGE_SIZE,
      },
    })
    const batch = res.products as CatalogProduct[]
    products.value = append ? [...products.value, ...batch] : batch
    page.value = wanted
    total.value = res.total

    // A scan identifies exactly one product — open it in the inspector.
    if (!append && products.value.length === 1 && looksScanned(q)) {
      void select(products.value[0]!.id)
      term.value = ''
      await loadProducts()
    }
  } finally {
    loadingProducts.value = false
    loadingMore.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(term, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadProducts(), 200)
})
watch([categoryId, cannabinoidIds], () => void loadProducts())

function toggleCannabinoid(id: string) {
  cannabinoidIds.value = cannabinoidIds.value.includes(id)
    ? cannabinoidIds.value.filter((c) => c !== id)
    : [...cannabinoidIds.value, id]
}

/** A scanner is a keyboard — keystrokes that land nowhere go to the search bar. */
function onWindowKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    term.value += event.key
    focusSearch()
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))

/* ————— rendering helpers ————— */
const STATUS_BADGE: Record<string, { label: string; class: string }> = {
  OUT: { label: 'Out here', class: 'bg-destructive/15 text-destructive' },
  LOW: { label: 'Low', class: 'bg-amber-500/15 text-amber-500' },
}

/** "THCA 24%" or "Δ8 800mg" — the payload carries one of the two columns. */
function potencyLabel(link: CatalogProduct['cannabinoids'][number]): string {
  const value =
    link.percentBps != null
      ? `${(link.percentBps / 100).toFixed(1).replace(/\.0$/, '')}%`
      : link.mgPerUnit != null
        ? `${link.mgPerUnit}mg`
        : null
  return value ? `${link.cannabinoid.name} ${value}` : link.cannabinoid.name
}

function variantPriceText(variant: CatalogVariant): string {
  if (variant.trackingMode === 'WEIGHT') {
    const rate = variant.priceGroup?.basePricePerGramCents
    return rate != null ? `${fmt(rate)}/g` : '—'
  }
  return variant.priceCents != null ? fmt(variant.priceCents) : '—'
}

/** The card's one price line: the variant's price, or "from $X" across several. */
function productPriceText(product: CatalogProduct): string {
  if (product.variants.length === 1) return variantPriceText(product.variants[0]!)
  const prices = product.variants
    .map((v) =>
      v.trackingMode === 'WEIGHT' ? v.priceGroup?.basePricePerGramCents ?? null : v.priceCents,
    )
    .filter((p): p is number => p != null)
  return prices.length ? `from ${fmt(Math.min(...prices))}` : '—'
}

const brokenImages = ref(new Set<string>())

const qty = (base: number, mode: CatalogVariant['trackingMode']) =>
  formatQuantity(base as BaseQuantity, mode)

/**
 * What THIS store holds, for the card's stock line.
 *
 * The list is fetched store-scoped (`storeId: terminal.store.id`), so `byStore` carries
 * exactly one row — this one. That is deliberate and must stay: dropping the scope to get
 * the other store's figure too would also change what `stock.status` means, and the house rules
 * is explicit that the badges on this screen mean "out HERE". Cross-store belongs to the
 * inspector, which fetches WITHOUT a store scope for exactly that reason.
 *
 * Null when the product mixes EACH and WEIGHT variants — a summed quantity across a gummy
 * and a gram is meaningless, and the payload already refuses to invent one.
 */
function hereQty(product: CatalogProduct): string | null {
  if (product.stock.trackingMode === null || product.stock.quantityBase === null) return null
  const row = product.stock.byStore.find((r) => r.storeId === hereId.value)
  if (!row) return null
  return qty(row.quantityBase, product.stock.trackingMode)
}

/* ————— the inspector ————— */
const detail = ref<CatalogProductDetail | null>(null)
const loadingDetail = ref(false)

/**
 * ONE VARIANT IS ALWAYS SELECTED, and a selected variant always gets the full block.
 *
 * This replaces a `variants.length === 1` branch that gave the rich block — price ladder
 * included — only to single-variant products, and compact rows to everything else. That
 * was a MONEY BUG once strains became variants on 2026-08-21: `Regular Flower` went
 * multi-variant, fell to the compact rows, and printed its base rate with no ladder. A
 * cashier multiplying $10.00/g quoted $35 for an eighth that rings $30, $70 for a quarter
 * that rings $55, and $280 for an ounce that rings $200.
 *
 * There is deliberately no second mode left to forget the ladder in.
 */
const selectedVariantId = ref<string | null>(null)

const selectedVariant = computed<CatalogVariant | null>(() => {
  const list = detail.value?.variants ?? []
  return list.find((v) => v.id === selectedVariantId.value) ?? list[0] ?? null
})

async function select(productId: string) {
  loadingDetail.value = true
  try {
    // No storeId: the detail carries EVERY store's on-hand — the read-only cross-store
    // visibility staff are granted, and the answer to "does Ashley have it".
    detail.value = await apiFetch<CatalogProductDetail>(`/catalog/products/${productId}`)
    // The server sorts variants by price ascending, so the first is the cheapest — the
    // right default when someone asks "how much is this?".
    selectedVariantId.value = detail.value.variants[0]?.id ?? null
  } finally {
    loadingDetail.value = false
  }
}

const storeNameById = computed(
  () => new Map((detail.value?.stores ?? []).map((s) => [s.id, s.name])),
)

/** byStore in reference order, except HERE always leads — it's the counter's answer. */
function storeRows(variant: CatalogVariant) {
  return [...variant.stock.byStore].sort((a, b) =>
    a.storeId === hereId.value ? -1 : b.storeId === hereId.value ? 1 : 0,
  )
}

/** The tier ladder, entry-priced: the base rate at 1g, then each typed tier total. */
function ladderRows(variant: CatalogVariant) {
  const group = variant.priceGroup
  if (!group) return []
  return [
    { label: '1g', priceCents: group.basePricePerGramCents },
    ...group.tiers.map((tier) => ({
      label: formatGrams(tier.minQuantityBase as BaseQuantity),
      priceCents: tier.totalPriceCents,
    })),
  ]
}

/**
 * The SELECTED variant's resolved identity, never the product's own columns.
 *
 * The detail payload ships `variant.identity` — the server has already applied the
 * variant → product fallback (scalars field by field, the cannabinoid list all-or-nothing)
 * so no client re-implements the rule. This screen used to read `detail.strainType`,
 * `detail.nose` and `detail.cannabinoids` directly, which is correct only while no strain
 * owns anything: the first strain filled in through StrainDialog would have kept showing
 * the shelf's values at the counter. Falls back to the product for a payload without it.
 */
const identity = computed(() => selectedVariant.value?.identity ?? null)

const potencyLinks = computed(
  () => identity.value?.cannabinoids ?? detail.value?.cannabinoids ?? [],
)
const strainType = computed(() => identity.value?.strainType ?? detail.value?.strainType ?? null)
const nose = computed(() => identity.value?.nose ?? detail.value?.nose ?? null)
const terpenes = computed(
  () => identity.value?.terpeneProfile ?? detail.value?.terpeneProfile ?? null,
)
const coaUrl = computed(() => identity.value?.coaUrl ?? detail.value?.coaUrl ?? null)
const description = computed(
  () => identity.value?.description ?? detail.value?.description ?? null,
)

/**
 * What to call the thing in the header.
 *
 * The same rule the transfers fill sheet uses: on flower the VARIANT is the identity
 * ("Blue Dream"), on a packaged good the label is a size and "1000mg" names nothing. So a
 * WEIGHT variant with a label titles the pane; everything else uses the product name.
 */
const drawerTitle = computed(() => {
  const v = selectedVariant.value
  if (v?.trackingMode === 'WEIGHT' && v.label) return v.label
  return detail.value?.name ?? ''
})

const drawerSubtitle = computed(() => {
  const d = detail.value
  if (!d) return ''
  const v = selectedVariant.value
  const parts
    = v?.trackingMode === 'WEIGHT' && v.label
      ? [d.name, strainType.value?.toLowerCase()]
      : [d.category.name, d.brand?.name, strainType.value?.toLowerCase()]
  return parts.filter(Boolean).join(' · ')
})

/* ————— TEMPORARY: the barcode-tagging drive (Kasan, 2026-08-22) —————
 * 309 of 313 active variants have no barcode. Remove this block, the button in the pinned
 * bar, and <RegisterSaveBarcodeDialog> once the shelf is tagged.
 *
 * Admin-only because the server says so: PATCH /catalog/variants/:id is requireAdmin +
 * catalog.manage. Hidden rather than disabled — a control staff can never use is noise on
 * a counter screen.
 */
const barcodeOpen = ref(false)
const canTagBarcodes = computed(
  () => auth.isAdmin && (detail.value?.variants ?? []).some((v) => !v.barcode),
)

async function onBarcodeSaved() {
  // Refetch so the button disappears when the last variant is tagged, and so the payload
  // the dialog reads stops disagreeing with the database.
  if (detail.value) await select(detail.value.id)
}

function ringUp(variantId: string) {
  if (!detail.value) return
  void router.push({
    path: '/register/sale',
    query: { add: variantId, product: detail.value.id },
  })
}

const detailImage = computed(() => {
  const d = detail.value
  if (!d) return null
  const url = d.images[0]?.url ?? d.imageUrl
  return url && !brokenImages.value.has(url) ? url : null
})
</script>

<template>
  <div class="flex h-dvh flex-col">
    <RegisterBar />

    <div v-if="booted" class="flex min-h-0 flex-1">
      <RegisterRail active="/register/catalog" />

      <!-- browse -->
      <main class="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div class="relative">
          <Search class="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-primary" />
          <SearchInput
            ref="searchInput"
            v-model="term"
            scanner
            placeholder="Scan a barcode or search the catalog…"
            autocomplete="off"
            spellcheck="false"
            class="h-12 border-primary/60 pl-10 text-base shadow-[0_0_0_3px_rgba(34,197,94,0.10)]"
            aria-label="Scan or search"
            @scan="scannerOpen = !scannerOpen"
          />
          <RegisterCameraScanner
            :open="scannerOpen"
            :feedback="scannerFeedback"
            @scanned="onCameraScanned"
            @close="scannerOpen = false"
          />
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <ToggleGroup
            :model-value="categoryId ?? '__all'"
            type="single"
            :spacing="1.5"
            aria-label="Category"
            class="flex-wrap"
            @update:model-value="(v) => categoryId = !v || v === '__all' ? null : (v as string)"
          >
            <ToggleGroupItem value="__all" class="h-9 rounded-full border border-input px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/12 data-[state=on]:text-primary">All</ToggleGroupItem>
            <ToggleGroupItem
              v-for="cat in parents"
              :key="cat.id"
              :value="cat.id"
              class="h-9 rounded-full border border-input px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/12 data-[state=on]:text-primary"
            >
              {{ cat.name }}
            </ToggleGroupItem>
          </ToggleGroup>
          <span class="mx-1 h-5 border-l" aria-hidden="true" />
          <CatalogFilterChip
            pill
            label="Cannabinoids"
            :items="cannabinoidItems"
            :selected="cannabinoidIds"
            footnote="Products must contain EVERY selected one. Counts are catalog totals."
            @toggle="toggleCannabinoid"
            @clear="cannabinoidIds = []"
          />
        </div>

        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div v-if="loadingProducts" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true" />
          <Empty v-if="!products.length && !loadingProducts" class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
              <EmptyTitle>Nothing matches</EmptyTitle>
              <EmptyDescription>Try another search, or remove a chip.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <!--
            Card 3 (Kasan, 2026-08-22): type-led, photo as a corner mark.

            This is a LOOKUP screen, so the name and the price are what is being read and
            they get the size. The photo shrinks to a 34px square confirmation mark — which
            also fixes the crop: every source image here is 1200×1200, and the old
            full-width 80px band was a 5.5:1 slot that `object-cover` reduced to an 18%
            horizontal strip through the middle.

            The bigger reason for the shrink is that only 75 of 286 products HAVE a photo.
            The old card made the missing-image state the loudest thing on it — a wide grey
            slab holding one letter, on three cards out of four. Here the empty slot is a
            quiet dashed square, so the majority state is the calm one.
          -->
          <div class="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-4">
            <button
              v-for="product in products"
              :key="product.id"
              type="button"
              class="flex min-h-[86px] flex-col gap-1.5 rounded-2xl border bg-card p-3 text-left transition-colors"
              :class="detail?.id === product.id ? 'border-primary/50 bg-primary/8' : 'hover:border-primary/40 hover:bg-accent/40'"
              @click="select(product.id)"
            >
              <span class="flex items-start gap-2">
                <span class="line-clamp-2 flex-1 text-sm font-bold leading-tight tracking-tight">
                  {{ product.name }}
                </span>
                <span
                  v-if="product.imageUrl && !brokenImages.has(product.imageUrl)"
                  class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent/60"
                >
                  <img
                    :src="product.imageUrl"
                    :alt="product.name"
                    class="size-full object-cover"
                    loading="lazy"
                    @error="brokenImages.add(product.imageUrl)"
                  />
                </span>
                <span
                  v-else
                  class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed text-xs font-bold text-muted-foreground/40"
                  aria-hidden="true"
                >
                  {{ product.name.charAt(0) }}
                </span>
              </span>

              <span class="truncate text-xs text-muted-foreground">
                {{ [product.brand?.name, ...product.cannabinoids.slice(0, 2).map(potencyLabel)].filter(Boolean).join(' · ') || product.category.name }}
              </span>

              <span class="mt-auto flex items-end justify-between gap-2 pt-0.5">
                <span class="text-base font-extrabold tracking-tight tabular-nums text-primary">
                  {{ productPriceText(product) }}
                </span>
                <!--
                  LOW carries the figure with it: "Low" alone is less useful than "Low · 2",
                  and low stock is exactly when the number is worth knowing. OUT does not —
                  the quantity is zero and the badge already says so.
                -->
                <span
                  v-if="STATUS_BADGE[product.stock.status]"
                  class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
                  :class="STATUS_BADGE[product.stock.status]!.class"
                >
                  {{ STATUS_BADGE[product.stock.status]!.label
                  }}<template v-if="product.stock.status === 'LOW' && hereQty(product)"> · {{ hereQty(product) }}</template>
                </span>
                <span v-else-if="hereQty(product)" class="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {{ hereQty(product) }} here
                </span>
              </span>
            </button>
          </div>

          <!--
            The count is not decoration. Without it the grid showed 24 of 286 and nothing
            said so, which reads as "that is the whole shelf" — the silent-truncation trap.
            It states the honest figure even when there is nothing more to load.
          -->
          <div v-if="products.length" class="flex items-center justify-center gap-3 pt-3 pb-1">
            <span class="text-xs tabular-nums text-muted-foreground">
              Showing {{ products.length }} of {{ total }}
            </span>
            <Button
              v-if="hasMore"
              variant="outline"
              class="h-11 px-5"
              :disabled="loadingMore"
              @click="loadProducts(true)"
            >
              <Spinner v-if="loadingMore" aria-hidden="true" />
              {{ loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - products.length)} more` }}
            </Button>
          </div>
        </div>
      </main>

      <!-- inspector -->
      <aside class="flex w-[400px] shrink-0 flex-col border-l bg-card" aria-label="Product details">
        <Empty v-if="!detail && !loadingDetail" class="m-6 border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><PackageSearch /></EmptyMedia>
            <EmptyTitle>Nothing selected</EmptyTitle>
            <EmptyDescription>Tap a product — or scan it — to see prices, potency, and stock at both stores.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <p v-else-if="loadingDetail && !detail" class="m-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />Loading…
        </p>

        <!--
          Option A (Kasan, 2026-08-22): THREE ANCHORED ZONES — a header that does not move,
          a middle that scrolls, and an action bar pinned to the bottom.

          The defect this fixes: "Ring it up" used to sit in the content flow, so it landed
          at 245px on a single-variant product and 494px on flower — a 250px swing on the one
          control that matters. The house pattern already exists (the house rules on
          `ReceiptCounter`: the action bar spans the pane at the bottom "so the button is in
          the same place whether a sale has one line or nine").

          Measured alongside: the pane runs 48-72% empty, because it reserves structure for
          content the catalogue does not have — 2 descriptions and 0 COAs across 286 active
          products. Those two blocks stay conditional and last; they must never shape the
          layout for the 284 products that lack them.
        -->
        <div v-else-if="detail" class="flex min-h-0 flex-1 flex-col" :class="loadingDetail ? 'opacity-60' : ''">

          <!-- ZONE 1 — fixed. Identity and the price, answerable without reading down. -->
          <div class="flex shrink-0 flex-col gap-2 border-b p-4">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <h2 class="text-lg font-extrabold leading-tight tracking-tight">{{ drawerTitle }}</h2>
                <p class="mt-0.5 text-xs text-muted-foreground">{{ drawerSubtitle }}</p>
              </div>
              <span class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent/60">
                <img v-if="detailImage" :src="detailImage" :alt="detail.name" class="size-full object-cover" @error="detailImage && brokenImages.add(detailImage)" />
                <span v-else class="text-lg font-extrabold text-muted-foreground/50">{{ detail.name.charAt(0) }}</span>
              </span>
            </div>

            <!--
              An EACH price IS the whole answer, so it is the biggest thing here. A WEIGHT
              rate deliberately is NOT: "$10.00/g" read alone and multiplied is exactly the
              mistake that misquoted an eighth by $5, so it stays small, says "from", and
              hands off to the ladder below.
            -->
            <template v-if="selectedVariant">
              <p v-if="selectedVariant.trackingMode === 'WEIGHT'" class="text-sm font-semibold tabular-nums text-muted-foreground">
                from <span class="text-primary">{{ variantPriceText(selectedVariant) }}</span>
              </p>
              <p v-else class="text-2xl font-extrabold leading-none tracking-tight tabular-nums text-primary">
                {{ variantPriceText(selectedVariant) }}
              </p>
            </template>
          </div>

          <!-- ZONE 2 — scrolls if it ever needs to. -->
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div v-if="potencyLinks.length || nose || terpenes" class="flex flex-wrap gap-1.5">
              <span
                v-for="link in potencyLinks"
                :key="link.cannabinoid.id"
                class="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-semibold text-primary"
              >
                {{ potencyLabel(link) }}
              </span>
              <span v-if="nose" class="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                nose: {{ nose }}
              </span>
              <span v-if="terpenes" class="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {{ terpenes }}
              </span>
            </div>

            <div v-if="detail.variants.length > 1" class="flex flex-col gap-1.5">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {{ detail.category.name === 'Flower' ? 'Strains' : 'Options' }} · {{ detail.variants.length }}
              </p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="variant in detail.variants"
                  :key="variant.id"
                  type="button"
                  class="min-h-11 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors"
                  :class="variant.id === selectedVariant?.id
                    ? 'border-primary/60 bg-primary/12 text-primary'
                    : 'text-muted-foreground hover:border-primary/40 hover:bg-accent/40'"
                  :aria-pressed="variant.id === selectedVariant?.id"
                  @click="selectedVariantId = variant.id"
                >
                  {{ variant.label ?? detail.name }}
                  <span class="block text-[11px] font-medium tabular-nums opacity-70">
                    {{ variantPriceText(variant) }}
                  </span>
                </button>
              </div>
            </div>

            <template v-if="selectedVariant">
              <div v-if="selectedVariant.trackingMode === 'WEIGHT' && selectedVariant.priceGroup">
                <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Price ladder</p>
                <div class="flex flex-col gap-1">
                  <div
                    v-for="row in ladderRows(selectedVariant)"
                    :key="row.label"
                    class="flex items-center justify-between rounded-lg border bg-background/60 px-3 py-1.5 text-sm"
                  >
                    <span>{{ row.label }}</span>
                    <span class="font-bold tabular-nums">{{ fmt(row.priceCents) }}</span>
                  </div>
                </div>
              </div>

              <div>
                <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">On hand</p>
                <div class="flex flex-col gap-1">
                  <div
                    v-for="row in storeRows(selectedVariant)"
                    :key="row.storeId"
                    class="flex items-center justify-between rounded-lg border bg-background/60 px-3 py-1.5 text-sm"
                  >
                    <span :class="row.storeId === hereId ? 'font-bold' : 'text-muted-foreground'">
                      {{ storeNameById.get(row.storeId) ?? '—' }}{{ row.storeId === hereId ? ' — here' : '' }}
                    </span>
                    <span
                      class="font-bold tabular-nums"
                      :class="row.quantityBase <= 0 ? 'text-destructive' : row.storeId === hereId ? 'text-primary' : 'text-muted-foreground'"
                    >
                      {{ qty(row.quantityBase, selectedVariant.trackingMode) }}
                    </span>
                  </div>
                </div>
              </div>
            </template>

            <p v-if="description" class="text-sm leading-relaxed text-muted-foreground">
              {{ description }}
            </p>

            <a
              v-if="coaUrl"
              :href="coaUrl"
              target="_blank"
              rel="noopener"
              class="flex items-center gap-1.5 text-sm text-primary underline underline-offset-2 hover:no-underline"
            >
              Certificate of analysis <ExternalLink class="size-3.5" />
            </a>
          </div>

          <!-- ZONE 3 — pinned. One target, same place, every product. -->
          <div v-if="selectedVariant" class="flex shrink-0 flex-col gap-2 border-t p-4">
            <!-- TEMPORARY: barcode-tagging drive. See `barcodeOpen` in the script. -->
            <Button
              v-if="canTagBarcodes"
              variant="outline"
              class="h-11 w-full border-dashed"
              @click="barcodeOpen = true"
            >
              Save barcode
            </Button>
            <Button class="h-12 w-full text-base font-bold" @click="ringUp(selectedVariant.id)">
              Ring it up →
            </Button>
          </div>
        </div>
      </aside>
    </div>

    <!-- TEMPORARY: barcode-tagging drive — delete with the button above. -->
    <RegisterSaveBarcodeDialog
      :open="barcodeOpen"
      :product="detail"
      @close="barcodeOpen = false"
      @saved="onBarcodeSaved"
    />
  </div>
</template>
