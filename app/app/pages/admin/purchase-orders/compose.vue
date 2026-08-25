<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import type {
  CatalogPage,
  CatalogProduct,
  CatalogReference,
  PurchaseOrderRow,
  SupplierRow,
} from '@huta/shared/schemas'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Badge } from '~/components/ui/badge'
import { Spinner } from '~/components/ui/spinner'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'
import { usePurchaseOrderDraft } from '~/composables/usePurchaseOrderDraft'

/**
 * Composing an order, on its own page (Kasan's pick C — shelf left, order right).
 *
 * Pick a supplier and their whole shelf appears with your stock position on every row, so the
 * screen answers "what do I need to order?" rather than only recording an answer arrived at
 * somewhere else. Both panes bind the same keyed maps, so there is no "add to order" step.
 *
 * ONE route serves create and draft-edit, keyed on `?draft=`. The reason is the save
 * round-trip: after a create, `router.replace` swaps in the new id WITHOUT changing the route
 * component, so the shelf is not refetched, the scroll position survives, and there is no
 * flash. Two route files would make that a real navigation.
 */

useHead({ title: 'New order · Huta' })

const route = useRoute()
const router = useRouter()

const draft = usePurchaseOrderDraft()
const {
  storeId, supplierId, expected, notes,
  qty, cost, shelf, lines, valueCents, invalidRows,
  shelfLoading, loadError, truncated, valid, dirty, saving, actionError,
} = draft

const suppliers = ref<SupplierRow[]>([])
const stores = ref<Array<{ id: string, name: string }>>([])
const booting = ref(true)
const draftId = computed(() => (typeof route.query['draft'] === 'string' ? route.query['draft'] : null))

/** Only an active supplier can take a new order; the server refuses an inactive one. */
const activeSuppliers = computed(() => suppliers.value.filter((s) => s.active))
const supplierName = computed(() => suppliers.value.find((s) => s.id === supplierId.value)?.name ?? '')
const storeName = computed(() => stores.value.find((s) => s.id === storeId.value)?.name ?? '')

/** Store is fixed once the order exists — the server omits storeId from the PATCH body. */
const storeLocked = computed(() => draft.orderId.value !== null)

onMounted(async () => {
  const [supplierData, reference] = await Promise.all([
    apiFetch<{ suppliers: SupplierRow[] }>('/suppliers', { query: { includeInactive: 'true' } })
      .catch(() => ({ suppliers: [] as SupplierRow[] })),
    apiFetch<CatalogReference>('/catalog/reference').catch(() => null),
  ])
  suppliers.value = supplierData.suppliers
  stores.value = reference?.stores ? [...reference.stores] : []

  if (draftId.value) {
    try {
      const order = await apiFetch<PurchaseOrderRow>(`/purchase-orders/${draftId.value}`)
      if (order.status !== 'DRAFT') {
        // Only a draft is editable. Land the reader on the order rather than on a form that
        // would fail at save.
        await router.replace(`/admin/purchase-orders?queue=all&order=${order.id}`)
        return
      }
      await draft.seed(order)
    } catch (err) {
      actionError.value = err instanceof ApiError ? err.message : 'That order could not be opened.'
    }
  } else {
    const seedStore = typeof route.query['store'] === 'string' ? route.query['store'] : stores.value[0]?.id
    draft.startNew(seedStore ?? '')
    const seedSupplier = typeof route.query['supplier'] === 'string' ? route.query['supplier'] : ''
    if (seedSupplier) {
      supplierId.value = seedSupplier
      await draft.loadShelf()
    }
  }
  booting.value = false
})

/**
 * Changing supplier or store refetches the shelf and KEEPS the keyed quantities — anything
 * that falls off the new shelf becomes an orphan, which is exactly right: it is still on the
 * order until someone removes it.
 */
watch([supplierId, storeId], () => {
  if (booting.value) return
  void draft.loadShelf()
})

/* ————— the scope escape ————— */
const term = ref('')
const results = ref<Array<{ variantId: string, productId: string, name: string, sku: string }>>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Reaches ANY product, not just this supplier's — half the catalogue has no supplier at all,
 * and the server only requires a supplier on the order, never on its lines.
 */
