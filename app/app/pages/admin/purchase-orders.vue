<script setup lang="ts">
import { ClipboardList } from '@lucide/vue'
import type {
  CatalogPage,
  CatalogProduct,
  CatalogReference,
  PurchaseOrderLineRow,
  PurchaseOrderRow,
  SupplierRow,
} from '@huta/shared/schemas'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import {
  formatCents,
  formatGrams,
  formatQuantity,
  parseGramsToBase,
  receiptLineValueCents,
} from '@huta/shared'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Badge } from '~/components/ui/badge'
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
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The purchase orders desk — the internal order log's admin surface (Kasan's picks:
 * 1A master–detail · 2A search-over-rows composer · 3B progress strip).
 *
 * The server's lifecycle shapes everything here: an order is NUMBERED ONLY WHEN PLACED
 * (drafts render "Draft"), lines are editable only while drafting (a placed order's
 * lines are the record of what was asked for), receiving advances the status by
 * itself, and Close short is the single act that turns a shortfall into a reviewable
 * variance on the last delivery. Cancel and Close short are irreversible — both
 * confirm. Counts on the queue chips derive from ONE fetch so they always agree with
 * the list.
 */

const route = useRoute()
const router = useRouter()

/* ————— filters, seeded from the URL ————— */
const queue = ref<'outstanding' | 'drafts' | 'all'>('outstanding')
const storeId = ref<string | undefined>(undefined)
const supplierId = ref<string | undefined>(undefined)
const selectedId = ref<string | null>(null)
{
  const q = route.query
  if (q['queue'] === 'drafts' || q['queue'] === 'all') queue.value = q['queue']
  if (typeof q['store'] === 'string') storeId.value = q['store']
  if (typeof q['supplier'] === 'string') supplierId.value = q['supplier']
  if (typeof q['order'] === 'string') selectedId.value = q['order']
}

function writeQuery() {
  void router.replace({
    query: {
      queue: queue.value === 'outstanding' ? undefined : queue.value,
      store: storeId.value,
      supplier: supplierId.value,
      order: selectedId.value ?? undefined,
    },
  })
}

/* ————— data ————— */
const orders = ref<PurchaseOrderRow[]>([])
const suppliers = ref<SupplierRow[]>([])
const stores = ref<Array<{ id: string, name: string }>>([])
const loading = ref(true)

async function fetchOrders() {
  loading.value = true
  try {
    const data = await apiFetch<{ orders: PurchaseOrderRow[] }>('/purchase-orders')
    orders.value = data.orders
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  const [supplierData, reference] = await Promise.all([
    apiFetch<{ suppliers: SupplierRow[] }>('/suppliers', { query: { includeInactive: 'true' } }).catch(() => ({ suppliers: [] as SupplierRow[] })),
    apiFetch<CatalogReference>('/catalog/reference').catch(() => null),
  ])
  suppliers.value = supplierData.suppliers
  stores.value = reference?.stores ? [...reference.stores] : []
  await fetchOrders()
})

/** Only active suppliers can take a NEW order; old orders keep rendering their names. */
const activeSuppliers = computed(() => suppliers.value.filter((s) => s.active))

/* ————— queues: alternatives, counted from the one fetch ————— */
const counts = computed(() => ({
  outstanding: orders.value.filter((o) => o.outstanding).length,
  drafts: orders.value.filter((o) => o.status === 'DRAFT').length,
  all: orders.value.length,
}))

const visible = computed(() =>
  orders.value.filter((order) => {
    if (queue.value === 'outstanding' && !order.outstanding) return false
    if (queue.value === 'drafts' && order.status !== 'DRAFT') return false
    if (storeId.value && order.storeId !== storeId.value) return false
    if (supplierId.value && order.supplierId !== supplierId.value) return false
    return true
  }),
)

function setQueue(next: 'outstanding' | 'drafts' | 'all') {
  queue.value = queue.value === next ? 'all' : next
  writeQuery()
}

