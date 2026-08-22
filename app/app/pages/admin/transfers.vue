<script setup lang="ts">
import { ArrowLeftRight, PackagePlus } from '@lucide/vue'
import type {
  CatalogPage,
  CatalogProduct,
  CatalogReference,
  StockLevelRow,
  TransferLineRow,
  TransferRow,
} from '@huta/shared/schemas'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatQuantity, parseGramsToBase } from '@huta/shared'
import type { Socket } from 'socket.io-client'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { FieldError } from '~/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * The transfers desk (Kasan's 6A: the PO-desk pattern; "Move stock" opens the
 * direct-move composer). Registers do the day-to-day legs — this page is oversight
 * plus the one power staff don't hold: moving stock between stores immediately,
 * no request, one transaction. A direct move lands in the list like any other
 * transfer, born Received with every actor being the admin who ran it.
 *
 * This is the ONLY surface that shows what a transfer is worth: `shippedCostCents`
 * is the value the source's basis relieved at ship — the value in transit — and the
 * server omits it for anyone without cost.view.
 */

const route = useRoute()
const router = useRouter()

/* ————— filters, seeded from the URL ————— */
const queue = ref<'open' | 'in-transit' | 'all'>('open')
const storeId = ref<string | undefined>(undefined)
const selectedId = ref<string | null>(null)
{
  const q = route.query
  if (q['queue'] === 'in-transit' || q['queue'] === 'all') queue.value = q['queue']
  if (typeof q['store'] === 'string') storeId.value = q['store']
  if (typeof q['transfer'] === 'string') selectedId.value = q['transfer']
}

function writeQuery() {
  void router.replace({
    query: {
      queue: queue.value === 'open' ? undefined : queue.value,
      store: storeId.value,
      transfer: selectedId.value ?? undefined,
    },
  })
}

/* ————— data ————— */
const transfers = ref<TransferRow[]>([])
const stores = ref<Array<{ id: string, name: string }>>([])
const loading = ref(true)

async function fetchTransfers() {
  loading.value = true
  try {
    const data = await apiFetch<{ transfers: TransferRow[] }>('/transfers')
    transfers.value = data.transfers
  } finally {
    loading.value = false
  }
}

const { $socket } = useNuxtApp() as unknown as { $socket: Socket | null }
const onChanged = () => void fetchTransfers()

onMounted(async () => {
  const reference = await apiFetch<CatalogReference>('/catalog/reference').catch(() => null)
  stores.value = reference?.stores ? [...reference.stores] : []
  await fetchTransfers()
  $socket?.on('transfer.changed', onChanged)
})
onUnmounted(() => $socket?.off('transfer.changed', onChanged))

/* ————— queues: alternatives, counted from the one fetch ————— */
const OPEN = new Set(['PENDING', 'ACCEPTED', 'IN_TRANSIT'])
const counts = computed(() => ({
  open: transfers.value.filter((t) => OPEN.has(t.status)).length,
  inTransit: transfers.value.filter((t) => t.status === 'IN_TRANSIT').length,
  all: transfers.value.length,
}))

const visible = computed(() =>
  transfers.value.filter((t) => {
    if (queue.value === 'open' && !OPEN.has(t.status)) return false
    if (queue.value === 'in-transit' && t.status !== 'IN_TRANSIT') return false
    if (storeId.value && t.requestingStoreId !== storeId.value && t.sourceStoreId !== storeId.value)
      return false
    return true
  }),
)

function setQueue(next: 'open' | 'in-transit' | 'all') {
  queue.value = queue.value === next ? 'all' : next
  writeQuery()
}

/* ————— selection ————— */
const selected = computed(() => transfers.value.find((t) => t.id === selectedId.value) ?? null)