watch(term, () => {
  clearTimeout(searchTimer)
  const q = term.value.trim()
  if (q.length < 2) {
    results.value = []
    searching.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(async () => {
    try {
      const page = await apiFetch<CatalogPage>('/catalog/products', {
        query: { search: q, pageSize: 8, active: 'all', storeId: storeId.value },
      })
      results.value = (page.products as CatalogProduct[]).flatMap((p) =>
        p.variants.map((v) => ({
          variantId: v.id,
          productId: p.id,
          name: v.label && v.label !== p.name ? `${p.name} · ${v.label}` : p.name,
          sku: v.sku,
        })),
      )
    } catch {
      results.value = []
    } finally {
      searching.value = false
    }
  }, 250)
})

async function pick(hit: { variantId: string, productId: string }) {
  await draft.adoptVariant(hit.variantId, hit.productId)
  // Seeding a 1 here (rather than leaving it blank as a shelf row does) is the point of the
  // action: this variant was deliberately sought out and added.
  const row = shelf.value.find((r) => r.variantId === hit.variantId)
  if (row && !(qty.value[hit.variantId] ?? '').trim()) {
    qty.value[hit.variantId] = row.trackingMode === 'EACH' ? '1' : ''
  }
  term.value = ''
  results.value = []
}

/* ————— shelf filter ————— */
const filter = ref('')
const belowReorderOnly = ref(false)

const visibleRows = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  return shelf.value.filter((row) => {
    // An orphan is on the order — never filter it out of sight, or removing it becomes
    // impossible and a save would silently keep it.
    if (row.orphan) return true
    if (needle && !row.name.toLowerCase().includes(needle) && !row.sku.toLowerCase().includes(needle)) return false
    if (belowReorderOnly.value && !(row.reorderBase !== null && row.onHandBase <= row.reorderBase)) return false
    return true
  })
})

const belowReorderCount = computed(
  () => shelf.value.filter((r) => !r.orphan && r.reorderBase !== null && r.onHandBase <= r.reorderBase).length,
)

/* ————— actions ————— */
async function onSave() {
  const saved = await draft.save()
  if (!saved) return
  if (draftId.value !== saved.id) {
    // Same route component, so the shelf is untouched and the page does not flash.
    await router.replace({ query: { draft: saved.id } })
  }
}

async function onPlace() {
  const placed = await draft.place()
  if (!placed) return
  await router.replace(`/admin/purchase-orders?order=${placed.id}`)
}

/**
 * ⚠️ The open flag is its OWN ref, never the thing the action reads. reka closes an
 * AlertDialog on click and `@update:open` fires BEFORE the fallthrough handler, so a ref that
 * doubles as "which row" and "is it open" is null by the time the handler runs — which
 * shipped as a silent no-op on three pages.
 */
const discardOpen = ref(false)
async function confirmDiscard() {
  discardOpen.value = false
  const id = draft.orderId.value
  if (!id) {
    await router.replace('/admin/purchase-orders')
    return
  }
  try {
    // DELETE, not cancel: a draft was never placed and holds no number, so a cancelled
    // tombstone would just be litter in a queue meant to hold work.
    await apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' })
    await router.replace('/admin/purchase-orders')
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  }
}

