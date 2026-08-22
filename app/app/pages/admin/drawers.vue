<script setup lang="ts">
import type {
  CashMovementRow,
  CatalogReference,
  LiveDrawerRow,
  ShiftListPage,
  ShiftListRow,
  ShiftRow,
} from '@huta/shared/schemas'
import { Banknote, CircleAlert, Inbox } from '@lucide/vue'
import { Button } from '~/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { FieldError } from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { Spinner } from '~/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { ApiError, apiFetch } from '~/composables/useApi'
import { MOVEMENT_LABEL, money, varianceView } from '~/lib/sale-format'

/**
 * The store-level drawer list (Kasan's A pick, 2026-08-22) — the exception ledger.
 *
 * A drawer belongs to a TILL, not a person: one open shift per store, many cashiers ringing
 * against it. That is why this page exists separately from the per-person slice on
 * /admin/staff, and why nothing here may be read as hours worked.
 *
 * Sorted by whether a drawer NEEDS YOU rather than by date. Cash carries over between shifts
 * and days, so every closed drawer carries two variances and either being off pulls it into
 * the band at the top:
 *
 *   Overnight — what happened while nobody was serving, measured against the previous close
 *   On shift  — what happened while someone was, measured against expected at the close
 *
 * Keeping them apart is the whole point. Folded together, a loss that happened before a
 * cashier arrived lands on that cashier.
 *
 * READ-ONLY for closing a drawer, and it says so rather than hiding a button: the close is
 * counted-first at the till, and keying a count from a desk without touching the cash defeats
 * the only control there is. Same argument /admin/sales makes about refunds and voids.
 */
definePageMeta({ layout: 'default' })
useHead({ title: 'Drawers · Huta' })

const route = useRoute()
const router = useRouter()

const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

/* ————— filters, all of them in the URL ————— */

type Preset = 'week' | 'month' | 'all'
type Queue = 'attention' | 'all'

/**
 * Last 7 days, not Today. A drawer list scoped to today usually holds one row, and the
 * question this page answers — "is anything off" — is not a question about today.
 */
const preset = ref<Preset>('week')
const queue = ref<Queue>('attention')
const storeId = ref<string | undefined>(undefined)
const selectedId = ref<string | null>(null)

const PRESETS: ReadonlyArray<{ key: Preset, label: string }> = [
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
]

function localDate(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** Local calendar dates; the SERVER resolves them against each store's own timezone. */
const range = computed<{ from?: string, to?: string }>(() => {
  if (preset.value === 'all') return {}
  if (preset.value === 'month') return { from: startOfMonth(), to: localDate() }
  return { from: localDate(-6), to: localDate() }
})

const filters = computed(() => ({ storeId: storeId.value, ...range.value }))

/* ————— URL sync, the catalog's bidirectional pattern ————— */

let syncing = false

function applyFromQuery() {
  syncing = true
  const q = route.query
  const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined)

  preset.value = (str('preset') as Preset) ?? 'week'
  queue.value = (str('queue') as Queue) ?? 'attention'
  storeId.value = str('store')
  selectedId.value = str('drawer') ?? null

  void nextTick(() => (syncing = false))
}

function writeQuery() {
  if (syncing) return
  void router.replace({
    query: {
      preset: preset.value !== 'week' ? preset.value : undefined,
      queue: queue.value !== 'attention' ? queue.value : undefined,
      store: storeId.value,
      drawer: selectedId.value ?? undefined,
    },
  })
}

watch(() => route.query, applyFromQuery)

/* ————— data ————— */

const rows = ref<ShiftListRow[]>([])
const tills = ref<LiveDrawerRow[]>([])
const reference = ref<CatalogReference | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/**
 * ONE fetch drives the table, the chips and the strip, so the counts can never disagree with
 * the rows beneath them — the rule /admin/receiving established. A drawer list is tens of
 * rows, not thousands, which is what makes reducing client-side the right call here and the
 * wrong one on the sales ledger.
 */
async function fetchAll() {
  loading.value = true
  error.value = null
  try {
    const [page, live] = await Promise.all([
      apiFetch<ShiftListPage>('/shifts', { query: filters.value }),
      apiFetch<{ drawers: LiveDrawerRow[] }>('/shifts/live', {
        query: { ...(storeId.value ? { storeId: storeId.value } : {}) },
      }),
    ])
    rows.value = page.shifts
    tills.value = live.drawers
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not load the drawers.'
  } finally {
    loading.value = false
  }
}