/* ————— selection ————— */
const selected = computed(() => orders.value.find((o) => o.id === selectedId.value) ?? null)

watch(visible, (list) => {
  if (creating.value) return
  if (!list.some((o) => o.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
    writeQuery()
  }
})

function select(id: string) {
  creating.value = false
  selectedId.value = id
  actionError.value = null
  writeQuery()
}

/* ————— the draft form (create + draft edit share it) ————— */
interface DraftLine {
  variantId: string
  name: string
  sku: string
  trackingMode: TrackingMode
  /** Typed grams for WEIGHT, a whole count for EACH — strings, never floats. */
  qty: string
  /** Dollars; per gram for WEIGHT, per item for EACH. Blank = no cost yet. */
  cost: string
}

const creating = ref(false)
const dStoreId = ref('')
const dSupplierId = ref('')
const dExpected = ref('')
const dNotes = ref('')
const dLines = ref<DraftLine[]>([])
const saving = ref(false)
const actionError = ref<string | null>(null)

const isDraft = computed(() => selected.value?.status === 'DRAFT')
const composing = computed(() => creating.value || isDraft.value)

function startNew() {
  creating.value = true
  selectedId.value = null
  dStoreId.value = stores.value[0]?.id ?? ''
  dSupplierId.value = ''
  dExpected.value = ''
  dNotes.value = ''
  dLines.value = []
  term.value = ''
  results.value = []
  actionError.value = null
  writeQuery()
}

/** Rehydrate the form from the selected draft — mg → grams, cents → dollars. */
function syncDraft() {
  const order = selected.value
  if (!order || order.status !== 'DRAFT') return
  dSupplierId.value = order.supplierId
  dExpected.value = order.expectedAt ? order.expectedAt.slice(0, 10) : ''
  dNotes.value = order.notes ?? ''
  dLines.value = order.lines.map((line) => ({
    variantId: line.variantId,
    name: lineName(line),
    sku: line.sku,
    trackingMode: line.trackingMode as TrackingMode,
    qty:
      line.trackingMode === 'WEIGHT'
        ? formatGrams(line.quantityBase as BaseQuantity, { suffix: false })
        : String(line.quantityBase),
    cost: line.unitCostCents != null ? (line.unitCostCents / 100).toFixed(2) : '',
  }))
}
watch([selectedId, orders], syncDraft, { immediate: true })

/* ————— composer search (the Record-delivery mechanics) ————— */
const term = ref('')
const results = ref<Array<{ variantId: string, name: string, sku: string, trackingMode: TrackingMode }>>([])
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(term, () => {
  clearTimeout(searchTimer)
  const q = term.value.trim()
  if (q.length < 2) {
    results.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      const page = await apiFetch<CatalogPage>('/catalog/products', {
        query: { search: q, pageSize: 8, active: 'all' },
      })
      results.value = (page.products as CatalogProduct[]).flatMap((p) =>
        p.variants.map((v) => ({
          variantId: v.id,
          name: v.label && v.label !== p.name ? `${p.name} · ${v.label}` : p.name,
          sku: v.sku,
          trackingMode: v.trackingMode,
        })),
      )
    } catch {
      results.value = []
    }
  }, 250)
})

function addLine(hit: { variantId: string, name: string, sku: string, trackingMode: TrackingMode }) {
  if (!dLines.value.some((l) => l.variantId === hit.variantId)) {
    // An order's count starts at one; grams are keyed. (Receiving's blank-count rule is
    // about what ARRIVED — an order line is what's being asked for.)
    dLines.value.push({ ...hit, qty: hit.trackingMode === 'EACH' ? '1' : '', cost: '' })
  }
  term.value = ''
  results.value = []
}

function removeLine(variantId: string) {
  dLines.value = dLines.value.filter((l) => l.variantId !== variantId)
}