/* ————— leaving with work in progress ————— */
const leaveGuard = (event: BeforeUnloadEvent) => {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', leaveGuard))
onBeforeUnmount(() => window.removeEventListener('beforeunload', leaveGuard))

onBeforeRouteLeave(() => {
  if (!dirty.value || saving.value) return true
  return window.confirm('Leave without saving? The quantities you have keyed will be lost.')
})

const backHref = computed(() =>
  draft.orderId.value
    ? `/admin/purchase-orders?queue=all&order=${draft.orderId.value}`
    : '/admin/purchase-orders',
)
</script>

<template>
  <!--
    `@container` is load-bearing, not decoration: the two-pane split below is a CONTAINER
    query, so without a marked ancestor the `@4xl:` classes never match and the order pane
    silently drops underneath the shelf. Container rather than viewport because the
    collapsible sidebar changes the content width without changing the window — the same
    screen would otherwise stack at one sidebar state and not the other.
  -->
  <div class="@container flex flex-col gap-4">
    <!-- header -->
    <div class="flex flex-wrap items-start gap-3">
      <Button variant="ghost" size="sm" as-child class="-ml-2 h-8">
        <NuxtLink :to="backHref"><ArrowLeft class="size-4" /> Orders</NuxtLink>
      </Button>
      <div class="min-w-0">
        <h1 class="text-xl font-bold tracking-tight">
          {{ draft.orderId.value ? 'Edit draft' : 'New order' }}
        </h1>
        <p class="truncate text-sm text-muted-foreground">
          <template v-if="supplierName">{{ supplierName }} · {{ storeName }}</template>
          <template v-else>Pick a supplier to see what they sell.</template>
        </p>
      </div>
    </div>

    <!-- order facts -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field>
        <FieldLabel for="po-store" class="text-xs">Store</FieldLabel>
        <Select v-model="storeId" :disabled="storeLocked">
          <SelectTrigger id="po-store" class="w-full data-[size=default]:h-9">
            <SelectValue placeholder="Pick a store" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel for="po-supplier" class="text-xs">Supplier</FieldLabel>
        <Select v-model="supplierId">
          <SelectTrigger id="po-supplier" class="w-full data-[size=default]:h-9">
            <SelectValue placeholder="Pick a supplier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="supplier in activeSuppliers" :key="supplier.id" :value="supplier.id">
              {{ supplier.name }}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel for="po-expected" class="text-xs">
          Expected <span class="font-normal text-muted-foreground">(optional)</span>
        </FieldLabel>
        <Input id="po-expected" v-model="expected" type="date" class="h-9" />
      </Field>
      <Field>
        <FieldLabel for="po-notes" class="text-xs">
          Notes <span class="font-normal text-muted-foreground">(optional)</span>
        </FieldLabel>
        <Input id="po-notes" v-model="notes" autocomplete="off" maxlength="2000" class="h-9" />
      </Field>
    </div>

    <!-- no supplier yet -->
    <div v-if="!supplierId" class="rounded-xl border border-dashed px-4 py-10 text-center">
      <p class="text-sm font-medium">Pick a supplier to load their shelf</p>
      <p class="mt-1 text-sm text-muted-foreground">
        Every product they sell appears with its stock position, so you can order down the list.
      </p>
    </div>

    <template v-else>
      <!-- filters + the scope escape -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :class="belowReorderOnly ? 'border-solid border-primary/50 text-foreground' : ''"
          :aria-pressed="belowReorderOnly"
          @click="belowReorderOnly = !belowReorderOnly"
        >
          Below reorder
          <Badge variant="secondary" class="h-5 min-w-5 justify-center px-1 text-xs">{{ belowReorderCount }}</Badge>
        </button>
        <SearchInput
          v-model="filter"
          class="h-8 w-56"
          placeholder="Filter this shelf…"
          autocomplete="off"
          aria-label="Filter this supplier's products"
        />

        <div class="relative ml-auto">
          <SearchInput
            v-model="term"
            class="h-8 w-64"
            placeholder="Search all products…"
            autocomplete="off"
            aria-label="Search every product, including other suppliers"
          />
          <div
            v-if="results.length || searching"
            class="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
          >
            <p v-if="searching && !results.length" class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" /> Searching…
            </p>
            <button
              v-for="hit in results"
              :key="hit.variantId"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              @click="pick(hit)"
            >
              <span class="min-w-0 flex-1 truncate font-medium">{{ hit.name }}</span>
              <span class="font-mono text-xs text-muted-foreground">{{ hit.sku }}</span>
            </button>
          </div>
        </div>
      </div>

      <p v-if="truncated" class="text-xs text-amber-500">
        This supplier has more products than fit one page — the shelf below is not the whole list.
      </p>
      <FieldError v-if="loadError">{{ loadError }}</FieldError>

      <!-- shelf + order -->
      <div class="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_360px]">
        <PurchasingSupplierShelf
          :rows="visibleRows"
          :qty="qty"
          :supplier-id="supplierId"
          :loading="shelfLoading"
          @remove="draft.removeRow"
        />

        <PurchasingOrderSheet
          :lines="lines"
          :cost="cost"
          :value-cents="valueCents"
          class="@4xl:sticky @4xl:top-4"
          @remove="draft.removeRow"
          @touch-cost="draft.touchCost"
        >
          <template #actions>
            <FieldError v-if="actionError" class="mb-2">{{ actionError }}</FieldError>
            <p v-else-if="invalidRows.length" class="mb-2 text-xs text-red-400">
              {{ invalidRows.length }} {{ invalidRows.length === 1 ? 'row has' : 'rows have' }}
              something that isn’t a number.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" class="flex-1" :disabled="!valid || saving" @click="onSave">
                {{ saving ? 'Saving…' : 'Save draft' }}
              </Button>
              <Button size="sm" class="flex-1" :disabled="!valid || saving" @click="onPlace">Place order</Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="mt-2 w-full text-red-400 hover:bg-red-400/10 hover:text-red-400"
              :disabled="saving"
              @click="discardOpen = true"
            >
              {{ draft.orderId.value ? 'Delete draft…' : 'Cancel' }}
            </Button>
          </template>
        </PurchasingOrderSheet>
      </div>
    </template>

    <AlertDialog :open="discardOpen" @update:open="(o: boolean) => !o && (discardOpen = false)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ draft.orderId.value ? 'Delete this draft?' : 'Leave without saving?' }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="draft.orderId.value">
              It is removed entirely, along with its lines. Nothing was ever placed, so there
              is no gap left behind — but there is no undo either.
            </template>
            <template v-else>
              Nothing has been saved yet, so the quantities you have keyed will be lost.
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep editing</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
            @click="confirmDiscard"
          >
            {{ draft.orderId.value ? 'Delete draft' : 'Leave' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