watch([filters], () => void fetchAll(), { deep: true })

onMounted(async () => {
  applyFromQuery()
  // Captured BEFORE the fetch: `open()` reassigns it, and a ?drawer= link must OPEN the
  // panel rather than merely highlight a row, or the URL this page writes is not one that
  // can be pasted back.
  const deepLink = selectedId.value
  await fetchAll()
  if (deepLink) await open(deepLink)
  try {
    reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  } catch {
    // Only the store picker degrades; the payload already names every store on its rows.
  }
})

/* ————— what needs you, and what does not ————— */

/** A drawer wants attention if EITHER variance is off, or if it is still open. */
function needsAttention(r: ShiftListRow): boolean {
  if (r.status === 'OPEN') return true
  return (r.varianceCents ?? 0) !== 0 || (r.openingVarianceCents ?? 0) !== 0
}

const attention = computed(() => rows.value.filter(needsAttention))
const balanced = computed(() => rows.value.filter((r) => !needsAttention(r)))

/**
 * Work first, archive second — the whole premise of this direction.
 *
 * The server returns strict date order, which interleaves the two, so the "All drawers" view
 * has to re-sort. Each half keeps the server's ordering within itself, so dates still run
 * newest-first on both sides of the divider.
 */
const shown = computed(() =>
  queue.value === 'attention' ? attention.value : [...attention.value, ...balanced.value],
)

/** The single index the divider belongs at, or -1 when there is nothing to divide. */
const dividerAt = computed(() =>
  queue.value === 'all' && attention.value.length > 0 && balanced.value.length > 0
    ? attention.value.length
    : -1,
)

/** ⚠️ `listShifts` caps at 200 with no paging, so say when the view is truncated. */
const capped = computed(() => rows.value.length >= 200)

const totals = computed(() => {
  const sum = (pick: (r: ShiftListRow) => number) => rows.value.reduce((n, r) => n + pick(r), 0)
  return {
    drawers: rows.value.length,
    onShift: sum((r) => r.varianceCents ?? 0),
    overnight: sum((r) => r.openingVarianceCents ?? 0),
    collected: sum((r) => r.pickupsCents),
    inTills: tills.value.reduce((n, t) => n + (t.balanceCents ?? 0), 0),
  }
})

/* ————— the detail panel ————— */

const detail = ref<ShiftRow | null>(null)
const movements = ref<CashMovementRow[]>([])
const detailOpen = ref(false)
const detailError = ref<string | null>(null)
const reviewNote = ref('')
const savingReview = ref(false)
const reviewError = ref<string | null>(null)

async function open(shiftId: string) {
  selectedId.value = shiftId
  detailOpen.value = true
  detailError.value = null
  reviewError.value = null
  detail.value = null
  movements.value = []
  reviewNote.value = ''
  writeQuery()
  try {
    const [row, moves] = await Promise.all([
      apiFetch<ShiftRow>(`/shifts/${shiftId}`),
      apiFetch<{ movements: CashMovementRow[] }>(`/shifts/${shiftId}/movements`),
    ])
    if (selectedId.value !== shiftId) return // a faster second click won
    detail.value = row
    movements.value = moves.movements
    reviewNote.value = row.reviewNote ?? ''
  } catch (err) {
    detailError.value = err instanceof ApiError ? err.message : 'Could not open that drawer.'
  }
}

watch(detailOpen, (isOpen) => {
  if (!isOpen) {
    selectedId.value = null
    writeQuery()
  }
})

async function saveReview() {
  const shift = detail.value
  if (!shift || reviewNote.value.trim() === '') return
  savingReview.value = true
  reviewError.value = null
  try {
    detail.value = await apiFetch<ShiftRow>(`/shifts/${shift.id}/review`, {
      method: 'POST',
      body: { note: reviewNote.value.trim() },
    })
    // The row carries the review too, so the list must not keep saying "not reviewed".
    await fetchAll()
  } catch (err) {
    reviewError.value = err instanceof ApiError ? err.message : 'Could not save that.'
  } finally {
    savingReview.value = false
  }
}