/* ————— parsing: strings in, integers out, never floats ————— */
function lineBase(line: DraftLine): number | null {
  const raw = line.qty.trim()
  if (raw === '') return null
  if (line.trackingMode === 'WEIGHT') {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null
}

/** Blank is legal (no cost yet); malformed is 'invalid'. */
function lineCost(line: DraftLine): number | null | 'invalid' {
  const raw = line.cost.trim().replace(/^\$/, '')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'invalid'
  const [whole, frac = ''] = raw.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0')
}

function draftLineValue(line: DraftLine): number | null {
  const base = lineBase(line)
  const cost = lineCost(line)
  if (base === null || cost === null || cost === 'invalid') return null
  return receiptLineValueCents(line.trackingMode, base as BaseQuantity, cost as Cents)
}

const draftValueCents = computed(() => {
  let sum = 0
  let any = false
  for (const line of dLines.value) {
    const value = draftLineValue(line)
    if (value !== null) {
      sum += value
      any = true
    }
  }
  return any ? sum : null
})

const draftValid = computed(
  () =>
    dSupplierId.value !== '' &&
    (!creating.value || dStoreId.value !== '') &&
    dLines.value.length >= 1 &&
    dLines.value.every((l) => lineBase(l) !== null && lineCost(l) !== 'invalid'),
)

/* ————— actions ————— */
/** Noon UTC dodges the date-boundary drift a bare midnight date invites. */
const expectedIso = () =>
  dExpected.value ? new Date(`${dExpected.value}T12:00:00Z`).toISOString() : null

function draftBody() {
  return {
    supplierId: dSupplierId.value,
    expectedAt: expectedIso(),
    notes: dNotes.value.trim() || null,
    lines: dLines.value.map((l) => ({
      variantId: l.variantId,
      quantityBase: lineBase(l)!,
      ...(lineCost(l) !== null && lineCost(l) !== 'invalid'
        ? { unitCostCents: lineCost(l) as number }
        : {}),
    })),
  }
}

async function saveDraft() {
  if (!draftValid.value || saving.value) return
  saving.value = true
  actionError.value = null
  try {
    if (creating.value) {
      const created = await apiFetch<PurchaseOrderRow>('/purchase-orders', {
        method: 'POST',
        body: { storeId: dStoreId.value, ...draftBody() },
      })
      creating.value = false
      await fetchOrders()
      if (queue.value === 'outstanding') queue.value = 'drafts'
      selectedId.value = created.id
      writeQuery()
    } else if (selected.value) {
      await apiFetch(`/purchase-orders/${selected.value.id}`, {
        method: 'PATCH',
        body: draftBody(),
      })
      await fetchOrders()
    }
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    saving.value = false
  }
}

async function runAction(path: string) {
  if (!selected.value || saving.value) return
  saving.value = true
  actionError.value = null
  try {
    await apiFetch(`/purchase-orders/${selected.value.id}/${path}`, { method: 'POST' })
    await fetchOrders()
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    saving.value = false
  }
}

async function place() {
  const id = selected.value?.id ?? null
  await runAction('place')
  // Follow the order out of the Drafts queue — losing it the moment it's placed would
  // read as the place having failed.
  if (id && !actionError.value) {
    queue.value = 'outstanding'
    selectedId.value = id
    writeQuery()
  }
}

const cancelConfirm = ref(false)
async function confirmCancel() {
  cancelConfirm.value = false
  await runAction('cancel')
}

const closeShortConfirm = ref(false)
async function confirmCloseShort() {
  closeShortConfirm.value = false
  await runAction('close-short')
}

/* ————— display ————— */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ORDERED: 'Ordered',
  PARTIALLY_RECEIVED: 'Part received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
}
const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'bg-accent text-muted-foreground',
  ORDERED: 'bg-primary/10 text-primary',
  PARTIALLY_RECEIVED: 'bg-amber-500/10 text-amber-500',
  RECEIVED: 'bg-accent text-muted-foreground',
  CANCELLED: 'bg-red-400/10 text-red-400',
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const when = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—')

const lineName = (line: PurchaseOrderLineRow) =>
  line.label && line.label !== line.productName
    ? `${line.productName} · ${line.label}`
    : line.productName

