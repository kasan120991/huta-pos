<script setup lang="ts">
import type { SaleHistoryRow, SaleReceipt, SalesPage, SalesTotals } from '@huta/shared/schemas'
import { ReceiptText, Search, TriangleAlert } from '@lucide/vue'
import SearchInput from '~/components/SearchInput.vue'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { FieldError } from '~/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { Button } from '~/components/ui/button'
import { ApiError, apiFetch } from '~/composables/useApi'
import { STATUS_BADGE, money as fmt, saleNumber } from '~/lib/sale-format'
import { useAuthStore } from '~/stores/auth'

/**
 * Transaction history at the counter (Kasan's B1 pick, 2026-08-21) — deliberately the
 * return screen's twin: sales down the left, the full receipt on the right.
 *
 * This screen READS. Return and Void hand off to `/register/return?sale=…`, which already
 * owns the refund composer, the manager-approval overlay and the void dialog. Re-hosting
 * any of that here would mean two copies of a step-up flow, and so two audit stories for
 * one action.
 *
 * Where it differs from `/register/return`: this one renders the FULL sale via
 * `SalesReceiptCounter` — items left, money right, sized for touch — because looking a sale
 * up is the job here, not picking lines to give back.
 */
definePageMeta({ layout: 'register' })
useHead({ title: 'History · Huta' })

const router = useRouter()
const auth = useAuthStore()
const booted = ref(false)

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')
  booted.value = true
  await load()
})

const timeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/* ————— the range ————— */

type Range = 'today' | 'yesterday' | 'week'

const range = ref<Range>('today')
const RANGES: ReadonlyArray<{ key: Range, label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
]

/**
 * Chips, not a date picker: a cashier on a touchscreen should never have to type a date,
 * and "today" answers almost every question asked at a counter.
 *
 * The dates are the LOCAL calendar dates the terminal is standing in, sent as plain
 * `YYYY-MM-DD`. The server resolves them against `Store.timezone`, so a register whose
 * clock drifts to another zone still gets the shop's business day.
 */
function localDate(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

const rangeDates = computed<{ from: string, to: string }>(() => {
  switch (range.value) {
    case 'yesterday': return { from: localDate(-1), to: localDate(-1) }
    case 'week': return { from: localDate(-6), to: localDate() }
    default: return { from: localDate(), to: localDate() }
  }
})

const rangeLabel = computed(
  () => RANGES.find((r) => r.key === range.value)?.label ?? 'Today',
)

/* ————— data ————— */

const rows = ref<SaleHistoryRow[]>([])
const totals = ref<SalesTotals | null>(null)
const loadingRows = ref(false)
const listError = ref<string | null>(null)

const term = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(term, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(), 200)
})
watch(range, () => void load())

/** The terminal's own store, always sent explicitly. */
const storeId = computed(() => auth.terminal?.store.id)

const query = computed(() => {
  const digits = term.value.trim()
  // A receipt number is a lookup across the whole history, so it deliberately ESCAPES the
  // day chips — searching "18" while on Today should find sale 18, not nothing.
  if (/^\d+$/.test(digits) && digits !== '') {
    return { storeId: storeId.value, number: Number(digits) }
  }
  return { storeId: storeId.value, ...rangeDates.value }
})

const searching = computed(() => /^\d+$/.test(term.value.trim()) && term.value.trim() !== '')

async function load() {
  if (!booted.value && !storeId.value) return
  loadingRows.value = true
  listError.value = null
  try {
    const [page, sums] = await Promise.all([
      apiFetch<SalesPage>('/sales', { query: { ...query.value, pageSize: 50 } }),
      apiFetch<SalesTotals>('/sales/totals', { query: query.value }),
    ])
    rows.value = [...page.sales]
    totals.value = sums
    if (!rows.value.some((r) => r.id === detail.value?.id)) detail.value = null
  } catch (err) {
    listError.value = err instanceof ApiError ? err.message : 'Could not load the history.'
  } finally {
    loadingRows.value = false
  }
}

/* ————— the selected sale ————— */

const detail = ref<SaleReceipt | null>(null)
const loadingDetail = ref(false)
const detailError = ref<string | null>(null)

async function select(saleId: string) {
  loadingDetail.value = true
  detailError.value = null
  try {
    detail.value = await apiFetch<SaleReceipt>(`/sales/${saleId}`)
  } catch (err) {
    detailError.value = err instanceof ApiError ? err.message : 'Could not open that sale.'
  } finally {
    loadingDetail.value = false
  }
}

/**
 * A void needs the sale COMPLETED with nothing already given back — after that it is a
 * refund, not a void. The server enforces it (and also that the sale's shift is still
 * open, which this screen cannot know); this only decides whether to offer the button.
 */
const voidable = computed(
  () => detail.value?.status === 'COMPLETED' && detail.value.refunds.length === 0,
)

/** Hand off to the surface that owns money-back. The sale arrives already selected. */
function handOff(saleId: string) {
  void router.push(`/register/return?sale=${saleId}`)
}
</script>