const movementTotal = (type: string) =>
  movements.value.filter((m) => m.type === type).reduce((n, m) => n + m.amountCents, 0)

const detailVariance = computed(() =>
  detail.value ? varianceView(detail.value.varianceCents, detail.value.status) : null,
)
const detailOpening = computed(() =>
  detail.value && detail.value.openingVarianceCents !== null
    ? varianceView(detail.value.openingVarianceCents, 'CLOSED')
    : null,
)

const when = (iso: string) => `${dayFmt.format(new Date(iso))} · ${timeFmt.format(new Date(iso))}`

/** "Baytree Staff → Huta Admin" when two people held the drawer; one name when it was one. */
function custody(r: ShiftListRow): string {
  if (!r.closedByName || r.closedByName === r.openedByName) return r.openedByName
  return `${r.openedByName} → ${r.closedByName}`
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">Drawers</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Cash carries over between shifts and days, so every drawer is measured twice — against
        what the last close left, and against what it took while open.
      </p>
    </div>

    <FieldError v-if="error">{{ error }}</FieldError>

    <!-- ————— what is in each till right now ————— -->
    <div class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="t in tills"
        :key="t.storeId"
        class="rounded-xl border bg-card px-4 py-3"
        :class="t.shiftId ? 'border-primary/40' : ''"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium">{{ t.storeName }}</span>
          <span
            v-if="t.shiftId"
            class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary"
          >Open</span>
        </div>
        <p v-if="t.balanceCents !== null" class="text-2xl font-extrabold tabular-nums tracking-tight">
          {{ money(t.balanceCents) }}
        </p>
        <!--
          A store with nobody signed on is SHOWN, not hidden: "the till is empty" and "nobody
          has opened up" are different facts and only the second needs someone to act.
        -->
        <p v-else class="text-lg font-semibold text-muted-foreground">Not opened</p>
        <p class="text-xs text-muted-foreground">
          <template v-if="t.shiftId">
            {{ t.openedByName }} · since {{ timeFmt.format(new Date(t.openedAt!)) }} ·
            {{ t.saleCount }} {{ t.saleCount === 1 ? 'sale' : 'sales' }}
          </template>
          <template v-else>No drawer open at this store</template>
        </p>
      </div>
    </div>

    <!-- ————— filters ————— -->
    <div class="flex flex-wrap items-center gap-2">
      <ToggleGroup
        :model-value="preset"
        type="single"
        :spacing="2"
        aria-label="Date range"
        class="flex-wrap"
        @update:model-value="(v) => { if (v) { preset = v as Preset; writeQuery() } }"
      >
        <ToggleGroupItem
          v-for="p in PRESETS"
          :key="p.key"
          :value="p.key"
          class="inline-flex h-8 items-center rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
        >
          {{ p.label }}
        </ToggleGroupItem>
      </ToggleGroup>

      <Select
        :model-value="storeId ?? 'all'"
        @update:model-value="(v) => { storeId = v === 'all' ? undefined : (v as string); writeQuery() }"
      >
        <SelectTrigger id="drawer-store" class="h-8 w-[190px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All stores</SelectItem>
          <SelectItem v-for="s in reference?.stores ?? []" :key="s.id" :value="s.id">
            {{ s.name }}
          </SelectItem>
        </SelectContent>
      </Select>

      <!-- Mutually exclusive queues, counted from the SAME fetch that fills the table. -->
      <ToggleGroup
        :model-value="queue"
        type="single"
        :spacing="2"
        aria-label="Which drawers"
        class="ml-auto flex-wrap"
        @update:model-value="(v) => { if (v) { queue = v as Queue; writeQuery() } }"
      >
        <ToggleGroupItem
          value="attention"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:text-foreground"
        >
          Needs attention <span class="tabular-nums opacity-70">{{ attention.length }}</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="all"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:text-foreground"
        >
          All drawers <span class="tabular-nums opacity-70">{{ rows.length }}</span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>

    <!-- ————— totals for the range in view ————— -->
    <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <p class="text-lg font-bold tabular-nums">{{ totals.drawers }}</p>
        <p class="text-xs text-muted-foreground">Drawers</p>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <p class="text-lg font-bold tabular-nums" :class="totals.onShift !== 0 ? 'text-amber-500' : ''">
          {{ varianceView(totals.onShift, 'CLOSED').amount }}
        </p>
        <p class="text-xs text-muted-foreground">On shift</p>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <p class="text-lg font-bold tabular-nums" :class="totals.overnight !== 0 ? 'text-amber-500' : ''">
          {{ varianceView(totals.overnight, 'CLOSED').amount }}
        </p>
        <p class="text-xs text-muted-foreground">Between shifts</p>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <p class="text-lg font-bold tabular-nums">{{ money(totals.inTills) }}</p>
        <p class="text-xs text-muted-foreground">In tills now</p>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <p class="text-lg font-bold tabular-nums">{{ money(totals.collected) }}</p>
        <p class="text-xs text-muted-foreground">Collected</p>
      </div>
    </div>

    <p v-if="capped" class="text-xs text-amber-500">
      Showing the most recent 200 drawers — narrow the range to see the rest.
    </p>

    <!-- ————— the ledger ————— -->
    <div class="relative rounded-xl border bg-card" :class="loading ? 'pointer-events-none opacity-50' : ''">
      <Empty v-if="!loading && rows.length === 0" class="flex-none border-0">
        <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
        <EmptyTitle>No drawers in this range</EmptyTitle>
        <EmptyDescription>Widen the dates, or pick another store.</EmptyDescription>
      </Empty>

      <Empty v-else-if="!loading && shown.length === 0" class="flex-none border-0">
        <EmptyMedia variant="icon"><Banknote /></EmptyMedia>
        <EmptyTitle>Every drawer balanced</EmptyTitle>
        <EmptyDescription>
          All {{ rows.length }} counted to the cent, both at open and at close.
        </EmptyDescription>
      </Empty>

      <Table v-else>
        <TableCaption class="sr-only">
          Cash drawers, those needing attention first.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead class="w-[118px]">Overnight</TableHead>
            <TableHead class="w-[118px]">On shift</TableHead>
            <TableHead>Store</TableHead>
            <TableHead>Opened</TableHead>
            <TableHead>Custody</TableHead>
            <TableHead class="text-right">Sales</TableHead>
            <TableHead class="text-right">Carried in</TableHead>
            <TableHead class="text-right">Counted out</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="(r, i) in shown" :key="r.id">
            <!--
              ONE divider, at the single boundary between the work and the archive. Testing
              "previous row was attention and this one is not" instead fires at every
              transition — three times over this data, because the server's date ordering
              interleaves them.
            -->
            <TableRow v-if="i === dividerAt" class="hover:bg-accent/40">
              <TableCell
                colspan="8"
                class="bg-accent/40 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
              >
                Balanced · {{ balanced.length }}
              </TableCell>
            </TableRow>

            <TableRow
              class="cursor-pointer"
              :class="[
                needsAttention(r) ? 'bg-amber-500/[0.07]' : '',
                queue === 'all' && !needsAttention(r) ? 'text-muted-foreground' : '',
              ]"
              @click="open(r.id)"
            >
              <TableCell :class="needsAttention(r) && (r.openingVarianceCents ?? 0) !== 0 ? 'shadow-[inset_3px_0_0_var(--color-amber-500)]' : ''">
                <span v-if="r.openingVarianceCents === null" class="text-muted-foreground">—</span>
                <span
                  v-else
                  class="font-bold tabular-nums"
                  :class="r.openingVarianceCents !== 0 ? 'text-amber-500' : 'font-medium text-muted-foreground'"
                >{{ varianceView(r.openingVarianceCents, 'CLOSED').amount }}</span>
              </TableCell>

              <TableCell>
                <span
                  v-if="r.status === 'OPEN'"
                  class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary"
                >Open</span>
                <span
                  v-else
                  class="font-bold tabular-nums"
                  :class="(r.varianceCents ?? 0) !== 0 ? 'text-amber-500' : 'font-medium text-muted-foreground'"
                >{{ varianceView(r.varianceCents, r.status).amount }}</span>
              </TableCell>

              <TableCell>
                {{ r.storeName }}
                <span v-if="r.reviewedAt" class="ml-1.5 text-xs text-muted-foreground">· explained</span>
              </TableCell>
              <TableCell>{{ when(r.openedAt) }}</TableCell>
              <TableCell class="text-sm text-muted-foreground">{{ custody(r) }}</TableCell>
              <TableCell class="text-right tabular-nums">
                <b v-if="r.saleCount === 0 && (r.varianceCents ?? 0) !== 0">0</b>
                <template v-else>{{ r.saleCount }}</template>
              </TableCell>
              <TableCell class="text-right tabular-nums">
                {{ money(r.openingCashCents) }}
                <!-- The whole story in one cell: what was counted, against what was left. -->
                <span
                  v-if="r.openingExpectedCents !== null && r.openingVarianceCents !== 0"
                  class="text-xs text-muted-foreground"
                >of {{ money(r.openingExpectedCents) }}</span>
              </TableCell>
              <TableCell class="text-right tabular-nums">
                <template v-if="r.closingCountedCashCents !== null">
                  {{ money(r.closingCountedCashCents) }}
                </template>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </Table>

      <div v-if="loading" class="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> Loading drawers…
      </div>
    </div>

    <!-- ————— one drawer, and its whole arithmetic ————— -->
    <Sheet v-model:open="detailOpen">
      <SheetContent class="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader class="sr-only">
          <SheetTitle>
            <template v-if="detail">
              {{ detail.storeName }} drawer, opened {{ when(detail.openedAt) }}
            </template>
            <template v-else>Drawer</template>
          </SheetTitle>
        </SheetHeader>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <template v-if="detail">
            <div class="border-b p-6 pr-12">
              <p class="text-sm text-muted-foreground">{{ detail.storeName }}</p>
              <h2 class="text-lg font-semibold tracking-tight">{{ when(detail.openedAt) }}</h2>
              <p class="mt-1 text-sm text-muted-foreground">
                Opened by {{ detail.openedByName }}<template v-if="detail.closedByName && detail.closedByName !== detail.openedByName">, closed by {{ detail.closedByName }}</template>
                <template v-if="detail.closedAt"> · closed {{ when(detail.closedAt) }}</template>
              </p>
            </div>

            <!-- The opening reconciliation, first, because it happened first. -->
            <section v-if="detail.openingExpectedCents !== null" class="border-b p-6">
              <h3 class="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Before the shift
              </h3>
              <dl class="grid gap-1.5 text-sm">
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">Left by the last close</dt>
                  <dd class="tabular-nums">{{ money(detail.openingExpectedCents) }}</dd>
                </div>
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">Counted at open</dt>
                  <dd class="tabular-nums">{{ money(detail.openingCashCents) }}</dd>
                </div>
                <div
                  v-if="detailOpening"
                  class="flex justify-between border-t pt-1.5 font-bold"
                  :class="detailOpening.off ? 'text-amber-500' : ''"
                >
                  <dt>{{ detailOpening.off ? 'Missing overnight' : 'Matched' }}</dt>
                  <dd class="tabular-nums">{{ detailOpening.amount }}</dd>
                </div>
              </dl>
            </section>

            <!-- C's reconciliation arithmetic, which is where it belongs. -->
            <section class="border-b p-6">
              <h3 class="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                The drawer
              </h3>
              <dl class="grid gap-1.5 text-sm">
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">Carried in</dt>
                  <dd class="tabular-nums">{{ money(detail.openingCashCents) }}</dd>
                </div>
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">
                    Cash sales · {{ detail.saleCount }}
                  </dt>
                  <dd class="tabular-nums">+{{ money(detail.cashSalesCents) }}</dd>
                </div>
                <div v-if="detail.cashRefundsCents > 0" class="flex justify-between">
                  <dt class="text-muted-foreground">Cash refunds</dt>
                  <dd class="tabular-nums text-destructive">−{{ money(detail.cashRefundsCents) }}</dd>
                </div>
                <div
                  v-for="type in ['PAID_IN', 'PAID_OUT', 'DROP', 'PICKUP']"
                  :key="type"
                  v-show="movementTotal(type) > 0"
                  class="flex justify-between"
                >
                  <dt class="text-muted-foreground">{{ MOVEMENT_LABEL[type] }}</dt>
                  <dd class="tabular-nums">
                    {{ type === 'PAID_IN' ? '+' : '−' }}{{ money(movementTotal(type)) }}
                  </dd>
                </div>

                <template v-if="detail.status === 'CLOSED'">
                  <div class="flex justify-between border-t pt-1.5 font-semibold">
                    <dt>Expected</dt>
                    <dd class="tabular-nums">{{ money(detail.expectedCashCents ?? 0) }}</dd>
                  </div>
                  <div class="flex justify-between font-semibold">
                    <dt>Counted out</dt>
                    <dd class="tabular-nums">{{ money(detail.closingCountedCashCents ?? 0) }}</dd>
                  </div>
                  <div
                    v-if="detailVariance"
                    class="flex justify-between text-base font-bold"
                    :class="detailVariance.off ? 'text-amber-500' : 'text-primary'"
                  >
                    <dt>On shift</dt>
                    <dd class="tabular-nums">{{ detailVariance.amount }} {{ detailVariance.word }}</dd>
                  </div>
                </template>
                <div v-else class="flex justify-between border-t pt-1.5 text-base font-bold">
                  <dt>In the till now</dt>
                  <dd class="tabular-nums">
                    {{ money(tills.find((t) => t.shiftId === detail!.id)?.balanceCents ?? 0) }}
                  </dd>
                </div>
              </dl>

              <p v-if="detail.cardSalesCents > 0" class="mt-3 text-xs text-muted-foreground">
                {{ money(detail.cardSalesCents) }} on card settles to the bank, not this drawer.
              </p>
              <p v-if="detail.status === 'OPEN'" class="mt-3 text-xs text-muted-foreground">
                Counted at close, at the register — a count keyed from a desk would not have
                touched the cash.
              </p>
            </section>

            <section v-if="movements.length > 0" class="border-b p-6">
              <h3 class="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Cash moved
              </h3>
              <ul class="grid gap-2 text-sm">
                <li v-for="m in movements" :key="m.id" class="flex justify-between gap-3">
                  <span class="text-muted-foreground">
                    {{ MOVEMENT_LABEL[m.type] }} · {{ m.reason }} · {{ m.userName }}
                  </span>
                  <span class="tabular-nums">{{ money(m.amountCents) }}</span>
                </li>
              </ul>
            </section>

            <section v-if="detail.notes" class="border-b p-6">
              <h3 class="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                What the cashier wrote at the count
              </h3>
              <p class="text-sm">{{ detail.notes }}</p>
            </section>

            <!-- The admin's account. Separate from `notes` on purpose — see the service. -->
            <section v-if="detail.status === 'CLOSED'" class="p-6">
              <h3 class="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Why it was off
              </h3>
              <p v-if="detail.reviewedAt" class="mb-2 text-xs text-muted-foreground">
                {{ detail.reviewedByName }} · {{ when(detail.reviewedAt) }}
              </p>
              <textarea
                v-model="reviewNote"
                rows="3"
                maxlength="500"
                placeholder="Counted wrong at open — found the $50 under the till."
                class="w-full rounded-lg border bg-background px-3 py-2 text-sm"
              />
              <FieldError v-if="reviewError" class="mt-2">{{ reviewError }}</FieldError>
              <div class="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  :disabled="reviewNote.trim() === '' || reviewNote.trim() === (detail.reviewNote ?? '') || savingReview"
                  @click="saveReview"
                >
                  {{ detail.reviewedAt ? 'Update' : 'Save' }}
                </Button>
                <span v-if="savingReview" class="text-xs text-muted-foreground">Saving…</span>
              </div>
            </section>

            <section v-if="detail.saleCount > 0" class="border-t p-6">
              <Button as-child variant="outline" size="sm">
                <NuxtLink :to="`/admin/sales?shift=${detail.id}`">
                  View the {{ detail.saleCount }} {{ detail.saleCount === 1 ? 'sale' : 'sales' }}
                  on this drawer
                </NuxtLink>
              </Button>
            </section>
          </template>

          <FieldError v-else-if="detailError" class="p-6">{{ detailError }}</FieldError>
          <div v-else class="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" /> Opening…
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <p class="flex items-start gap-2 text-xs text-muted-foreground">
      <CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        A drawer is closed at the register, not from here — the count is taken before the
        expected figure is shown, and keying one from a desk would not have touched the cash.
      </span>
    </p>
  </div>
</template>
