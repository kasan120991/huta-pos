<script setup lang="ts">
import type { CatalogProductDetail, CatalogReference, CatalogVariant, MovementRow, ProductInsights } from '@huta/shared/schemas'
import type { BaseQuantity, Cents } from '@huta/shared'
import { FLOWER_CATEGORY_SLUG, formatCents, formatQuantity } from '@huta/shared'
import { ArrowLeft, Pencil } from '@lucide/vue'
import AdjustStockDialog from '~/components/catalog/AdjustStockDialog.vue'
import PotencyDialog from '~/components/catalog/PotencyDialog.vue'
import ProductEditDialog from '~/components/catalog/ProductEditDialog.vue'
import ProductMediaCard from '~/components/catalog/ProductMediaCard.vue'
import StrainShelf from '~/components/catalog/StrainShelf.vue'
import VariantDialog from '~/components/catalog/VariantDialog.vue'
import { Spinner } from '~/components/ui/spinner'
import { FieldError } from '~/components/ui/field'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { ApiError, apiFetch } from '~/composables/useApi'
import { STOCK_EVENTS, useLiveData } from '~/composables/useLiveData'
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const productId = computed(() => String(route.params['id']))
const storeId = ref<string | undefined>(
  typeof route.query['store'] === 'string' ? route.query['store'] : undefined,
)

const detail = ref<CatalogProductDetail | null>(null)
const insights = ref<ProductInsights | null>(null)
const movements = ref<MovementRow[]>([])
const selectedVariantId = ref<string | null>(null)
const notFound = ref(false)
const loading = ref(true)

