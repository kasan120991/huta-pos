<script setup lang="ts">
import { ClipboardList } from '@lucide/vue'
import type { PurchaseOrderLineRow, PurchaseOrderRow, SupplierRow } from '@huta/shared/schemas'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatQuantity } from '@huta/shared'
import type { CatalogReference } from '@huta/shared/schemas'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { FieldError } from '~/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
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
 * The purchase orders desk — the internal order log (Kasan's pick 2: the exception ledger).
 *
 * A list is WORK, not an archive. Orders that need something doing sit in a tinted band at
 * the top with the reason spelled out under the name; everything settled collapses under one
 * divider. Composing moved to its own page, so this screen reads and acts, never edits.
 *
 * The server's lifecycle still shapes everything: an order is NUMBERED ONLY WHEN PLACED,
 * lines are editable only while drafting, receiving advances the status by itself, and Close
 * short is the single act that turns a shortfall into a reviewable variance. Counts on the
 * chips derive from ONE fetch so they always agree with the rows beneath them.
 */

useHead({ title: 'Orders · Huta' })

const route = useRoute()
const router = useRouter()

/* ————— filters, seeded from the URL ————— */
const queue = ref<'attention' | 'drafts' | 'all'>('all')
const storeId = ref<string | undefined>(undefined)
const supplierId = ref<string | undefined>(undefined)
const selectedId = ref<string | null>(null)
{
  const q = route.query
  if (q['queue'] === 'attention' || q['queue'] === 'drafts' || q['queue'] === 'all') queue.value = q['queue']
  if (typeof q['store'] === 'string') storeId.value = q['store']
  if (typeof q['supplier'] === 'string') supplierId.value = q['supplier']
  if (typeof q['order'] === 'string') selectedId.value = q['order']
}

function writeQuery() {
  void router.replace({
    query: {
      queue: queue.value === 'all' ? undefined : queue.value,
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
const actionError = ref<string | null>(null)
const saving = ref(false)

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
    apiFetch<{ suppliers: SupplierRow[] }>('/suppliers', { query: { includeInactive: 'true' } })
      .catch(() => ({ suppliers: [] as SupplierRow[] })),
    apiFetch<CatalogReference>('/catalog/reference').catch(() => null),
  ])
  suppliers.value = supplierData.suppliers
  stores.value = reference?.stores ? [...reference.stores] : []
  await fetchOrders()
  // A pasted ?order= link must open the drawer, not just tick a row — the URL this page
  // writes has to be one you can paste back.
  if (selectedId.value && orders.value.some((o) => o.id === selectedId.value)) sheetOpen.value = true
})

/* ————— what needs doing ————— */

const DAY_MS = 86_400_000

/**
 * Whole days past the expected date, or null.
 *
 * ⚠️ `expectedAt` is OPTIONAL, so an order with no expected date can never be late — we never
 * promised a date, and inventing a default would manufacture an exception out of nothing.
 * Elapsed days between two instants, which is a different thing from a business-day boundary
 * and correctly stays plain arithmetic.
 */
function daysLate(order: PurchaseOrderRow): number | null {
  if (!order.outstanding || !order.expectedAt) return null
  const days = Math.floor((Date.now() - new Date(order.expectedAt).getTime()) / DAY_MS)
  return days > 0 ? days : null
}

const overDelivered = (order: PurchaseOrderRow) => order.lines.filter((l) => l.varianceBase > 0).length

/** The reason this order is in the top band, or null when it isn't. */
function attention(order: PurchaseOrderRow): { text: string, tone: 'late' | 'over' } | null {
  const late = daysLate(order)
  if (late !== null) {
    const received = order.receiptCount > 0
    return {
      text: `${late} ${late === 1 ? 'day' : 'days'} late · ${received ? 'partly delivered' : 'nothing received'}`,
      tone: 'late',
    }
  }
  const over = overDelivered(order)
  if (over > 0) {
    return { text: `${over} ${over === 1 ? 'line' : 'lines'} over-delivered`, tone: 'over' }
  }
  return null
}

const settled = (order: PurchaseOrderRow) => order.status === 'RECEIVED' || order.status === 'CANCELLED'

/* ————— queues ————— */
const matchesFilters = (order: PurchaseOrderRow) =>
  (!storeId.value || order.storeId === storeId.value) &&
  (!supplierId.value || order.supplierId === supplierId.value)

const counts = computed(() => {
  const scoped = orders.value.filter(matchesFilters)
  return {
    attention: scoped.filter((o) => attention(o) !== null).length,
    drafts: scoped.filter((o) => o.status === 'DRAFT').length,
    all: scoped.length,
  }
})

/**
 * Work above the archive, with ONE divider at one known boundary.
 *
 * ⚠️ Filtering rows into groups is only half of it: rendering them in the server's order
 * leaves the two interleaved and fires a "previous row differed" divider at every transition.
 * The sort is what makes the band real, so it is done here and the divider sits at a
 * computed index.
 */
const rows = computed(() => {
  const scoped = orders.value.filter((order) => {
    if (!matchesFilters(order)) return false
    if (queue.value === 'attention' && attention(order) === null) return false
    if (queue.value === 'drafts' && order.status !== 'DRAFT') return false
    return true
  })
  const rank = (o: PurchaseOrderRow) => (attention(o) !== null ? 0 : settled(o) ? 2 : 1)
  return [...scoped].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    // Newest first within a band; a draft has no ordered date worth trusting.
    return new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime()
  })
})