<template>
  <div v-if="booted" class="flex h-dvh flex-col">
    <RegisterBar />

    <div class="flex min-h-0 flex-1">
      <RegisterRail active="/register/history" />

      <div class="flex min-h-0 flex-1 flex-col">
        <!-- the day's money, scoped to this terminal's store -->
        <div class="border-b px-4 py-2.5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <!-- A range is always chosen, so an empty value from a re-click is ignored. -->
            <ToggleGroup
              :model-value="range"
              type="single"
              :spacing="2"
              aria-label="Range"
              @update:model-value="(v) => v && (range = v as Range)"
            >
              <ToggleGroupItem
                v-for="r in RANGES"
                :key="r.key"
                :value="r.key"
                class="h-9 rounded-xl border border-input px-3.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                {{ r.label }}
              </ToggleGroupItem>
            </ToggleGroup>

            <div v-if="totals" class="flex items-center gap-4 text-sm">
              <span class="text-xs text-muted-foreground">{{ rangeLabel }}</span>
              <span><b class="tabular-nums">{{ totals.saleCount }}</b>
                <span class="text-xs text-muted-foreground"> sales</span></span>
              <span class="font-bold tabular-nums">{{ fmt(totals.grossCents) }}</span>
              <span v-if="totals.refundsCents > 0" class="tabular-nums text-destructive">
                −{{ fmt(totals.refundsCents) }}
              </span>
              <span class="text-xs text-muted-foreground">
                net <b class="tabular-nums text-primary">{{ fmt(totals.netCents) }}</b>
              </span>
            </div>
          </div>
        </div>

        <div class="flex min-h-0 flex-1">
          <!-- ————— the list ————— -->
          <div class="flex w-[360px] shrink-0 flex-col border-r p-4">
            <div class="relative mb-3">
              <Search class="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <SearchInput
                v-model="term"
                placeholder="Sale number…"
                inputmode="numeric"
                aria-label="Search by sale number"
                class="h-11 pl-9"
              />
            </div>

            <p v-if="searching" class="mb-2 text-xs text-muted-foreground">
              Searching every day, not just {{ rangeLabel.toLowerCase() }}.
            </p>

            <div class="relative min-h-0 flex-1 overflow-y-auto">
              <div v-if="loadingRows" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true"></div>

              <Alert
                v-if="listError"
                variant="destructive"
                class="border-destructive/40 bg-destructive/10"
              >
                <TriangleAlert />
                <AlertTitle>Couldn't load sales</AlertTitle>
                <AlertDescription>{{ listError }}</AlertDescription>
              </Alert>

              <div v-else class="flex flex-col gap-2">
                <button
                  v-for="row in rows"
                  :key="row.id"
                  type="button"
                  class="flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors"
                  :class="detail?.id === row.id
                    ? 'border-primary/50 bg-primary/8'
                    : 'bg-card hover:bg-accent/40'"
                  @click="select(row.id)"
                >
                  <span class="flex items-center justify-between gap-2">
                    <span class="text-sm font-bold">{{ saleNumber(row.number) }}</span>
                    <span class="font-semibold tabular-nums">{{ fmt(row.totalCents) }}</span>
                  </span>
                  <span class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {{ timeFmt.format(new Date(row.createdAt)) }} · {{ row.cashierName }}
                    <span
                      v-for="pm in row.paymentMethods"
                      :key="pm"
                      class="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold"
                    >
                      {{ pm === 'CASH' ? 'Cash' : 'Card' }}
                    </span>
                    <span
                      v-if="STATUS_BADGE[row.status]"
                      class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      :class="STATUS_BADGE[row.status]!.class"
                    >
                      {{ STATUS_BADGE[row.status]!.label }}
                    </span>
                  </span>
                </button>

                <Empty v-if="!rows.length && !loadingRows" class="flex-none border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><ReceiptText /></EmptyMedia>
                    <EmptyTitle>{{ searching ? 'No sale with that number' : `Nothing rung ${rangeLabel.toLowerCase()}` }}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </div>
            </div>
          </div>

          <!-- ————— the sale ————— -->
          <main class="flex min-w-0 flex-1 flex-col">
            <SalesReceiptCounter v-if="detail" :receipt="detail" />

            <FieldError v-else-if="detailError" class="m-auto">
              {{ detailError }}
            </FieldError>

            <p v-else class="m-auto text-sm text-muted-foreground">
              {{ loadingDetail ? 'Opening…' : 'Pick a sale on the left, or search by its number.' }}
            </p>

            <!--
              The action bar spans the pane and sits at the bottom, so the button is in the
              same place whether a sale has one line or nine — the piece worth taking from
              H3. Both actions hand off to /register/return, which owns the refund composer
              and the manager-approval overlay; nothing about money-back is re-hosted here.
            -->
            <div v-if="detail" class="border-t bg-muted/20 px-4 py-3">
              <div class="ml-auto flex max-w-md gap-3">
                <Button
                  v-if="voidable"
                  variant="outline"
                  class="h-14 flex-1 text-base font-bold"
                  @click="handOff(detail.id)"
                >
                  Void sale…
                </Button>
                <Button
                  v-if="detail.status !== 'VOIDED'"
                  variant="outline"
                  class="h-14 flex-1 text-base font-bold"
                  @click="handOff(detail.id)"
                >
                  Return items…
                </Button>
                <p
                  v-else
                  class="flex-1 self-center text-right text-sm text-muted-foreground"
                >
                  This sale was voided — nothing left to give back.
                </p>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  </div>
</template>