const qty = (base: number, mode: string) => formatQuantity(base as BaseQuantity, mode as TrackingMode)

const unitOf = (mode: string) => (mode === 'WEIGHT' ? 'g' : 'ct')

function costLabel(line: PurchaseOrderLineRow): string {
  if (line.unitCostCents == null) return '—'
  return `${formatCents(line.unitCostCents as Cents)}/${unitOf(line.trackingMode)}`
}

/** "—" complete · "+2 over" amber · "168.00g to come" muted. */
function outstandingCell(line: PurchaseOrderLineRow): { text: string, cls: string } {
  if (line.varianceBase === 0) return { text: '—', cls: 'text-muted-foreground' }
  if (line.varianceBase > 0)
    return { text: `+${qty(line.varianceBase, line.trackingMode)} over`, cls: 'text-amber-500' }
  return { text: `${qty(-line.varianceBase, line.trackingMode)} to come`, cls: 'text-muted-foreground' }
}

/** 3B: per-LINE completion — a unit percentage across grams and counts would be nonsense. */
const progress = computed(() => {
  const order = selected.value
  if (!order || order.status === 'DRAFT' || order.status === 'CANCELLED') return null
  const complete = order.lines.filter((l) => l.receivedBase >= l.quantityBase).length
  return { complete, total: order.lines.length, pct: order.lines.length ? complete / order.lines.length : 0 }
})