/** Index of the first settled row, so the divider renders exactly once. */
const dividerAt = computed(() => {
  const i = rows.value.findIndex((o) => settled(o))
  return i === -1 ? null : i
})
const settledCount = computed(() => (dividerAt.value === null ? 0 : rows.value.length - dividerAt.value))

function setQueue(next: 'attention' | 'drafts' | 'all') {
  queue.value = queue.value === next ? 'all' : next
  writeQuery()
}

/* ————— selection ————— */
const sheetOpen = ref(false)
const selected = computed(() => orders.value.find((o) => o.id === selectedId.value) ?? null)

function open(id: string) {
  selectedId.value = id
  actionError.value = null
  sheetOpen.value = true
  writeQuery()
}

function closeSheet() {
  sheetOpen.value = false
  selectedId.value = null
  writeQuery()
}

/* ————— actions ————— */
async function runAction(path: string) {
  const id = selected.value?.id
  if (!id || saving.value) return
  saving.value = true
  actionError.value = null
  try {
    await apiFetch(`/purchase-orders/${id}/${path}`, { method: 'POST' })
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
  if (id && !actionError.value) {
    selectedId.value = id
    writeQuery()
  }
}

/**
 * Delete a draft outright.
 *
 * Only ever offered on a draft (placed or not, `number` is null), because that is the only
 * thing the server will delete — anything with a number keeps it, so the per-store sequence
 * stays gap-free. Discarding a draft now goes straight here rather than leaving a CANCELLED
 * tombstone: a record of something nobody ever saw is litter in a queue meant to be work.
 */
async function deleteDraft(id: string) {
  if (saving.value) return
  saving.value = true
  actionError.value = null
  try {
    await apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' })
    selectedId.value = null
    sheetOpen.value = false
    writeQuery()
    await fetchOrders()
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    saving.value = false
  }
}

/** ⚠️ Own ref — see the AlertDialogAction note in the house rules. */
const cancelOpen = ref(false)
async function confirmCancel() {
  cancelOpen.value = false
  const order = selected.value
  if (!order) return
  // Never placed → delete it. Placed → cancel, and it keeps its number on the record.
  if (order.number === null) await deleteDraft(order.id)
  else await runAction('cancel')
}
const closeShortOpen = ref(false)
async function confirmCloseShort() {
  closeShortOpen.value = false
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
  line.label && line.label !== line.productName ? `${line.productName} · ${line.label}` : line.productName

const qty = (base: number, mode: string) => formatQuantity(base as BaseQuantity, mode as TrackingMode)
const unitOf = (mode: string) => (mode === 'WEIGHT' ? 'g' : 'ct')
const money = (cents: number | null | undefined) => (cents == null ? '—' : formatCents(cents as Cents))

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

/** Per-LINE completion — a unit percentage across grams and counts would be nonsense. */
const progress = computed(() => {
  const order = selected.value
  if (!order || order.status === 'DRAFT' || order.status === 'CANCELLED') return null
  const complete = order.lines.filter((l) => l.receivedBase >= l.quantityBase).length
  return { complete, total: order.lines.length, pct: order.lines.length ? complete / order.lines.length : 0 }
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-start gap-3">
      <div>
        <h1 class="text-xl font-bold tracking-tight">Orders</h1>
        <p class="text-sm text-muted-foreground">
          <template v-if="counts.attention">
            <span class="font-medium text-amber-500">{{ counts.attention }} need attention</span> ·
            {{ counts.all - counts.attention }} running to plan
          </template>
          <template v-else>
            The internal order log — numbered when placed, received at the register, closed here.
          </template>
        </p>
      </div>
      <Button size="sm" class="ml-auto h-8" as-child>
        <NuxtLink to="/admin/purchase-orders/compose">＋ New order</NuxtLink>
      </Button>
    </div>

    <!-- queues + filters -->
    <div class="flex flex-wrap items-center gap-2">
      <ToggleGroup
        :model-value="queue"
        type="single"
        :spacing="2"
        aria-label="Queue"
        @update:model-value="(v) => setQueue((v as typeof queue) || 'all')"
      >
        <ToggleGroupItem
          v-for="chip in ([
            { key: 'attention', label: 'Needs attention', count: counts.attention },
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
      </div>
    </div>

    <!-- the ledger. Loading is a VEIL over the rows, never a content swap: replacing the
         table collapses the page height and takes the scroll position with it. -->
    <div class="relative">
      <div v-if="loading" class="absolute inset-0 z-10 rounded-xl bg-background/50" aria-hidden="true" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-24">Ref</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Store</TableHead>
            <TableHead>Expected</TableHead>
            <TableHead class="text-right">Lines</TableHead>
            <TableHead class="text-right">Value</TableHead>
            <TableHead class="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="(order, i) in rows" :key="order.id">
            <TableRow v-if="dividerAt !== null && i === dividerAt" class="hover:bg-transparent">
              <TableCell colspan="7" class="bg-background/60 py-1.5">
                <span class="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
                  Settled · {{ settledCount }}
                  <span class="h-px flex-1 bg-border" />
                </span>
              </TableCell>
            </TableRow>
            <TableRow
              class="cursor-pointer"
              :class="[
                attention(order) ? (attention(order)!.tone === 'late' ? 'bg-red-400/[0.06]' : 'bg-amber-500/[0.06]') : '',
                settled(order) ? 'opacity-60' : '',
                order.id === selectedId ? 'bg-primary/5' : '',
              ]"
              @click="open(order.id)"
            >
              <TableCell>
                <button
                  type="button"
                  class="font-mono text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  :class="order.status === 'DRAFT' ? 'text-muted-foreground' : 'text-primary'"
                  @click.stop="open(order.id)"
                >
                  {{ order.reference }}
                </button>
              </TableCell>
              <TableCell>
                <span class="font-medium">{{ order.supplierName }}</span>
                <span
                  v-if="attention(order)"
                  class="block text-xs"
                  :class="attention(order)!.tone === 'late' ? 'text-red-400' : 'text-amber-500'"
                >{{ attention(order)!.text }}</span>
              </TableCell>
              <TableCell class="text-muted-foreground">{{ order.storeName }}</TableCell>
              <TableCell class="tabular-nums" :class="daysLate(order) !== null ? 'text-red-400' : 'text-muted-foreground'">
                {{ order.status === 'DRAFT' ? 'not placed' : when(order.expectedAt) }}
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ order.lines.length }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ money(order.totalCostCents) }}</TableCell>
              <TableCell class="text-right">
                <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" :class="STATUS_CLASS[order.status] ?? 'bg-accent'">
                  {{ STATUS_LABEL[order.status] ?? order.status }}
                </span>
              </TableCell>
            </TableRow>
          </template>
          <TableEmpty v-if="!rows.length && !loading" :colspan="7">
            <Empty class="flex-none border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
                <EmptyTitle>
                  {{ queue === 'attention' ? 'Nothing needs attention' : queue === 'drafts' ? 'No drafts' : 'No orders yet' }}
                </EmptyTitle>
                <EmptyDescription v-if="queue === 'attention'">Every placed order is on time and in full.</EmptyDescription>
                <EmptyDescription v-else-if="queue === 'all'">Raise one to start the log.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </TableEmpty>
        </TableBody>
      </Table>
    </div>

    <!-- ————— the order itself ————— -->
    <Sheet :open="sheetOpen" @update:open="(o: boolean) => !o && closeSheet()">
      <SheetContent side="right" class="w-full overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader class="pr-12">
          <SheetTitle class="sr-only">
            {{ selected ? `${selected.reference} · ${selected.storeName}` : 'Order' }}
          </SheetTitle>
          <SheetDescription class="sr-only">Purchase order detail</SheetDescription>
          <template v-if="selected">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-base font-bold" :class="selected.status === 'DRAFT' ? 'text-muted-foreground' : 'text-primary'">
                {{ selected.reference }}
              </span>
              <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" :class="STATUS_CLASS[selected.status] ?? 'bg-accent'">
                {{ STATUS_LABEL[selected.status] ?? selected.status }}
              </span>
              <span class="rounded bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {{ selected.storeName }}
              </span>
            </div>
            <p class="text-sm text-muted-foreground">
              {{ selected.supplierName }}
              <template v-if="selected.expectedAt"> · expected {{ when(selected.expectedAt) }}</template>
              <template v-if="selected.cancelledAt"> · cancelled {{ when(selected.cancelledAt) }}</template>
            </p>
          </template>
        </SheetHeader>

        <div v-if="selected" class="flex flex-col gap-4 px-4 pb-6">
          <p
            v-if="attention(selected)"
            class="rounded-lg px-3 py-2 text-sm font-medium"
            :class="attention(selected)!.tone === 'late'
              ? 'bg-red-400/10 text-red-400'
              : 'bg-amber-500/10 text-amber-500'"
          >
            {{ attention(selected)!.text }}
          </p>

          <div v-if="progress">
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

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead class="text-right">Ordered</TableHead>
                <TableHead class="text-right">Received</TableHead>
                <TableHead class="text-right">Outstanding</TableHead>
                <TableHead class="text-right">Unit cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="line in selected.lines" :key="line.id">
                <TableCell>
                  <span class="font-medium">{{ lineName(line) }}</span>
                  <span class="block font-mono text-xs text-muted-foreground">{{ line.sku }}</span>
                </TableCell>
                <TableCell class="text-right tabular-nums">{{ qty(line.quantityBase, line.trackingMode) }}</TableCell>
                <TableCell class="text-right tabular-nums">{{ qty(line.receivedBase, line.trackingMode) }}</TableCell>
                <TableCell class="text-right tabular-nums" :class="outstandingCell(line).cls">
                  {{ outstandingCell(line).text }}
                </TableCell>
                <TableCell class="text-right tabular-nums">{{ costLabel(line) }}</TableCell>
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

          <p v-if="selected.notes" class="rounded-lg border bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            {{ selected.notes }}
          </p>

          <p v-if="selected.status !== 'DRAFT'" class="text-xs text-muted-foreground">
            Placed by {{ selected.orderedByName }} on {{ when(selected.orderedAt) }} ·
            {{ selected.receiptCount }} {{ selected.receiptCount === 1 ? 'delivery' : 'deliveries' }} so far.
          </p>

          <FieldError v-if="actionError">{{ actionError }}</FieldError>

          <!-- draft: edit lives on the composer, the lifecycle lives here -->
          <div v-if="selected.status === 'DRAFT'" class="flex flex-wrap items-center gap-2 border-t pt-3">
            <span class="mr-auto text-xs text-muted-foreground">
              Lines can only be changed while it is a draft — placing it mints the number.
            </span>
            <Button
              variant="ghost"
              size="sm"
              class="text-red-400 hover:bg-red-400/10 hover:text-red-400"
              :disabled="saving"
              @click="cancelOpen = true"
            >
              Discard draft…
            </Button>
            <Button size="sm" variant="outline" as-child>
              <NuxtLink :to="`/admin/purchase-orders/compose?draft=${selected.id}`">Edit draft</NuxtLink>
            </Button>
            <Button size="sm" :disabled="saving" @click="place">Place order</Button>
          </div>

          <!-- a draft discarded under the old behaviour: never placed, so it can still go -->
          <div
            v-else-if="selected.status === 'CANCELLED' && selected.number === null"
            class="flex flex-wrap items-center gap-2 border-t pt-3"
          >
            <span class="mr-auto text-xs text-muted-foreground">
              This draft was discarded before it was ever placed, so it holds no number and
              nothing references it.
            </span>
            <Button
              size="sm"
              variant="outline"
              class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
              :disabled="saving"
              @click="cancelOpen = true"
            >
              Delete for good
            </Button>
          </div>

          <div
            v-else-if="selected.status === 'PARTIALLY_RECEIVED' || selected.outstanding"
            class="flex flex-wrap items-center gap-2 border-t pt-3"
          >
            <span class="mr-auto text-xs text-muted-foreground">
              A placed order's lines are the record of what was asked for.
            </span>
            <Button
              v-if="selected.status === 'PARTIALLY_RECEIVED'"
              size="sm"
              variant="outline"
              :disabled="saving"
              @click="closeShortOpen = true"
            >
              Close short
            </Button>
            <Button
              v-if="selected.outstanding"
              size="sm"
              variant="outline"
              class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
              :disabled="saving"
              @click="cancelOpen = true"
            >
              Cancel order
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <!--
      cancel: irreversible — an AlertDialog, not a Dialog. It carries role="alertdialog",
      focuses the safe choice, and refuses to close on a click outside or on Escape.
      ⚠️ `cancelOpen` is its OWN ref and the handler reads `selected`, which the close does
      not clear — a ref that doubles as "which row" and "is it open" silently no-ops.
    -->
    <AlertDialog :open="cancelOpen" @update:open="(o: boolean) => !o && (cancelOpen = false)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ selected?.number === null ? 'Delete this draft?' : `Cancel ${selected?.reference}?` }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="selected?.number === null">
              It is removed entirely, along with its lines. Nothing was ever placed and it holds
              no order number, so there is no gap left behind — but there is no undo either.
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
            {{ selected?.number === null ? 'Delete draft' : 'Cancel order' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- close short: the shortfall becomes a variance -->
    <AlertDialog :open="closeShortOpen" @update:open="(o: boolean) => !o && (closeShortOpen = false)">
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