async function fetchAll(options: { silent?: boolean } = {}) {
  const silent = options.silent === true
  if (!silent) loading.value = true
  try {
    detail.value = await apiFetch<CatalogProductDetail>(`/catalog/products/${productId.value}`, {
      query: { storeId: storeId.value },
    })
    notFound.value = false
    if (selectedVariantId.value === null || !detail.value.variants.some((v) => v.id === selectedVariantId.value)) {
      selectedVariantId.value = detail.value.variants[0]?.id ?? null
    }
    // The whole insights endpoint is admin-gated server-side; staff never call it and
    // the page renders without the numbers.
    if (auth.isAdmin) {
      insights.value = await apiFetch<ProductInsights>(
        `/catalog/products/${productId.value}/insights`,
        { query: { storeId: storeId.value } },
      )
      // The strain shelf renders on load for flower and needs the cannabinoid list for
      // its potency picker, so this one is eager rather than on-first-dialog.
      if (isFlower.value) await ensureReference()
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound.value = true
    else throw error
  } finally {
    if (!silent) loading.value = false
  }
}

/**
 * Silent live refresh (Kasan's Option A, 2026-09-03): the per-store quantities, the cost
 * basis, the insights strip and the movement ledger all describe stock, so any movement
 * touching this product restates them.
 *
 * `fetchAll` already preserves `selectedVariantId` unless the variant has gone away, so the
 * variant a user is inspecting survives the refresh — and the ledger follows that same
 * selection, which is why both are re-read together.
 */
useLiveData(STOCK_EVENTS, () => Promise.all([fetchAll({ silent: true }), fetchMovements()]))

async function fetchMovements() {
  if (!selectedVariantId.value) {
    movements.value = []
    return
  }
  const data = await apiFetch<{ movements: MovementRow[] }>(
    `/inventory/movements/${selectedVariantId.value}`,
    { query: { storeId: storeId.value } },
  )
  movements.value = data.movements
}

watch([productId, storeId], () => void fetchAll(), { immediate: true })
watch([selectedVariantId, storeId], fetchMovements, { immediate: true })

function setStore(value: unknown) {
  storeId.value = value === 'all' ? undefined : (value as string)
  void router.replace({ query: { ...route.query, store: storeId.value } })
}

/* ————— display helpers ————— */
const selectedVariant = computed(
  () => detail.value?.variants.find((v) => v.id === selectedVariantId.value) ?? null,
)

function potency(link: CatalogProductDetail['cannabinoids'][number]): string | null {
  if (link.percentBps !== null) return `${(link.percentBps / 100).toFixed(2)}%`
  if (link.mgPerUnit !== null) return `${link.mgPerUnit}mg`
  return null
}

const heroChips = computed(() => {
  if (!detail.value) return []
  const chips: Array<{ label: string, green: boolean }> = []
  for (const link of detail.value.cannabinoids.slice(0, 3)) {
    const p = potency(link)
    chips.push({ label: p ? `${link.cannabinoid.name} ${p}` : link.cannabinoid.name, green: true })
  }
  if (detail.value.strainType) chips.push({ label: detail.value.strainType, green: false })
  return chips
})

const onHandLabel = computed(() => {
  const s = detail.value?.stock
  if (!s) return '—'
  if (s.quantityBase !== null && s.trackingMode !== null)
    return formatQuantity(s.quantityBase as BaseQuantity, s.trackingMode)
  return `${s.variantCount - s.outCount}/${s.variantCount} in stock`
})

const bps = (v: number | null | undefined) => (v == null ? '—' : `${(v / 100).toFixed(1)}%`)
const money = (v: number | null | undefined) => (v == null ? '—' : formatCents(v as Cents))

function variantPrice(v: CatalogVariant): string {
  if (v.trackingMode === 'WEIGHT' && v.priceGroup)
    return `${formatCents(v.priceGroup.basePricePerGramCents as Cents)}/g`
  return v.priceCents !== null ? formatCents(v.priceCents as Cents) : '—'
}

function qtyFor(v: CatalogVariant, storeIdWanted: string): string {
  const row = v.stock.byStore.find((s) => s.storeId === storeIdWanted)
  return row ? formatQuantity(row.quantityBase as BaseQuantity, v.trackingMode) : '—'
}

const statusDot: Record<string, string> = { OK: 'bg-primary', LOW: 'bg-amber-500', OUT: 'bg-red-400' }

/** Admin inventory rows from insights (carry cost); staff rows from the detail payload. */
const inventoryRows = computed(() => {
  if (!detail.value) return []
  const storeNames = new Map(detail.value.stores.map((s) => [s.id, s.name]))
  const rows: Array<{
    key: string
    variantId: string
    storeId: string
    variantLabel: string
    trackingMode: CatalogVariant['trackingMode']
    storeName: string
    quantityBase: number
    reorderPointBase: number | null
    avgUnitCostCents: number | null | undefined
    costBasisCents: number | null | undefined
  }> = []
  for (const v of detail.value.variants) {
    const label = v.label ?? detail.value.name
    const insightLevels = insights.value?.variants.find((iv) => iv.variantId === v.id)?.levels
    if (insightLevels) {
      for (const level of insightLevels) {
        rows.push({
          key: `${v.id}-${level.storeId}`,
          variantId: v.id,
          storeId: level.storeId,
          variantLabel: label,
          trackingMode: v.trackingMode,
          storeName: level.storeName,
          quantityBase: level.quantityBase,
          reorderPointBase: level.reorderPointBase,
          avgUnitCostCents: level.avgUnitCostCents,
          costBasisCents: level.costBasisCents,
        })
      }
    } else {
      for (const level of v.stockLevels) {
        rows.push({
          key: `${v.id}-${level.storeId}`,
          variantId: v.id,
          storeId: level.storeId,
          variantLabel: label,
          trackingMode: v.trackingMode,
          storeName: storeNames.get(level.storeId) ?? level.storeId,
          quantityBase: level.quantityBase,
          reorderPointBase: level.reorderPointBase,
          avgUnitCostCents: undefined,
          costBasisCents: undefined,
        })
      }
    }
  }
  return rows
})

/** The inventory row an adjustment is being posted against, or null when closed. */
const adjustTarget = ref<(typeof inventoryRows)['value'][number] | null>(null)

/* ————— activate / deactivate ————— */
const confirmDeactivate = ref(false)
const togglingActive = ref(false)
const activeError = ref<string | null>(null)

async function setActive(active: boolean) {
  if (!detail.value || togglingActive.value) return
  togglingActive.value = true
  activeError.value = null
  try {
    await apiFetch(`/catalog/products/${detail.value.id}`, {
      method: 'PATCH',
      body: { active },
    })
    confirmDeactivate.value = false
    await fetchAll()
  } catch (error) {
    activeError.value = error instanceof ApiError ? error.message : 'Something went wrong.'
    confirmDeactivate.value = false
  } finally {
    togglingActive.value = false
  }
}

/* ————— the edit layer (admin; the server enforces catalog.manage regardless) ————— */

/** Categories/brands/cannabinoids for the editors — fetched once, on first need. */
const reference = ref<CatalogReference | null>(null)
async function ensureReference() {
  if (reference.value === null) {
    reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  }
}

const editProductOpen = ref(false)
const potencyOpen = ref(false)
const variantOpen = ref(false)
/** The variant being edited, or null for "add a variant". */
const variantEditing = ref<CatalogVariant | null>(null)

async function openEditProduct() {
  await ensureReference()
  editProductOpen.value = true
}

async function openPotency() {
  await ensureReference()
  potencyOpen.value = true
}

function openVariant(variant: CatalogVariant | null) {
  variantEditing.value = variant
  variantOpen.value = true
}

/** Under the Flower subtree, a new variant defaults to WEIGHT (a strain's whole point). */
const isFlower = computed(() => {
  const category = detail.value?.category
  return category?.slug === FLOWER_CATEGORY_SLUG || category?.parent?.slug === FLOWER_CATEGORY_SLUG
})

async function onEdited() {
  await fetchAll()
  await fetchMovements()
}

async function onAdjusted() {
  await fetchAll()
  await fetchMovements()
}

const varianceRows = computed(
  () =>
    insights.value?.variants.find((iv) => iv.variantId === selectedVariantId.value)?.variance ?? [],
)

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
function when(iso: string): string {
  const d = new Date(iso)
  return `${dateFmt.format(d)} · ${timeFmt.format(d)}`
}

const movementTone: Record<string, string> = {
  RECEIVE: 'bg-primary/10 text-primary',
  SALE: 'bg-accent text-muted-foreground',
  RETURN: 'bg-primary/10 text-primary',
  SHRINKAGE: 'bg-red-400/10 text-red-400',
  ADJUSTMENT: 'bg-amber-500/10 text-amber-500',
  TRANSFER_OUT: 'bg-accent text-muted-foreground',
  TRANSFER_IN: 'bg-accent text-muted-foreground',
}

function delta(row: MovementRow): { text: string, cls: string } {
  const mode = selectedVariant.value?.trackingMode ?? 'EACH'
  const abs = formatQuantity(Math.abs(row.quantityBase) as BaseQuantity, mode)
  return row.quantityBase >= 0
    ? { text: `+${abs}`, cls: 'text-primary' }
    : { text: `−${abs}`, cls: 'text-red-400' }
}

const imageFailed = ref<Record<string, boolean>>({})
</script>

<template>
  <div v-if="notFound" class="py-16 text-center">
    <p class="text-sm text-muted-foreground">This product doesn't exist (or was removed).</p>
    <NuxtLink to="/catalog" class="mt-4 inline-block text-sm text-primary underline-offset-2 hover:underline">
      ← Back to catalog
    </NuxtLink>
  </div>

  <div v-else-if="detail" class="flex flex-col gap-4">
    <!-- hero -->
    <div class="flex flex-wrap items-start gap-4">
      <NuxtLink
        to="/catalog"
        class="mt-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Back to catalog"
      >
        <ArrowLeft class="size-4" />
      </NuxtLink>
      <div class="min-w-0 flex-1">
        <h1 class="flex items-center gap-2 text-xl font-bold tracking-tight">
          <span class="truncate">{{ detail.name }}</span>
          <Badge v-if="detail.active" class="border-transparent bg-primary/10 text-primary">Active</Badge>
          <Badge v-else variant="secondary">Inactive</Badge>
          <Button
            v-if="auth.isAdmin && detail.active"
            variant="outline"
            size="sm"
            class="h-7 px-2.5 text-xs font-medium"
            @click="confirmDeactivate = true"
          >
            Deactivate
          </Button>
          <Button
            v-else-if="auth.isAdmin"
            variant="outline"
            size="sm"
            class="h-7 px-2.5 text-xs font-medium"
            :disabled="togglingActive"
            @click="setActive(true)"
          >
            Reactivate
          </Button>
          <Button
            v-if="auth.isAdmin"
            variant="outline"
            size="sm"
            class="h-7 gap-1 px-2.5 text-xs font-medium"
            @click="openEditProduct"
          >
            <Pencil class="size-3" /> Edit
          </Button>
        </h1>
        <FieldError v-if="activeError" class="mt-1">{{ activeError }}</FieldError>
        <p class="mt-0.5 text-sm text-muted-foreground">
          {{ detail.brand?.name ?? 'No brand' }}
          · {{ detail.category.parent ? `${detail.category.parent.name} › ` : '' }}{{ detail.category.name }}
        </p>
        <div v-if="heroChips.length" class="mt-1.5 flex flex-wrap gap-1.5">
          <span
            v-for="chip in heroChips"
            :key="chip.label"
            class="rounded-full border px-2 py-0.5 text-xs"
            :class="chip.green ? 'border-primary/35 text-primary' : 'border-border text-muted-foreground'"
          >
            {{ chip.label }}
          </span>
        </div>
      </div>
      <Select :model-value="storeId ?? 'all'" @update:model-value="setStore">
        <SelectTrigger class="h-8 w-44" aria-label="Store scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All stores</SelectItem>
          <SelectItem v-for="store in detail.stores" :key="store.id" :value="store.id">
            {{ store.name }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- KPI strip: on-hand for everyone; the economics exist only for admins -->
    <div class="grid grid-cols-2 gap-3" :class="auth.isAdmin ? 'lg:grid-cols-4' : 'lg:grid-cols-4'">
      <div class="rounded-xl border bg-card p-3">
        <div class="text-lg font-semibold tabular-nums">{{ onHandLabel }}</div>
        <div class="text-xs text-muted-foreground">On hand · {{ storeId ? detail.stores.find(s => s.id === storeId)?.name : 'all stores' }}</div>
      </div>
      <template v-if="auth.isAdmin">
        <div class="rounded-xl border bg-card p-3">
          <div class="text-lg font-semibold tabular-nums">{{ money(insights?.valueAtCostCents) }}</div>
          <div class="text-xs text-muted-foreground">Value at cost</div>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <div class="text-lg font-semibold tabular-nums">{{ bps(insights?.marginBps) }}</div>
          <div class="text-xs text-muted-foreground">Blended margin</div>
        </div>
        <div class="rounded-xl border bg-card p-3">
          <div class="text-lg font-semibold tabular-nums">{{ bps(insights?.lossRate90d?.lossRateBps) }}</div>
          <div class="text-xs text-muted-foreground">Loss rate · 90 days</div>
        </div>
      </template>
    </div>

    <div class="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <!-- ————— identity rail (left) ————— -->
      <div class="flex flex-col gap-3 lg:sticky lg:top-4">
        <div v-if="detail.images.length" class="overflow-hidden rounded-xl border bg-card">
          <img
            v-if="!imageFailed[detail.images[0]!.url]"
            :src="detail.images[0]!.url"
            :alt="detail.images[0]!.alt ?? detail.name"
            class="max-h-52 w-full object-contain"
            @error="imageFailed[detail.images[0]!.url] = true"
          >
          <div v-else class="flex h-32 items-center justify-center text-3xl font-bold text-primary/40">
            {{ detail.name.charAt(0) }}
          </div>
        </div>

        <div v-if="detail.description" class="rounded-xl border bg-card p-3.5">
          <h3 class="mb-1.5 text-sm font-semibold">Description</h3>
          <p class="text-sm text-muted-foreground">{{ detail.description }}</p>
        </div>

        <div v-if="detail.cannabinoids.length || auth.isAdmin" class="rounded-xl border bg-card p-3.5">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-sm font-semibold">Cannabinoids</h3>
            <button
              v-if="auth.isAdmin"
              type="button"
              class="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Edit cannabinoids"
              @click="openPotency"
            >
              <Pencil class="size-3.5" />
            </button>
          </div>
          <p v-if="!detail.cannabinoids.length" class="text-sm text-muted-foreground">
            None linked — age verification at the register keys on these.
          </p>
          <div class="flex flex-col gap-1.5">
            <div
              v-for="link in detail.cannabinoids"
              :key="link.cannabinoid.id"
              class="flex items-center justify-between text-sm"
            >
              <span class="text-muted-foreground">{{ link.cannabinoid.name }}</span>
              <span v-if="potency(link)" class="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary tabular-nums">
                {{ potency(link) }}
              </span>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </div>
          </div>
        </div>

        <div
          v-if="detail.strainType || detail.terpeneProfile || detail.nose"
          class="rounded-xl border bg-card p-3.5"
        >
          <h3 class="mb-2 text-sm font-semibold">Strain</h3>
          <dl class="flex flex-col gap-1.5 text-sm">
            <div v-if="detail.strainType" class="flex justify-between">
              <dt class="text-muted-foreground">Type</dt><dd>{{ detail.strainType }}</dd>
            </div>
            <div v-if="detail.terpeneProfile" class="flex justify-between gap-4">
              <dt class="text-muted-foreground">Terpenes</dt><dd class="text-right">{{ detail.terpeneProfile }}</dd>
            </div>
            <div v-if="detail.nose" class="flex justify-between gap-4">
              <dt class="text-muted-foreground">Nose</dt><dd class="text-right">{{ detail.nose }}</dd>
            </div>
          </dl>
        </div>

        <div class="rounded-xl border bg-card p-3.5">
          <h3 class="mb-2 text-sm font-semibold">Details</h3>
          <dl class="flex flex-col gap-1.5 text-sm">
            <div class="flex justify-between"><dt class="text-muted-foreground">Brand</dt><dd>{{ detail.brand?.name ?? '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Supplier</dt><dd class="truncate text-right">{{ detail.primarySupplier?.name ?? '—' }}</dd></div>
            <div v-if="detail.coaUrl" class="flex justify-between">
              <dt class="text-muted-foreground">COA</dt>
              <dd><a :href="detail.coaUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline-offset-2 hover:underline">View certificate</a></dd>
            </div>
          </dl>
        </div>

        <ProductMediaCard
          v-if="auth.isAdmin || detail.images.length > 1"
          :product="detail"
          :editable="auth.isAdmin"
          @saved="onEdited"
        />
      </div>

      <!-- ————— operations (right) ————— -->
      <div class="flex min-w-0 flex-col gap-3">
        <div class="rounded-xl border bg-card">
          <div class="flex items-center justify-between border-b px-3.5 py-2">
            <h3 class="text-sm font-semibold">Variants</h3>
            <Button
              v-if="auth.isAdmin"
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs text-primary"
              @click="openVariant(null)"
            >
              ＋ Add variant
            </Button>
          </div>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead v-for="store in detail.stores" :key="store.id">{{ store.name }}</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead v-if="auth.isAdmin"><span class="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="v in detail.variants" :key="v.id">
                  <TableCell class="font-medium">{{ v.label ?? detail.name }}</TableCell>
                  <TableCell class="font-mono text-xs text-muted-foreground">{{ v.sku }}</TableCell>
                  <TableCell class="tabular-nums">{{ variantPrice(v) }}</TableCell>
                  <TableCell v-for="store in detail.stores" :key="store.id">
                    <span class="inline-flex items-center gap-1.5 tabular-nums">
                      <span class="size-1.5 rounded-full" :class="statusDot[v.stock.status]" />
                      {{ qtyFor(v, store.id) }}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge v-if="v.active" class="border-transparent bg-primary/10 text-primary">Active</Badge>
                    <Badge v-else variant="secondary">Inactive</Badge>
                  </TableCell>
                  <TableCell v-if="auth.isAdmin" class="text-right">
                    <button
                      type="button"
                      class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      :aria-label="`Edit ${v.label ?? detail.name}`"
                      @click="openVariant(v)"
                    >
                      <Pencil class="size-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>

        <!--
          The strain shelf. Flower only, and admin only because every cell it shows is
          editable — staff get the Variants card above, which is all they can act on.
          Identity lives here rather than on the Variants card so each answers one
          question: that one prices and counts, this one says what the strain IS.
        -->
        <StrainShelf
          v-if="isFlower && auth.isAdmin"
          :product="detail"
          :reference="reference"
          @saved="onEdited"
          @add-strain="openVariant(null)"
        />

        <div class="rounded-xl border bg-card">
          <h3 class="border-b px-3.5 py-2.5 text-sm font-semibold">Inventory by store</h3>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>On hand</TableHead>
                  <TableHead>Reorder at</TableHead>
                  <TableHead v-if="auth.isAdmin">Avg cost</TableHead>
                  <TableHead v-if="auth.isAdmin">Basis</TableHead>
                  <TableHead v-if="auth.isAdmin"><span class="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="row in inventoryRows" :key="row.key">
                  <TableCell>{{ row.variantLabel }}</TableCell>
                  <TableCell class="text-muted-foreground">{{ row.storeName }}</TableCell>
                  <TableCell class="tabular-nums">
                    {{ formatQuantity(row.quantityBase as BaseQuantity, row.trackingMode) }}
                  </TableCell>
                  <TableCell class="tabular-nums text-muted-foreground">
                    {{ row.reorderPointBase !== null ? formatQuantity(row.reorderPointBase as BaseQuantity, row.trackingMode) : '—' }}
                  </TableCell>
                  <TableCell v-if="auth.isAdmin" class="tabular-nums">
                    {{ row.avgUnitCostCents != null ? `${money(row.avgUnitCostCents)}${row.trackingMode === 'WEIGHT' ? '/g' : ''}` : '—' }}
                  </TableCell>
                  <TableCell v-if="auth.isAdmin" class="tabular-nums">{{ money(row.costBasisCents) }}</TableCell>
                  <TableCell v-if="auth.isAdmin" class="text-right">
                    <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" @click="adjustTarget = row">
                      Adjust
                    </Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>

        <div class="rounded-xl border bg-card">
          <div class="flex items-center gap-3 border-b px-3.5 py-2">
            <h3 class="text-sm font-semibold">Movement history</h3>
            <Select
              v-if="detail.variants.length > 1"
              :model-value="selectedVariantId ?? ''"
              @update:model-value="(v) => selectedVariantId = v as string"
            >
              <SelectTrigger class="ml-auto data-[size=default]:h-7 w-44 text-xs" aria-label="Variant for movement history">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="v in detail.variants" :key="v.id" :value="v.id">
                  {{ v.label ?? detail.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="m in movements" :key="m.id">
                  <TableCell class="text-xs text-muted-foreground">{{ when(m.createdAt) }}</TableCell>
                  <TableCell>
                    <span
                      class="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                      :class="movementTone[m.type] ?? 'bg-accent text-muted-foreground'"
                    >
                      {{ m.type }}
                    </span>
                  </TableCell>
                  <TableCell class="tabular-nums" :class="delta(m).cls">{{ delta(m).text }}</TableCell>
                  <TableCell class="tabular-nums text-muted-foreground">
                    {{ formatQuantity(m.balanceAfterBase as BaseQuantity, selectedVariant?.trackingMode ?? 'EACH') }}
                  </TableCell>
                  <TableCell class="text-muted-foreground">{{ m.storeName }}</TableCell>
                  <TableCell class="text-muted-foreground">{{ m.userName ?? '—' }}</TableCell>
                  <TableCell class="max-w-48 truncate text-xs text-muted-foreground" :title="m.note ?? undefined">
                    {{ [m.reasonCode, m.note].filter(Boolean).join(' · ') || '—' }}
                  </TableCell>
                </TableRow>
                <TableEmpty v-if="movements.length === 0" :colspan="7" class="text-muted-foreground">
                  No movements yet for this variant.
                </TableEmpty>
              </TableBody>
            </Table>
          </div>
        </div>

        <div v-if="auth.isAdmin && varianceRows.length" class="rounded-xl border bg-card">
          <h3 class="border-b px-3.5 py-2.5 text-sm font-semibold">Weight variance</h3>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Lost</TableHead>
                  <TableHead>Loss rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="row in varianceRows" :key="row.storeId">
                  <TableCell>{{ row.storeName }}</TableCell>
                  <TableCell class="tabular-nums">{{ formatQuantity(row.receivedBase as BaseQuantity, 'WEIGHT') }}</TableCell>
                  <TableCell class="tabular-nums">{{ formatQuantity(row.lostBase as BaseQuantity, 'WEIGHT') }}</TableCell>
                  <TableCell class="tabular-nums">{{ bps(row.lossRateBps) }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
    <Spinner aria-hidden="true" />Loading…
  </div>

  <!-- An AlertDialog: role="alertdialog", safe choice focused, no dismiss-on-outside-click. -->
  <AlertDialog :open="confirmDeactivate" @update:open="(o: boolean) => !o && (confirmDeactivate = false)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Deactivate {{ detail?.name }}?</AlertDialogTitle>
        <AlertDialogDescription>
          It disappears from the register and the staff catalog. History stays; reactivate
          any time from the catalog's "Include inactive" view.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="outline"
          class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
          :disabled="togglingActive"
          @click="setActive(false)"
        >
          Deactivate
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AdjustStockDialog
    v-if="adjustTarget && detail"
    :open="adjustTarget !== null"
    :variant-id="adjustTarget.variantId"
    :variant-label="adjustTarget.variantLabel"
    :product-name="detail.name"
    :store-id="adjustTarget.storeId"
    :store-name="adjustTarget.storeName"
    :current-base="adjustTarget.quantityBase"
    :tracking-mode="adjustTarget.trackingMode"
    @close="adjustTarget = null"
    @adjusted="onAdjusted"
  />

  <ProductEditDialog
    v-if="detail && reference"
    :open="editProductOpen"
    :product="detail"
    :reference="reference"
    @close="editProductOpen = false"
    @saved="onEdited"
  />

  <PotencyDialog
    v-if="detail && reference"
    :open="potencyOpen"
    :product-id="detail.id"
    :links="detail.cannabinoids"
    :reference="reference"
    @close="potencyOpen = false"
    @saved="onEdited"
  />

  <VariantDialog
    v-if="detail"
    :open="variantOpen"
    :product-id="detail.id"
    :product-name="detail.name"
    :variant="variantEditing"
    :default-mode="isFlower ? 'WEIGHT' : 'EACH'"
    @close="variantOpen = false"
    @saved="onEdited"
  />
</template>
