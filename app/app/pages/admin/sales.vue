<script setup lang="ts">
import type {
  CatalogReference,
  SaleHistoryRow,
  SaleReceipt,
  SalesPage,
  SalesTotals,
} from '@huta/shared/schemas'
import SearchInput from '~/components/SearchInput.vue'
import { FieldError } from '~/components/ui/field'
import { Button } from '~/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { Toggle } from '~/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { ApiError, apiFetch } from '~/composables/useApi'
import { STATUS_BADGE, money, saleNumber } from '~/lib/sale-format'

/**
 * The sales ledger (Kasan's A1 pick, 2026-08-21) — one table across every store, with a
 * subtotal bar where each day begins and the receipt in a slide-over.
 *
 * READ-ONLY for reversals, and it says so rather than hiding a button: a cash refund pays
 * out of a drawer and a void un-rings a sale on the shift it was rung on, so both belong at
 * a register. An admin who needs to do either attaches at a terminal, a path that already
 * works.
 *
 * Every figure is the server's, from the same filters the table uses — so the strip above
 * cannot describe a different set than the rows below it, which is the failure the house
 * counts-match-their-scope rule was written about. Unlike the catalog's store-only strip,
 * this one is deliberately filter-DEPENDENT for exactly that reason.
 */
definePageMeta({ layout: 'default' })
useHead({ title: 'Sales · Huta' })

const route = useRoute()
const router = useRouter()

const fmt = money
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

/* ————— filters, all of them in the URL ————— */

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

const preset = ref<Preset>('today')
const from = ref('')
const to = ref('')
const storeId = ref<string | undefined>(undefined)
const cashierId = ref<string | undefined>(undefined)
const method = ref<'CASH' | 'CARD' | undefined>(undefined)
const status = ref<string | undefined>(undefined)
const numberTerm = ref('')
/** One cash drawer, arrived at from /admin/drawers. */
const shiftId = ref<string | undefined>(undefined)
const page = ref(1)
const selectedId = ref<string | null>(null)

const PRESETS: ReadonlyArray<{ key: Preset, label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
]

/** Local calendar dates as `YYYY-MM-DD`; the SERVER resolves them in the store's zone. */
function localDate(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function applyPreset(next: Preset) {
  preset.value = next
  if (next === 'today') { from.value = localDate(); to.value = localDate() }
  else if (next === 'yesterday') { from.value = localDate(-1); to.value = localDate(-1) }
  else if (next === 'week') { from.value = localDate(-6); to.value = localDate() }
  else if (next === 'month') { from.value = startOfMonth(); to.value = localDate() }
  resetPageAndSync()
}

/**
 * A receipt number is a lookup across ALL of history, so it escapes the date range — the
 * alternative is typing a number you can see on a slip and being told it does not exist.
 */
const searchingNumber = computed(
  () => /^\d+$/.test(numberTerm.value.trim()) && numberTerm.value.trim() !== '',
)

const filters = computed(() => {
  if (searchingNumber.value) {
    return { storeId: storeId.value, number: Number(numberTerm.value.trim()) }
  }
  /**
   * A drawer escapes the date chips, exactly as a receipt number does. Two of these shifts
   * ran over 24 hours and the default preset is TODAY, so honouring the range here would
   * show a slice of the drawer — or nothing at all — under a heading naming the whole thing.
   */
  if (shiftId.value) return { shiftId: shiftId.value }
  return {
    storeId: storeId.value,
    cashierId: cashierId.value,
    method: method.value,
    status: status.value,
    from: from.value || undefined,
    to: to.value || undefined,
  }
})

/* ————— URL sync, the catalog's bidirectional pattern ————— */

let syncing = false

function applyFromQuery() {
  syncing = true
  const q = route.query
  const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined)

  preset.value = (str('preset') as Preset) ?? 'today'
  storeId.value = str('store')
  cashierId.value = str('cashier')
  method.value = str('method') as 'CASH' | 'CARD' | undefined
  status.value = str('status')
  numberTerm.value = str('number') ?? ''
  shiftId.value = str('shift')
  page.value = Number(str('page') ?? '1') || 1
  selectedId.value = str('sale') ?? null

  const qFrom = str('from')
  const qTo = str('to')
  if (qFrom || qTo) {
    from.value = qFrom ?? ''
    to.value = qTo ?? ''
  } else {
    // No dates in the URL — resolve whatever preset is named, defaulting to today.
    const p = preset.value
    if (p === 'yesterday') { from.value = localDate(-1); to.value = localDate(-1) }
    else if (p === 'week') { from.value = localDate(-6); to.value = localDate() }
    else if (p === 'month') { from.value = startOfMonth(); to.value = localDate() }
    else { from.value = localDate(); to.value = localDate() }
  }
  void nextTick(() => (syncing = false))
}