const money = (cents: number | null | undefined) =>
  cents == null ? '—' : formatCents(cents as Cents)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Orders</h1>
      <p class="text-sm text-muted-foreground">
        The internal order log — numbered when placed, received at the register, closed here.
      </p>
    </div>

    <!-- queues + filters -->
    <div class="flex flex-wrap items-center gap-2">
      <!--
        The queue chips are ALTERNATIVE queues, never ANDed. ToggleGroup gives them roving
        arrow-key navigation for free; re-selecting the active chip clears it, which is the
        same "fall back to All" behaviour setQueue() already had. The dashed border is kept
        deliberately — it is the house affordance for a filter that is not set.
      -->
      <ToggleGroup
        :model-value="queue"
        type="single"
        :spacing="2"
        aria-label="Queue"
        @update:model-value="(v) => setQueue((v as typeof queue) || 'all')"
      >
        <ToggleGroupItem
          v-for="chip in ([
            { key: 'outstanding', label: 'Outstanding', count: counts.outstanding },
            { key: 'drafts', label: 'Drafts', count: counts.drafts },
            { key: 'all', label: 'All', count: counts.all },
          ] as const)"
          :key="chip.key"
          :value="chip.key"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
        >
          {{ chip.label }}
          <Badge variant="secondary" class="h-5 min-w-5 justify-center px-1 text-xs">{{ chip.count }}</Badge>
        </ToggleGroupItem>
      </ToggleGroup>

      <div class="ml-auto flex items-center gap-2">
        <Select
          :model-value="storeId ?? 'all'"
          @update:model-value="(v) => { storeId = v === 'all' ? undefined : (v as string); writeQuery() }"
        >
          <SelectTrigger class="h-8 w-40" aria-label="Store filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stores</SelectItem>
            <SelectItem v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          :model-value="supplierId ?? 'all'"
          @update:model-value="(v) => { supplierId = v === 'all' ? undefined : (v as string); writeQuery() }"
        >
          <SelectTrigger class="h-8 w-44" aria-label="Supplier filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All suppliers</SelectItem>
            <SelectItem v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">
              {{ supplier.name }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" class="h-8" @click="startNew">＋ New order</Button>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 items-start gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
      <!-- master list -->
      <div class="flex flex-col gap-1.5" :class="loading ? 'pointer-events-none opacity-50' : ''">
        <button
          v-for="order in visible"
          :key="order.id"
          type="button"
          class="rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
          :class="order.id === selectedId && !creating ? 'border-primary/50 bg-primary/5' : ''"
          @click="select(order.id)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono text-sm font-semibold" :class="order.status === 'DRAFT' ? 'text-muted-foreground' : 'text-primary'">
              {{ order.reference }}
            </span>
            <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" :class="STATUS_CLASS[order.status] ?? 'bg-accent'">
              {{ STATUS_LABEL[order.status] ?? order.status }}
            </span>
          </div>
          <p class="mt-0.5 truncate text-xs text-muted-foreground">
            {{ order.supplierName }} · {{ order.status === 'DRAFT' ? 'not placed' : when(order.orderedAt) }}
          </p>
        </button>
        <Empty v-if="!visible.length && !loading" class="flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
            <EmptyTitle>{{ queue === 'outstanding' ? 'Nothing outstanding' : queue === 'drafts' ? 'No drafts' : 'No orders yet' }}</EmptyTitle>
            <EmptyDescription v-if="queue === 'outstanding'">Every placed order is in.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>

      <!-- detail / composer -->
      <div class="rounded-xl border bg-card p-4">
        <!-- ————— composer: creating, or a selected draft ————— -->
        <template v-if="composing">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-mono text-base font-bold">{{ creating ? 'New order' : 'Draft' }}</h2>
            <span v-if="!creating && selected" class="rounded bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {{ selected.storeName }}
            </span>
          </div>

          <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field v-if="creating">
              <FieldLabel for="po-store" class="text-xs">Store</FieldLabel>
              <Select v-model="dStoreId">
                <SelectTrigger id="po-store" class="data-[size=default]:h-9 w-full"><SelectValue placeholder="Pick a store" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="po-supplier" class="text-xs">Supplier</FieldLabel>
              <Select v-model="dSupplierId">
                <SelectTrigger id="po-supplier" class="data-[size=default]:h-9 w-full"><SelectValue placeholder="Pick a supplier" /></SelectTrigger>
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
              <!-- The vendored Input, not a hand-copied class string: this was re-implementing
                   Input's own classes two elements away from a real one. -->
              <Input id="po-expected" v-model="dExpected" type="date" class="h-9" />
            </Field>
            <Field :class="creating ? '' : 'lg:col-span-2'">
              <FieldLabel for="po-notes" class="text-xs">
                Notes <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id="po-notes" v-model="dNotes" autocomplete="off" maxlength="2000" class="h-9" />
            </Field>
          </div>

          <!-- line composer: 2A — search over stacked rows -->
          <div class="relative mt-4">
            <SearchInput
              v-model="term"
              placeholder="Add a line — search product or SKU…"
              autocomplete="off"
              aria-label="Search products to add"
            />
            <div
              v-if="results.length"
              class="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
            >
              <button
                v-for="hit in results"
                :key="hit.variantId"
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                @click="addLine(hit)"
              >
                <span class="min-w-0 flex-1 truncate font-medium">{{ hit.name }}</span>
                <span class="font-mono text-xs text-muted-foreground">{{ hit.sku }}</span>
                <span class="text-xs text-muted-foreground">{{ hit.trackingMode === 'WEIGHT' ? 'weight' : 'each' }}</span>
              </button>
            </div>
          </div>

          <div class="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Unit cost</TableHead>
                  <TableHead class="text-right"><span class="sr-only">Remove</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="line in dLines" :key="line.variantId">
                  <TableCell>
                    <span class="font-medium">{{ line.name }}</span>
                    <span class="block font-mono text-xs text-muted-foreground">{{ line.sku }}</span>
                  </TableCell>
                  <TableCell>
                    <InputGroup
                      class="h-8 w-24"
                      :class="lineBase(line) === null && line.qty.trim() !== '' ? 'border-red-400/60' : ''"
                    >
                      <InputGroupInput
                        v-model="line.qty"
                        :inputmode="line.trackingMode === 'WEIGHT' ? 'decimal' : 'numeric'"
                        autocomplete="off"
                        class="text-sm tabular-nums"
                        :aria-label="`Quantity of ${line.name}`"
                      />
                      <InputGroupAddon align="inline-end" class="text-xs">
                        {{ unitOf(line.trackingMode) }}
                      </InputGroupAddon>
                    </InputGroup>
                  </TableCell>
                  <TableCell>
                    <InputGroup
                      class="h-8 w-28"
                      :class="lineCost(line) === 'invalid' ? 'border-red-400/60' : ''"
                    >
                      <InputGroupAddon class="text-xs">$</InputGroupAddon>
                      <InputGroupInput
                        v-model="line.cost"
                        inputmode="decimal"
                        autocomplete="off"
                        class="text-sm tabular-nums"
                        :aria-label="`Unit cost of ${line.name}`"
                      />
                      <InputGroupAddon align="inline-end" class="text-xs">
                        /{{ unitOf(line.trackingMode) }}
                      </InputGroupAddon>
                    </InputGroup>
                  </TableCell>
                  <TableCell class="text-right">
                    <button
                      type="button"
                      class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      :aria-label="`Remove ${line.name}`"
                      @click="removeLine(line.variantId)"
                    >
                      ✕
                    </button>
                  </TableCell>
                </TableRow>
                <TableEmpty v-if="!dLines.length" :colspan="4" class="text-muted-foreground">
                  Search above to add the first line.
                </TableEmpty>
              </TableBody>
              <TableFooter v-if="draftValueCents !== null">
                <TableRow>
                  <TableCell class="text-xs font-normal text-muted-foreground">Order value</TableCell>
                  <TableCell colspan="3" class="text-right font-semibold tabular-nums">
                    {{ money(draftValueCents) }}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          <FieldError v-if="actionError" class="mt-2">{{ actionError }}</FieldError>

          <div class="mt-3 flex items-center gap-2 border-t pt-3">
            <span class="mr-auto text-xs text-muted-foreground">
              Lines can only be changed while the order is a draft — placing it mints the number.
            </span>
            <Button v-if="creating" variant="ghost" size="sm" @click="creating = false">Cancel</Button>
            <Button
              v-else
              variant="ghost"
              size="sm"
              class="text-red-400 hover:bg-red-400/10 hover:text-red-400"
              :disabled="saving"
              @click="cancelConfirm = true"
            >
              Discard draft…
            </Button>
            <Button size="sm" variant="outline" :disabled="!draftValid || saving" @click="saveDraft">
              {{ saving ? 'Saving…' : creating ? 'Save draft' : 'Save changes' }}
            </Button>
            <Button v-if="!creating" size="sm" :disabled="saving" @click="place">Place order</Button>
          </div>
        </template>

        <!-- ————— a placed / closed order ————— -->
        <template v-else-if="selected">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-mono text-base font-bold text-primary">{{ selected.reference }}</h2>
            <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" :class="STATUS_CLASS[selected.status] ?? 'bg-accent'">
              {{ STATUS_LABEL[selected.status] ?? selected.status }}
            </span>
            <span class="rounded bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {{ selected.storeName }}
            </span>
            <span class="ml-auto text-xs text-muted-foreground">
              {{ selected.supplierName }}
              <template v-if="selected.expectedAt"> · expected {{ when(selected.expectedAt) }}</template>
              <template v-if="selected.cancelledAt"> · cancelled {{ when(selected.cancelledAt) }}</template>
            </span>
          </div>

          <!-- 3B: the progress strip -->
          <div v-if="progress" class="mt-3">
            <div class="flex items-baseline justify-between text-sm">
              <span><b>{{ progress.complete }} of {{ progress.total }}</b> lines complete</span>
              <span class="text-xs text-muted-foreground">
                <template v-if="selected.daysToFirstReceipt !== null">first delivery in {{ selected.daysToFirstReceipt }}d · </template>
                {{ selected.receiptCount }} {{ selected.receiptCount === 1 ? 'delivery' : 'deliveries' }}
              </span>
            </div>
            <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-accent">
              <div class="h-full bg-primary transition-all" :style="{ width: `${Math.round(progress.pct * 100)}%` }" />
            </div>
          </div>

          <div class="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Ordered</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Unit cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="line in selected.lines" :key="line.id">
                  <TableCell>
                    <span class="font-medium">{{ lineName(line) }}</span>
                    <span class="block font-mono text-xs text-muted-foreground">{{ line.sku }}</span>
                  </TableCell>
                  <TableCell class="tabular-nums">{{ qty(line.quantityBase, line.trackingMode) }}</TableCell>
                  <TableCell class="tabular-nums">{{ qty(line.receivedBase, line.trackingMode) }}</TableCell>
                  <TableCell class="tabular-nums" :class="outstandingCell(line).cls">
                    {{ outstandingCell(line).text }}
                  </TableCell>
                  <TableCell class="tabular-nums">{{ costLabel(line) }}</TableCell>
                </TableRow>
              </TableBody>
              <TableFooter v-if="selected.totalCostCents != null">
                <TableRow>
                  <TableCell class="text-xs font-normal text-muted-foreground">Order value</TableCell>
                  <TableCell colspan="4" class="text-right font-semibold tabular-nums">
                    {{ money(selected.totalCostCents) }}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          <p v-if="selected.notes" class="mt-3 rounded-lg border bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            {{ selected.notes }}
          </p>

          <p class="mt-3 text-xs text-muted-foreground">
            Placed by {{ selected.orderedByName }} on {{ when(selected.orderedAt) }} ·
            {{ selected.receiptCount }} {{ selected.receiptCount === 1 ? 'delivery' : 'deliveries' }} so far.
          </p>

          <FieldError v-if="actionError" class="mt-2">{{ actionError }}</FieldError>

          <div v-if="selected.status === 'PARTIALLY_RECEIVED' || selected.outstanding" class="mt-3 flex items-center gap-2 border-t pt-3">
            <span class="mr-auto text-xs text-muted-foreground">
              A placed order's lines are the record of what was asked for.
            </span>
            <Button
              v-if="selected.status === 'PARTIALLY_RECEIVED'"
              size="sm"
              variant="outline"
              :disabled="saving"
              @click="closeShortConfirm = true"
            >
              Close short
            </Button>
            <Button
              v-if="selected.outstanding"
              size="sm"
              variant="outline"
              class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
              :disabled="saving"
              @click="cancelConfirm = true"
            >
              Cancel order
            </Button>
          </div>
        </template>

        <Empty v-else class="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
            <EmptyTitle>No order selected</EmptyTitle>
            <EmptyDescription>Pick one on the left, or raise a new one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>

    <!--
      cancel: irreversible — an AlertDialog, not a Dialog. It carries role="alertdialog",
      focuses the safe choice, and refuses to close on a click outside or on Escape, all of
      which are what you want for a decision that cannot be undone.
    -->
    <AlertDialog :open="cancelConfirm" @update:open="(o: boolean) => !o && (cancelConfirm = false)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ isDraft ? 'Discard this draft?' : `Cancel ${selected?.reference}?` }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="isDraft">
              The draft is closed for good — nothing was ever placed, so nothing else changes.
            </template>
            <template v-else>
              The order closes for good — there is no un-cancel. Deliveries already received
              stay received; anything still expected must be re-ordered fresh.
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
            :disabled="saving"
            @click="confirmCancel"
          >
            {{ isDraft ? 'Discard draft' : 'Cancel order' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- close short: the shortfall becomes a variance -->
    <AlertDialog :open="closeShortConfirm" @update:open="(o: boolean) => !o && (closeShortConfirm = false)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {{ selected?.reference }} short?</AlertDialogTitle>
          <AlertDialogDescription>
            The order is marked received as-is, and the shortfall lands on its last
            delivery as a variance for review on the Receiving desk. No more deliveries
            can be taken against it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep waiting</AlertDialogCancel>
          <AlertDialogAction :disabled="saving" @click="confirmCloseShort">Close short</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