watch(visible, (list) => {
  if (!list.some((t) => t.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
    writeQuery()
  }
})

function select(id: string) {
  selectedId.value = id
  writeQuery()
}

/* ————— display ————— */
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
}
const STATUS_CLASS: Record<string, string> = {
  PENDING: 'bg-amber-500/10 text-amber-500',
  ACCEPTED: 'bg-primary/10 text-primary',
  IN_TRANSIT: 'bg-sky-400/10 text-sky-400',
  RECEIVED: 'bg-accent text-muted-foreground',
  DECLINED: 'bg-red-400/10 text-red-400',
  CANCELLED: 'bg-accent text-muted-foreground',
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const when = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—')

const lineName = (line: TransferLineRow) =>
  line.label && line.label !== line.productName
    ? `${line.productName} · ${line.label}`
    : line.productName

const qty = (base: number | null, mode: TrackingMode) =>
  base === null ? '—' : formatQuantity(base as BaseQuantity, mode)

const money = (cents: number | null | undefined) =>
  cents == null ? '—' : formatCents(cents as Cents)

/** Total in-transit / moved value where the ship snapshot exists; null before ship. */
const valueOf = (t: TransferRow): number | null => {
  let sum = 0
  let any = false
  for (const line of t.lines) {
    if (line.shippedCostCents != null) {
      sum += line.shippedCostCents
      any = true
    }
  }
  return any ? sum : null
}

/* ————— the direct move ————— */
interface MoveLine {
  variantId: string
  name: string
  sku: string
  trackingMode: TrackingMode
  qty: string
  /** Null = still fetching; an EMPTY array is a real answer (no stock rows anywhere). */
  levels: StockLevelRow[] | null
  /** The lookup errored — say "couldn't check", never a lying "none there". */
  levelsFailed?: boolean
}

const moveOpen = ref(false)
const mFromId = ref('')
const mToId = ref('')
const mNote = ref('')
const mLines = ref<MoveLine[]>([])
const mError = ref<string | null>(null)
const moving = ref(false)

function startMove() {
  mFromId.value = stores.value[0]?.id ?? ''
  mToId.value = stores.value[1]?.id ?? ''
  mNote.value = ''
  mLines.value = []
  mError.value = null
  term.value = ''
  results.value = []
  moveOpen.value = true
}

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
        query: { search: q, page: 1, pageSize: 8, active: 'all' },
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

async function addMoveLine(hit: { variantId: string, name: string, sku: string, trackingMode: TrackingMode }) {
  term.value = ''
  results.value = []
  if (mLines.value.some((l) => l.variantId === hit.variantId)) return
  mLines.value.push({ ...hit, qty: hit.trackingMode === 'EACH' ? '1' : '', levels: null })
  // Write through the ARRAY, not a local object: push wraps the element in a reactive
  // proxy, and mutating the raw original never triggers a re-render — the on-hand line
  // would sit on "checking…" until some other interaction repainted it.
  const stored = mLines.value.find((l) => l.variantId === hit.variantId)
  try {
    const data = await apiFetch<{ levels: StockLevelRow[] }>(`/inventory/levels/${hit.variantId}`)
    if (stored) stored.levels = data.levels
  } catch {
    // Availability is a hint; the guard is the server's oversell check.
    if (stored) stored.levelsFailed = true
  }
}

function removeMoveLine(variantId: string) {
  mLines.value = mLines.value.filter((l) => l.variantId !== variantId)
}

function availableAtFrom(line: MoveLine): number | null {
  if (line.levels === null) return null
  return line.levels.find((l) => l.storeId === mFromId.value)?.quantityBase ?? 0
}

function moveLineBase(line: MoveLine): number | null {
  const raw = line.qty.trim()
  if (raw === '') return null
  if (line.trackingMode === 'WEIGHT') {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null
}

const moveValid = computed(
  () =>
    mFromId.value !== ''
    && mToId.value !== ''
    && mFromId.value !== mToId.value
    && mLines.value.length >= 1
    && mLines.value.every((l) => moveLineBase(l) !== null),
)

async function runMove() {
  if (!moveValid.value || moving.value) return
  moving.value = true
  mError.value = null
  try {
    const created = await apiFetch<TransferRow>('/transfers/direct', {
      method: 'POST',
      body: {
        fromStoreId: mFromId.value,
        toStoreId: mToId.value,
        ...(mNote.value.trim() ? { note: mNote.value.trim() } : {}),
        lines: mLines.value.map((l) => ({ variantId: l.variantId, quantityBase: moveLineBase(l)! })),
      },
    })
    moveOpen.value = false
    await fetchTransfers()
    queue.value = 'all'
    selectedId.value = created.id
    writeQuery()
  } catch (err) {
    mError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    moving.value = false
  }
}

const storeName = (id: string) => stores.value.find((s) => s.id === id)?.name ?? '—'
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Transfers</h1>
      <p class="text-sm text-muted-foreground">
        Stock between the stores — requests run at the registers; the direct move lives here.
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
            { key: 'open', label: 'Open', count: counts.open },
            { key: 'in-transit', label: 'In transit', count: counts.inTransit },
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
        <Button size="sm" class="h-8" @click="startMove">⇄ Move stock</Button>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 items-start gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
      <!-- master list -->
      <div class="flex flex-col gap-1.5" :class="loading ? 'pointer-events-none opacity-50' : ''">
        <button
          v-for="t in visible"
          :key="t.id"
          type="button"
          class="rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
          :class="t.id === selectedId ? 'border-primary/50 bg-primary/5' : ''"
          @click="select(t.id)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-semibold">{{ t.sourceStoreName }} → {{ t.requestingStoreName }}</span>
            <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" :class="STATUS_CLASS[t.status] ?? 'bg-accent'">
              {{ STATUS_LABEL[t.status] ?? t.status }}
            </span>
          </div>
          <p class="mt-0.5 truncate text-xs text-muted-foreground">
            {{ t.lines.length }} line{{ t.lines.length === 1 ? '' : 's' }} · {{ t.requestedByName }} · {{ when(t.createdAt) }}
          </p>
        </button>
        <Empty v-if="!visible.length && !loading" class="flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ArrowLeftRight /></EmptyMedia>
            <EmptyTitle>{{ queue === 'open' ? 'Nothing open between the stores' : queue === 'in-transit' ? 'Nothing on the road' : 'No transfers yet' }}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>

      <!-- detail -->
      <div class="rounded-xl border bg-card p-4">
        <template v-if="selected">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-base font-bold">
              {{ selected.sourceStoreName }} → {{ selected.requestingStoreName }}
            </h2>
            <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" :class="STATUS_CLASS[selected.status] ?? 'bg-accent'">
              {{ STATUS_LABEL[selected.status] ?? selected.status }}
            </span>
            <span v-if="selected.status === 'IN_TRANSIT' && valueOf(selected) !== null" class="ml-auto text-xs font-medium text-sky-400">
              {{ money(valueOf(selected)) }} in transit — belongs to neither store until received
            </span>
          </div>

          <!-- Table brings its own overflow-x-auto container, so no wrapper is needed. -->
          <div class="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Approved</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead class="text-right">Value shipped</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="line in selected.lines" :key="line.id">
                  <TableCell>
                    <span class="font-medium">{{ lineName(line) }}</span>
                    <span class="block font-mono text-xs text-muted-foreground">{{ line.sku }}</span>
                  </TableCell>
                  <TableCell class="tabular-nums">{{ qty(line.requestedBase, line.trackingMode) }}</TableCell>
                  <TableCell class="tabular-nums">{{ qty(line.approvedBase, line.trackingMode) }}</TableCell>
                  <TableCell class="tabular-nums">
                    {{ qty(line.receivedBase, line.trackingMode) }}
                    <span
                      v-if="line.receivedBase !== null && line.receivedBase < (line.approvedBase ?? 0)"
                      class="ml-1 text-xs font-semibold text-amber-500"
                    >
                      −{{ qty((line.approvedBase ?? 0) - line.receivedBase, line.trackingMode) }} short
                    </span>
                  </TableCell>
                  <TableCell class="text-right tabular-nums">{{ money(line.shippedCostCents) }}</TableCell>
                </TableRow>
              </TableBody>
              <TableFooter v-if="valueOf(selected) !== null">
                <TableRow>
                  <TableCell colspan="4" class="text-xs font-normal text-muted-foreground">
                    Value at the source&apos;s cost basis when shipped
                  </TableCell>
                  <TableCell class="text-right font-semibold tabular-nums">
                    {{ money(valueOf(selected)) }}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          <p v-if="selected.note" class="mt-3 rounded-lg border bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            {{ selected.note }}
          </p>
          <p v-if="selected.reason" class="mt-3 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm">
            <b class="text-red-400">{{ selected.status === 'DECLINED' ? 'Declined' : 'Cancelled' }}</b>
            <span class="text-muted-foreground"> — {{ selected.reason }}</span>
          </p>

          <p class="mt-3 text-xs text-muted-foreground">
            Requested by {{ selected.requestedByName }} {{ when(selected.createdAt) }}
            <template v-if="selected.acceptedByName"> · accepted by {{ selected.acceptedByName }} {{ when(selected.acceptedAt) }}</template>
            <template v-if="selected.shippedByName"> · shipped by {{ selected.shippedByName }} {{ when(selected.shippedAt) }}</template>
            <template v-if="selected.receivedByName"> · received by {{ selected.receivedByName }} {{ when(selected.receivedAt) }}</template>
          </p>
        </template>

        <Empty v-else class="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ArrowLeftRight /></EmptyMedia>
            <EmptyTitle>No transfer selected</EmptyTitle>
            <EmptyDescription>Pick one on the left, or move stock directly.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>

    <!-- the direct move -->
    <Dialog :open="moveOpen" @update:open="(o: boolean) => !o && (moveOpen = false)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move stock now</DialogTitle>
          <DialogDescription>
            One step, no request — both stores update immediately, and the move is recorded
            like any other transfer.
          </DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-3">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <span class="mb-1 block text-xs font-medium">From</span>
              <Select v-model="mFromId">
                <SelectTrigger class="data-[size=default]:h-9 w-full" aria-label="From store"><SelectValue placeholder="Store" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <span class="mb-1 block text-xs font-medium">To</span>
              <Select v-model="mToId">
                <SelectTrigger class="data-[size=default]:h-9 w-full" aria-label="To store"><SelectValue placeholder="Store" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="store in stores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p v-if="mFromId && mFromId === mToId" class="text-xs text-amber-500">
            Pick two different stores.
          </p>

          <div class="relative">
            <SearchInput
              v-model="term"
              placeholder="Search products or SKU…"
              autocomplete="off"
              aria-label="Search products to move"
            />
            <div
              v-if="results.length"
              class="absolute inset-x-0 top-full z-10 mt-1 max-h-52 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
            >
              <button
                v-for="hit in results"
                :key="hit.variantId"
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                @click="addMoveLine(hit)"
              >
                <span class="min-w-0 flex-1 truncate font-medium">{{ hit.name }}</span>
                <span class="font-mono text-xs text-muted-foreground">{{ hit.sku }}</span>
              </button>
            </div>
          </div>

          <div v-if="mLines.length" class="flex flex-col gap-2">
            <div
              v-for="line in mLines"
              :key="line.variantId"
              class="flex items-center gap-2 rounded-xl border bg-background/60 p-2.5"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold">{{ line.name }}</span>
                <span
                  class="text-xs"
                  :class="availableAtFrom(line) === 0 ? 'font-medium text-amber-500' : 'text-muted-foreground'"
                >
                  <template v-if="line.levelsFailed">couldn't check on-hand</template>
                  <template v-else-if="availableAtFrom(line) === null">checking on-hand…</template>
                  <template v-else>{{ storeName(mFromId) }} has {{ qty(availableAtFrom(line)!, line.trackingMode) }}</template>
                </span>
              </span>
              <InputGroup
                class="h-9 w-24"
                :class="moveLineBase(line) === null && line.qty.trim() !== '' ? 'border-red-400/60' : ''"
              >
                <InputGroupInput
                  v-model="line.qty"
                  :inputmode="line.trackingMode === 'WEIGHT' ? 'decimal' : 'numeric'"
                  autocomplete="off"
                  class="text-right font-semibold tabular-nums"
                  :aria-label="`Quantity of ${line.name}`"
                />
                <InputGroupAddon
                  v-if="line.trackingMode === 'WEIGHT'"
                  align="inline-end"
                  class="text-xs"
                >g</InputGroupAddon>
              </InputGroup>
              <button
                type="button"
                class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                :aria-label="`Remove ${line.name}`"
                @click="removeMoveLine(line.variantId)"
              >✕</button>
            </div>
          </div>
          <Empty v-else class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><PackagePlus /></EmptyMedia>
              <EmptyTitle>Nothing to move yet</EmptyTitle>
              <EmptyDescription>Search above to add what's moving.</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <Input v-model="mNote" placeholder="Note (optional)" autocomplete="off" maxlength="500" />
          <FieldError v-if="mError">{{ mError }}</FieldError>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="moveOpen = false">Cancel</Button>
          <Button :disabled="!moveValid || moving" @click="runMove">
            {{ moving ? 'Moving…' : 'Move stock' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