function writeQuery() {
  if (syncing) return
  void router.replace({
    query: {
      preset: preset.value !== 'today' ? preset.value : undefined,
      from: preset.value === 'custom' ? from.value || undefined : undefined,
      to: preset.value === 'custom' ? to.value || undefined : undefined,
      store: storeId.value,
      cashier: cashierId.value,
      method: method.value,
      status: status.value,
      number: numberTerm.value.trim() || undefined,
      shift: shiftId.value,
      page: page.value > 1 ? String(page.value) : undefined,
      sale: selectedId.value ?? undefined,
    },
  })
}

function resetPageAndSync() {
  page.value = 1
  writeQuery()
}

watch(() => route.query, applyFromQuery)

/* ————— data ————— */

const pageData = ref<SalesPage | null>(null)
const totals = ref<SalesTotals | null>(null)
const reference = ref<CatalogReference | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function fetchAll() {
  loading.value = true
  error.value = null
  try {
    const [list, sums] = await Promise.all([
      apiFetch<SalesPage>('/sales', {
        query: { ...filters.value, page: page.value, pageSize: 50 },
      }),
      apiFetch<SalesTotals>('/sales/totals', { query: filters.value }),
    ])
    pageData.value = list
    totals.value = sums
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not load the sales.'
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(numberTerm, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(resetPageAndSync, 300)
})

watch([filters, page], () => void fetchAll(), { deep: true })

onMounted(async () => {
  applyFromQuery()
  // A ?sale= link must OPEN the drawer, not merely highlight a row. Without this the URL
  // the page itself writes is not one you can paste back — and with two stores sharing
  // receipt numbers, clicking "#0002" is not a substitute for the link.
  const deepLink = selectedId.value
  await fetchAll()
  if (deepLink) await open(deepLink)
  try {
    reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  } catch {
    // Only the store picker degrades; the ledger still works with what the payload echoes.
  }
})

/* ————— rows, grouped by day ————— */

interface DayGroup {
  readonly day: string
  readonly label: string
  readonly saleCount: number
  readonly grossCents: number
  readonly refundsCents: number
  readonly netCents: number
  /** Gross taken per hour of the business day, 24 entries. Empty when totals have not landed. */
  readonly hours: readonly number[]
  readonly rows: SaleHistoryRow[]
}

/**
 * The separators use the SERVER's day buckets, matched by the row's own local date. The
 * server cut them in `Store.timezone`, so a sale rung at 9pm Eastern sits under that day
 * even though its UTC timestamp says the next one.
 */
const groups = computed<DayGroup[]>(() => {
  const rows = pageData.value?.sales ?? []
  const zone = totals.value?.timezone
  const keyFor = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      ...(zone ? { timeZone: zone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso))

  const byDay = new Map<string, SaleHistoryRow[]>()
  for (const row of rows) {
    const key = keyFor(row.createdAt)
    const list = byDay.get(key)
    if (list) list.push(row)
    else byDay.set(key, [row])
  }

  return [...byDay.entries()].map(([day, dayRows]) => {
    const totalsForDay = totals.value?.days.find((d) => d.day === day)
    return {
      day,
      // Parsed as noon to dodge the DST edge where midnight local is the previous day.
      label: dayFmt.format(new Date(`${day}T12:00:00`)),
      saleCount: totalsForDay?.saleCount ?? dayRows.length,
      grossCents: totalsForDay?.grossCents ?? 0,
      refundsCents: totalsForDay?.refundsCents ?? 0,
      netCents: totalsForDay?.netCents ?? 0,
      // Server-side, like the figures beside them: the list is paged, so a shape derived
      // from the visible rows would be a fraction of the day under a total that is not.
      hours: totalsForDay?.hours ?? [],
      rows: dayRows,
    }
  })
})

/**
 * Average sale over the filtered range.
 *
 * Null rather than 0 when nothing was rung — the suppliers-scorecard rule that an average
 * with no sample is not a figure — and it renders with its sample size, because an average
 * over 3 sales and one over 300 are different claims a bare number cannot separate.
 */
const averageSaleCents = computed(() => {
  const t = totals.value
  if (!t || t.saleCount === 0) return null
  return Math.round(t.grossCents / t.saleCount)
})

/**
 * The hours the sparklines span, shared by EVERY day on screen.
 *
 * Per-day trimming would give each day its own x-axis, so a quiet morning and a busy one
 * would draw the same shape and the two could not be compared — which is the only thing a
 * row of sparklines is for. One window, computed across the visible days, from the first
 * hour anything was taken to the last.
 */
const sparkWindow = computed(() => {
  let first = 24
  let last = -1
  for (const group of groups.value) {
    group.hours.forEach((cents, hour) => {
      if (cents <= 0) return
      if (hour < first) first = hour
      if (hour > last) last = hour
    })
  }
  if (last < first) return null
  // A single trading hour would render as one fat bar; widen it so the shape reads as a day.
  if (last - first < 3) {
    first = Math.max(0, first - 1)
    last = Math.min(23, last + 2)
  }
  return { first, last }
})

/** The tallest hour anywhere on screen — the scale every sparkline is drawn against. */
const sparkPeak = computed(() => {
  let peak = 0
  for (const group of groups.value) {
    for (const cents of group.hours) if (cents > peak) peak = cents
  }
  return peak
})

function sparkBars(hours: readonly number[]): Array<{ hour: number, pct: number }> {
  const win = sparkWindow.value
  if (!win || sparkPeak.value <= 0) return []
  const out: Array<{ hour: number, pct: number }> = []
  for (let hour = win.first; hour <= win.last; hour += 1) {
    out.push({ hour, pct: Math.round(((hours[hour] ?? 0) / sparkPeak.value) * 100) })
  }
  return out
}

const hourLabel = (hour: number) =>
  hour === 0 ? '12am' : hour === 12 ? '12pm' : hour > 12 ? `${hour - 12}pm` : `${hour}am`

const showingLabel = computed(() => {
  const d = pageData.value
  if (!d || d.total === 0) return null
  const first = (d.page - 1) * d.pageSize + 1
  const last = Math.min(d.page * d.pageSize, d.total)
  return `Showing ${first}–${last} of ${d.total}`
})

/* ————— the receipt slide-over ————— */

const detail = ref<SaleReceipt | null>(null)
const detailOpen = ref(false)
const detailError = ref<string | null>(null)
/** The "why is this read-only" disclosure. Collapsed for each new sale. */
const whyOpen = ref(false)

async function open(saleId: string) {
  selectedId.value = saleId
  detailOpen.value = true
  detailError.value = null
  detail.value = null
  whyOpen.value = false
  writeQuery()
  try {
    detail.value = await apiFetch<SaleReceipt>(`/sales/${saleId}`)
  } catch (err) {
    detailError.value = err instanceof ApiError ? err.message : 'Could not open that sale.'
  }
}

watch(detailOpen, (isOpen) => {
  if (!isOpen) {
    selectedId.value = null
    writeQuery()
  }
})

const netOf = (row: SaleHistoryRow) => row.totalCents - row.refundedCents
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">Sales</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Every transaction, across both stores.
        <template v-if="totals"> Days are cut in {{ totals.timezone.replace('_', ' ') }}.</template>
      </p>
    </div>

    <FieldError
      v-if="error"
      class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
      {{ error }}
    </FieldError>

    <!-- filters -->
    <div class="flex flex-wrap items-center gap-2">
      <ToggleGroup
        :model-value="preset"
        type="single"
        :spacing="2"
        aria-label="Date range"
        class="flex-wrap"
        @update:model-value="(v) => v && applyPreset(v as typeof preset)"
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
        @update:model-value="(v) => { storeId = v === 'all' ? undefined : (v as string); resetPageAndSync() }"
      >
        <SelectTrigger class="h-8 w-[190px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All stores</SelectItem>
          <SelectItem v-for="s in reference?.stores ?? []" :key="s.id" :value="s.id">
            {{ s.name }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Select
        :model-value="cashierId ?? 'all'"
        @update:model-value="(v) => { cashierId = v === 'all' ? undefined : (v as string); resetPageAndSync() }"
      >
        <SelectTrigger class="h-8 w-[170px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everyone</SelectItem>
          <SelectItem v-for="c in totals?.cashiers ?? []" :key="c.id" :value="c.id">
            {{ c.name }}
          </SelectItem>
        </SelectContent>
      </Select>

      <!--
        Method and Voided were three buttons in ONE role="radiogroup", but they are two
        different axes: Cash/Card set `method`, Voided sets `status`, and choosing one never
        cleared the other. Split accordingly — a single-select group and a standalone toggle.
      -->
      <ToggleGroup
        :model-value="method ?? ''"
        type="single"
        :spacing="2"
        aria-label="Payment method"
        @update:model-value="(v) => { method = (v as typeof method) || undefined; resetPageAndSync() }"
      >
        <ToggleGroupItem value="CASH" class="inline-flex h-8 items-center rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground">Cash</ToggleGroupItem>
        <ToggleGroupItem value="CARD" class="inline-flex h-8 items-center rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground">Card</ToggleGroupItem>
      </ToggleGroup>

      <Toggle
        :model-value="status === 'VOIDED'"
        aria-label="Voided sales only"
        class="inline-flex h-8 items-center rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
        @update:model-value="(on) => { status = on ? 'VOIDED' : undefined; resetPageAndSync() }"
      >
        Voided
      </Toggle>

      <SearchInput
        v-model="numberTerm"
        placeholder="Sale number…"
        inputmode="numeric"
        aria-label="Search by sale number"
        class="ml-auto h-8 w-[150px]"
      />
    </div>

    <p v-if="searchingNumber" class="-mt-2 text-xs text-muted-foreground">
      Searching every day, not just the selected range.
    </p>

    <!--
      A drawer filter overrides the chips above it, so it has to SAY so and offer a way out —
      otherwise the date range reads as active while being ignored.
    -->
    <div
      v-if="shiftId"
      class="-mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs"
    >
      <span>Showing one cash drawer — every sale rung on it, whatever day it fell on.</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-6 px-2 text-xs"
        @click="() => { shiftId = undefined; resetPageAndSync() }"
      >
        Clear
      </Button>
      <Button as-child variant="ghost" size="sm" class="h-6 px-2 text-xs">
        <NuxtLink :to="`/admin/drawers?drawer=${shiftId}`">Back to the drawer</NuxtLink>
      </Button>
    </div>

    <!-- totals: the SAME filters as the table below, never a different scope -->
    <div v-if="totals" class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      <!-- Net leads, with the two figures it is made of underneath it rather than as tiles
           of their own — gross and refunds are how you check the number, not the number. -->
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <div class="text-lg font-bold tabular-nums text-primary">{{ fmt(totals.netCents) }}</div>
        <div class="text-xs text-muted-foreground">Net taken</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">
          {{ fmt(totals.grossCents) }} gross<template v-if="totals.refundsCents > 0">
            · <span class="text-destructive">−{{ fmt(totals.refundsCents) }}</span> back</template>
        </div>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <div class="text-lg font-bold tabular-nums">{{ totals.saleCount }}</div>
        <div class="text-xs text-muted-foreground">Sales</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">
          <template v-if="totals.voidedCount > 0">{{ totals.voidedCount }} voided</template>
          <template v-else>none voided</template>
        </div>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <!-- An average travels with its sample size, and is an em dash rather than $0.00
             when there is nothing to average. -->
        <div class="text-lg font-bold tabular-nums">
          {{ averageSaleCents === null ? '—' : fmt(averageSaleCents) }}
        </div>
        <div class="text-xs text-muted-foreground">Average sale</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">
          <template v-if="averageSaleCents !== null">over {{ totals.saleCount }}</template>
        </div>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <div class="text-lg font-bold tabular-nums">{{ fmt(totals.cashCents) }}</div>
        <div class="text-xs text-muted-foreground">Cash</div>
      </div>
      <div class="rounded-xl border bg-card px-3.5 py-2.5">
        <div class="text-lg font-bold tabular-nums">{{ fmt(totals.cardCents) }}</div>
        <div class="text-xs text-muted-foreground">Card</div>
      </div>
    </div>

    <!-- the ledger -->
    <div class="rounded-xl border bg-card" :class="loading ? 'pointer-events-none opacity-50' : ''">
      <Table>
        <TableCaption class="sr-only">Sales, newest first, grouped by day</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">#</TableHead>
            <TableHead scope="col">Time</TableHead>
            <TableHead scope="col">Store</TableHead>
            <TableHead scope="col">Cashier</TableHead>
            <TableHead scope="col">Method</TableHead>
            <TableHead scope="col" class="text-right">Total</TableHead>
            <TableHead scope="col">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="group in groups" :key="group.day">
            <!-- The day subtotal bar. Not a TableRow's hover target — it is a heading. -->
            <TableRow class="bg-accent/40 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/40">
              <TableCell colspan="4" class="py-1.5">
                {{ group.label }} · {{ group.saleCount }}
                {{ group.saleCount === 1 ? 'sale' : 'sales' }}
              </TableCell>
              <!--
                When the day was busy. Every sparkline on screen shares one window and one
                peak, so two days can actually be compared — a per-day scale would draw a
                quiet morning and a heaving one identically.
              -->
              <TableCell class="py-1.5">
                <div
                  v-if="sparkBars(group.hours).length"
                  class="flex h-5 items-end gap-px"
                  role="img"
                  :aria-label="`Takings by hour on ${group.label}`"
                >
                  <span
                    v-for="bar in sparkBars(group.hours)"
                    :key="bar.hour"
                    class="min-h-px w-1 rounded-t-[1px] bg-primary/55"
                    :style="{ height: `${Math.max(bar.pct, bar.pct > 0 ? 8 : 0)}%` }"
                    :title="`${hourLabel(bar.hour)} · ${fmt(group.hours[bar.hour] ?? 0)}`"
                  />
                </div>
              </TableCell>
              <TableCell class="py-1.5 text-right tabular-nums text-foreground">
                {{ fmt(group.netCents) }}
                <span v-if="group.refundsCents > 0" class="ml-1 font-normal text-destructive">
                  −{{ fmt(group.refundsCents) }}
                </span>
              </TableCell>
              <TableCell class="py-1.5" />
            </TableRow>

            <TableRow
              v-for="row in group.rows"
              :key="row.id"
              :data-state="selectedId === row.id ? 'selected' : undefined"
            >
              <TableCell>
                <!-- The row's accessible control is this button; the row itself is not one. -->
                <button
                  type="button"
                  class="font-medium tabular-nums underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @click="open(row.id)"
                >
                  {{ saleNumber(row.number) }}
                </button>
              </TableCell>
              <TableCell class="tabular-nums text-muted-foreground">
                {{ timeFmt.format(new Date(row.createdAt)) }}
              </TableCell>
              <TableCell class="text-muted-foreground">{{ row.storeName }}</TableCell>
              <TableCell class="text-muted-foreground">{{ row.cashierName }}</TableCell>
              <TableCell>
                <span
                  v-for="pm in row.paymentMethods"
                  :key="pm"
                  class="mr-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold"
                >
                  {{ pm === 'CASH' ? 'Cash' : 'Card' }}
                </span>
              </TableCell>
              <!--
                One money column, not three. Refunded and Net were empty on nine rows in ten,
                so they cost width on every row to serve the rare one; a refunded sale now
                strikes its original and states what it kept, which makes the exception the
                loud thing instead of the column heading.
              -->
              <TableCell class="text-right tabular-nums">
                <template v-if="row.refundedCents > 0">
                  <span class="text-xs text-muted-foreground line-through">{{ fmt(row.totalCents) }}</span>
                  <span class="ml-1.5 font-medium">{{ fmt(netOf(row)) }}</span>
                </template>
                <template v-else>{{ fmt(row.totalCents) }}</template>
              </TableCell>
              <TableCell>
                <span
                  v-if="STATUS_BADGE[row.status]"
                  class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="STATUS_BADGE[row.status]!.class"
                >
                  {{ STATUS_BADGE[row.status]!.label }}
                </span>
              </TableCell>
            </TableRow>
          </template>

          <TableEmpty v-if="!groups.length && !loading" :colspan="7" class="text-muted-foreground">
            {{ searchingNumber ? 'No sale with that number.' : 'Nothing rung in this range.' }}
          </TableEmpty>
        </TableBody>
      </Table>
    </div>

    <div v-if="pageData && pageData.total > 0" class="flex items-center gap-3 text-sm text-muted-foreground">
      <span>{{ showingLabel }}</span>
      <div class="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="page -= 1; writeQuery()">
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

    <p class="rounded-r-md border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
      Refunds count on the day the money went out, which may not be the day of the sale —
      that is what makes these figures reconcile with a shift close.
    </p>

    <!-- the receipt -->
    <!--
      The receipt drawer. The header is a bare visually-hidden title because the record
      renders its own — the store belongs beside the number, since sale numbers repeat
      across stores and "#0002" alone identifies nothing.
    -->
    <Sheet v-model:open="detailOpen">
      <SheetContent class="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <!--
          Visually hidden because the record renders its own header. It still has to exist
          and has to NAME the sale — reka-ui uses it as the dialog's accessible name, and
          "#0002" alone is ambiguous across stores.
        -->
        <SheetHeader class="sr-only">
          <SheetTitle>
            <template v-if="detail">
              Sale {{ saleNumber(detail.number) }} at {{ detail.storeName }}
            </template>
            <template v-else>Receipt</template>
          </SheetTitle>
        </SheetHeader>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <SalesReceiptRecord v-if="detail" :receipt="detail" />

          <FieldError v-else-if="detailError" class="p-6">
            {{ detailError }}
          </FieldError>
          <p v-else class="p-6 text-sm text-muted-foreground">Opening…</p>
        </div>

        <!--
          Demoted to a quiet footer with the explanation behind a control. It was the
          largest coloured block in the drawer and is the least important thing in it.
        -->
        <div v-if="detail" class="border-t bg-muted/30 px-4 py-2.5">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">Reversals happen at a register.</span>
            <button
              type="button"
              class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              :aria-expanded="whyOpen"
              @click="whyOpen = !whyOpen"
            >
              {{ whyOpen ? 'Hide' : 'Why?' }}
            </button>
          </div>
          <p v-if="whyOpen" class="mt-2 text-xs text-muted-foreground">
            A cash refund pays out of a drawer and a void un-rings the sale on the shift it
            was rung on — neither exists at a desk. Attach at a terminal to do either.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>
