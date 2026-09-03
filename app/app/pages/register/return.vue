<script setup lang="ts">
import type {
  RefundQuoteResult,
  RefundReceipt,
  SaleReceipt,
  SaleSummaryRow,
} from '@huta/shared/schemas'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatGrams, formatQuantity, parseGramsToBase } from '@huta/shared'
import { ReceiptText, Search, TriangleAlert } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Spinner } from '~/components/ui/spinner'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
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
import { Switch } from '~/components/ui/switch'
import { ApiError, apiFetch } from '~/composables/useApi'
import { SALE_EVENTS, useLiveData } from '~/composables/useLiveData'
import LiveUpdatesNotice from '~/components/LiveUpdatesNotice.vue'
import { useAuthStore } from '~/stores/auth'

/**
 * The return surface: find the sale, pick what comes back, choose how the money leaves.
 *
 * Every dollar figure here is the SERVER's — per-line refund amounts come from
 * /refund-quote (the same math the refund itself runs), never from a client share.
 * Every refund and void ends in the manager-approval overlay; the grant it mints is
 * spent on exactly one operation.
 */
definePageMeta({ layout: 'register' })

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const booted = ref(false)

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')
  booted.value = true
  await loadRecent()

  // The hand-off from /register/history: ?sale=<id> opens that sale straight away, then
  // the query is cleared so a reload is clean. Same shape as the catalog's Ring-it-up
  // hand-off into /register/sale.
  const wanted = route.query['sale']
  if (typeof wanted === 'string') {
    await select(wanted)
    void router.replace({ path: '/register/return' })
  }
})

const fmt = (cents: number) => formatCents(cents as Cents)
const saleNumber = (n: number) => `#${String(n).padStart(4, '0')}`
const timeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const STATUS_BADGE: Record<string, { label: string; class: string }> = {
  VOIDED: { label: 'Voided', class: 'bg-destructive/15 text-destructive' },
  REFUNDED: { label: 'Refunded', class: 'bg-amber-500/15 text-amber-500' },
  PARTIALLY_REFUNDED: { label: 'Partial refund', class: 'bg-amber-500/15 text-amber-500' },
}

/* ————— recent sales (left) ————— */
const term = ref('')
const rows = ref<SaleSummaryRow[]>([])
const loadingRows = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

async function loadRecent(options: { silent?: boolean } = {}) {
  const silent = options.silent === true
  if (!silent) loadingRows.value = true
  try {
    const digits = term.value.trim()
    rows.value = await apiFetch<SaleSummaryRow[]>('/sales/recent', {
      query: { ...(/^\d+$/.test(digits) && digits !== '' ? { number: Number(digits) } : {}) },
    })
  } finally {
    if (!silent) loadingRows.value = false
  }
}

/**
 * Live updates, Kasan's Option B (2026-09-03): **held for rows.**
 *
 * This page is rows only — there is no figure strip to keep live — so everything waits
 * behind the notice. Which is right for the surface: the left list is what someone is
 * picking a sale FROM, and re-ordering it mid-pick is how the wrong sale gets refunded.
 *
 * Deliberately the LIST only. The picked sale on the right is never re-read: a refund being
 * composed here is unsaved work — keyed quantities, restock switches — and a background
 * refetch that replaced `detail` would silently discard it.
 */
const { pending: pendingRows, apply: applyRows } = useLiveData(
  SALE_EVENTS,
  () => loadRecent({ silent: true }),
  { defer: true },
)

watch(term, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadRecent(), 200)
})

/* ————— the picked sale (right) ————— */
const detail = ref<SaleReceipt | null>(null)
const loadingDetail = ref(false)
const pageError = ref<string | null>(null)

/** What staff keyed per sale line: a count (EACH) or grams (WEIGHT), plus restock. */
interface Pick {
  quantity: string
  restock: boolean
}
const picks = ref<Record<string, Pick>>({})

async function select(saleId: string) {
  loadingDetail.value = true
  pageError.value = null
  refundQuote.value = null
  try {
    detail.value = await apiFetch<SaleReceipt>(`/sales/${saleId}`)
    picks.value = Object.fromEntries(
      detail.value.lines.map((l) => [l.id, { quantity: '', restock: true }]),
    )
  } catch (err) {
    pageError.value = err instanceof ApiError ? err.message : 'Could not load that sale.'
  } finally {
    loadingDetail.value = false
  }
}

type ReceiptLine = SaleReceipt['lines'][number]
const remainingOf = (line: ReceiptLine) => line.quantityBase - line.refundedQuantityBase

/** Base units keyed for a line: null = blank, NaN-ish invalid = null + amber border. */
function pickedBase(line: ReceiptLine): number | null {
  const raw = picks.value[line.id]?.quantity.trim() ?? ''
  if (raw === '') return null
  if (line.trackingMode === 'WEIGHT') {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

const pickInvalid = (line: ReceiptLine) => {
  const raw = picks.value[line.id]?.quantity.trim() ?? ''
  if (raw === '') return false
  const base = pickedBase(line)
  return base === null || base > remainingOf(line)
}

function bumpPick(line: ReceiptLine, delta: number) {
  const pick = picks.value[line.id]
  if (!pick) return
  const next = (Number(pick.quantity) || 0) + delta
  const clamped = Math.min(Math.max(next, 0), remainingOf(line))
  pick.quantity = clamped > 0 ? String(clamped) : ''
}

function pickAll(line: ReceiptLine) {
  const pick = picks.value[line.id]
  if (!pick) return
  const remaining = remainingOf(line)
  pick.quantity =
    line.trackingMode === 'WEIGHT'
      ? formatGrams(remaining as BaseQuantity, { suffix: false })
      : String(remaining)
}

const selectedLines = computed(() => {
  if (!detail.value) return []
  return detail.value.lines
    .map((line) => ({ line, base: pickedBase(line), restock: picks.value[line.id]?.restock ?? true }))
    .filter((s): s is { line: ReceiptLine; base: number; restock: boolean } =>
      s.base !== null && s.base <= remainingOf(s.line))
})
const anyInvalid = computed(() => detail.value?.lines.some((l) => pickInvalid(l)) ?? false)

/* refund method — card only offered when a card actually paid */
const method = ref<'CASH' | 'CARD'>('CASH')
const cardPaid = computed(() => detail.value?.payments.some((p) => p.method === 'CARD') ?? false)
const reason = ref('')

/* ————— the server's refund quote: the ONLY source of refund figures ————— */
const refundQuote = ref<RefundQuoteResult | null>(null)
const quotePending = ref(false)
let quoteTimer: ReturnType<typeof setTimeout> | undefined
let quoteSeq = 0

async function requestRefundQuote() {
  const sale = detail.value
  if (!sale || selectedLines.value.length === 0) {
    refundQuote.value = null
    quotePending.value = false
    return
  }
  const seq = ++quoteSeq
  quotePending.value = true
  try {
    const result = await apiFetch<RefundQuoteResult>(`/sales/${sale.id}/refund-quote`, {
      method: 'POST',
      body: { lines: selectedLines.value.map((s) => ({ saleLineId: s.line.id, quantityBase: s.base })) },
    })
    if (seq !== quoteSeq) return
    refundQuote.value = result
  } catch {
    if (seq !== quoteSeq) return
    refundQuote.value = null
  } finally {
    if (seq === quoteSeq) quotePending.value = false
  }
}

watch(
  picks,
  () => {
    clearTimeout(quoteTimer)
    quoteTimer = setTimeout(() => void requestRefundQuote(), 250)
  },
  { deep: true },
)

const quotedByLine = computed(() => {
  const map = new Map<string, number>()
  for (const l of refundQuote.value?.lines ?? []) map.set(l.saleLineId, l.amountCents)
  return map
})

/* ————— approval + execution ————— */
const stepUpOpen = ref(false)
const stepUpAction = ref<'refund' | 'void'>('refund')
const executing = ref(false)
const actionError = ref<string | null>(null)
const result = ref<RefundReceipt | null>(null)

const canRefund = computed(
  () =>
    detail.value !== null &&
    selectedLines.value.length > 0 &&
    !anyInvalid.value &&
    refundQuote.value !== null &&
    !quotePending.value &&
    !executing.value,
)

const stepUpTitle = computed(() => {
  if (stepUpAction.value === 'void' && detail.value) {
    return `Void sale ${saleNumber(detail.value.number)} — ${fmt(detail.value.totalCents)} back`
  }
  const total = refundQuote.value?.totalCents
  return `Refund ${total != null ? fmt(total) : ''} ${method.value === 'CASH' ? 'in cash' : 'to the card'}`
})

function startRefund() {
  if (!canRefund.value) return
  stepUpAction.value = 'refund'
  actionError.value = null
  stepUpOpen.value = true
}

/* void: reason dialog first */
const voidOpen = ref(false)
const voidReason = ref('')

const voidable = computed(
  () =>
    detail.value !== null &&
    detail.value.status === 'COMPLETED' &&
    detail.value.lines.every((l) => l.refundedQuantityBase === 0),
)

function startVoid() {
  voidReason.value = ''
  actionError.value = null
  voidOpen.value = true
}

function voidContinue() {
  if (!voidReason.value.trim()) return
  voidOpen.value = false
  stepUpAction.value = 'void'
  stepUpOpen.value = true
}

async function onApproved(grantId: string) {
  stepUpOpen.value = false
  const sale = detail.value
  if (!sale || executing.value) return
  executing.value = true
  actionError.value = null
  try {
    if (stepUpAction.value === 'void') {
      await apiFetch<SaleReceipt>(`/sales/${sale.id}/void`, {
        method: 'POST',
        body: { reason: voidReason.value.trim(), stepUpGrantId: grantId },
      })
    } else {
      result.value = await apiFetch<RefundReceipt>(`/sales/${sale.id}/refunds`, {
        method: 'POST',
        body: {
          lines: selectedLines.value.map((s) => ({
            saleLineId: s.line.id,
            quantityBase: s.base,
            restock: s.restock,
          })),
          method: method.value,
          ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
          stepUpGrantId: grantId,
        },
      })
      reason.value = ''
    }
    await Promise.all([select(sale.id), loadRecent()])
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    executing.value = false
  }
}

const qtyLabel = (base: number, mode: TrackingMode) => formatQuantity(base as BaseQuantity, mode)
const lineName = (l: { productName: string; variantLabel: string | null }) =>
  l.variantLabel && l.variantLabel !== l.productName
    ? `${l.productName} · ${l.variantLabel}`
    : l.productName
</script>

<template>
  <div class="flex h-dvh flex-col">
    <RegisterBar />

    <div v-if="booted" class="flex min-h-0 flex-1">
      <!-- No rail item claims this page — Return is reached from Sale, but pretending
           we're ON Sale would make aria-current lie. -->
      <RegisterRail active="/register/history" />

      <!-- recent sales -->
      <section class="flex w-[360px] shrink-0 flex-col gap-3 border-r p-4" aria-label="Recent sales">
        <h1 class="text-lg font-extrabold tracking-tight">Return</h1>
        <LiveUpdatesNotice :count="pendingRows" size="touch" @apply="applyRows" />
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <SearchInput
            v-model="term"
            placeholder="Sale number…"
            inputmode="numeric"
            autocomplete="off"
            class="h-11 pl-9"
            aria-label="Find a sale by number"
          />
        </div>
        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div v-if="loadingRows" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true" />
          <Empty v-if="!rows.length && !loadingRows" class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ReceiptText /></EmptyMedia>
              <EmptyTitle>No sales here yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
          <div class="flex flex-col gap-2">
            <button
              v-for="row in rows"
              :key="row.id"
              type="button"
              class="flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors"
              :class="detail?.id === row.id ? 'border-primary/50 bg-primary/8' : 'bg-card hover:bg-accent/40'"
              @click="select(row.id)"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="text-sm font-bold">{{ saleNumber(row.number) }}</span>
                <span class="text-sm font-semibold tabular-nums">{{ fmt(row.totalCents) }}</span>
              </span>
              <span class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{{ timeFmt.format(new Date(row.createdAt)) }} · {{ row.cashierName }}</span>
                <span class="flex gap-1">
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
              </span>
            </button>
          </div>
        </div>
      </section>

      <!-- the picked sale -->
      <main class="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
        <FieldError v-if="pageError">{{ pageError }}</FieldError>
        <p v-else-if="loadingDetail" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />Loading…
        </p>
        <Empty v-else-if="!detail" class="m-auto border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ReceiptText /></EmptyMedia>
            <EmptyTitle>No sale selected</EmptyTitle>
            <EmptyDescription>Pick one on the left, or search by its number.</EmptyDescription>
          </EmptyHeader>
        </Empty>

        <div v-else class="mx-auto flex w-full max-w-xl flex-col gap-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-extrabold tracking-tight">
                Sale {{ saleNumber(detail.number) }}
                <span
                  v-if="STATUS_BADGE[detail.status]"
                  class="ml-1 align-middle rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="STATUS_BADGE[detail.status]!.class"
                >
                  {{ STATUS_BADGE[detail.status]!.label }}
                </span>
              </h2>
              <p class="text-xs text-muted-foreground">
                {{ timeFmt.format(new Date(detail.createdAt)) }} · {{ detail.cashierName }} · {{ fmt(detail.totalCents) }}
              </p>
            </div>
            <button
              v-if="voidable"
              type="button"
              class="shrink-0 rounded-lg border border-destructive/40 px-3 py-1.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10"
              :disabled="executing"
              @click="startVoid"
            >
              Void sale…
            </button>
          </div>

          <div v-if="detail.status === 'VOIDED'" class="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
            <span class="font-bold text-destructive">Voided</span>
            <span class="text-muted-foreground"> — {{ detail.voidReason }}</span>
          </div>

          <!-- line picker -->
          <div class="flex flex-col gap-2">
            <div
              v-for="line in detail.lines"
              :key="line.id"
              class="flex flex-col gap-2 rounded-xl border bg-card p-3"
              :class="remainingOf(line) === 0 ? 'opacity-50' : ''"
            >
              <div class="flex items-baseline justify-between gap-3">
                <span class="min-w-0 flex-1 text-sm font-semibold">{{ lineName(line) }}</span>
                <span class="text-xs text-muted-foreground">
                  sold {{ qtyLabel(line.quantityBase, line.trackingMode) }}
                  <template v-if="line.refundedQuantityBase > 0">
                    · {{ qtyLabel(line.refundedQuantityBase, line.trackingMode) }} back already
                  </template>
                </span>
              </div>

              <div v-if="remainingOf(line) > 0" class="flex flex-wrap items-center gap-2">
                <template v-if="line.trackingMode === 'EACH'">
                  <button
                    type="button"
                    class="flex size-9 items-center justify-center rounded-lg bg-accent hover:bg-accent/70"
                    :aria-label="`One fewer ${lineName(line)}`"
                    @click="bumpPick(line, -1)"
                  >
                    −
                  </button>
                  <Input
                    v-model="picks[line.id]!.quantity"
                    inputmode="numeric"
                    autocomplete="off"
                    class="h-9 w-14 text-center font-semibold tabular-nums"
                    :class="pickInvalid(line) ? 'border-amber-500/60' : ''"
                    :aria-label="`Return quantity of ${lineName(line)}`"
                  />
                  <button
                    type="button"
                    class="flex size-9 items-center justify-center rounded-lg bg-accent hover:bg-accent/70"
                    :aria-label="`One more ${lineName(line)}`"
                    @click="bumpPick(line, 1)"
                  >
                    +
                  </button>
                </template>
                <InputGroup
                  v-else
                  class="h-9 w-24"
                  :class="pickInvalid(line) ? 'border-amber-500/60' : ''"
                >
                  <InputGroupInput
                    v-model="picks[line.id]!.quantity"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="0.0"
                    class="text-right font-semibold tabular-nums"
                    :aria-label="`Grams of ${lineName(line)} to return`"
                  />
                  <InputGroupAddon align="inline-end" class="text-xs">g</InputGroupAddon>
                </InputGroup>
                <button
                  type="button"
                  class="h-9 rounded-lg border px-2.5 text-xs font-semibold text-muted-foreground hover:bg-accent"
                  @click="pickAll(line)"
                >
                  All {{ qtyLabel(remainingOf(line), line.trackingMode) }}
                </button>

                <label class="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  Restock
                  <Switch
                    :model-value="picks[line.id]!.restock"
                    :aria-label="`Restock ${lineName(line)}`"
                    @update:model-value="(v: boolean) => (picks[line.id]!.restock = v)"
                  />
                </label>

                <span class="w-full text-right text-sm font-semibold tabular-nums text-primary">
                  {{ quotedByLine.get(line.id) != null && pickedBase(line) !== null ? `−${fmt(quotedByLine.get(line.id)!)}` : '' }}
                </span>
              </div>
              <p v-else class="text-xs text-muted-foreground">Fully refunded.</p>
            </div>
          </div>

          <!-- refund history -->
          <div v-if="detail.refunds.length" class="rounded-xl border bg-card p-3">
            <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Already given back</h3>
            <div class="flex flex-col gap-1 text-sm">
              <div v-for="r in detail.refunds" :key="r.id" class="flex items-center justify-between gap-3">
                <span class="min-w-0 truncate text-muted-foreground">
                  {{ r.method === 'CASH' ? 'Cash' : 'Card' }} · {{ r.refundedByName }}
                  <template v-if="r.approvedByName"> · approved by {{ r.approvedByName }}</template>
                  <span v-if="r.status === 'FAILED'" class="font-semibold text-destructive"> · FAILED</span>
                </span>
                <span class="shrink-0 tabular-nums">−{{ fmt(r.amountCents) }}</span>
              </div>
            </div>
          </div>

          <!-- refund composer -->
          <div
            v-if="detail.status !== 'VOIDED' && detail.status !== 'REFUNDED'"
            class="flex flex-col gap-2.5 rounded-xl border bg-card p-3"
          >
            <!-- Back to card is refused unless a card actually paid; the reason rides in
                 a title rather than being silently disabled. -->
            <ToggleGroup
              :model-value="method"
              type="single"
              :spacing="2"
              aria-label="Refund method"
              class="w-full"
              @update:model-value="(v) => v && (method = v as typeof method)"
            >
              <ToggleGroupItem
                value="CASH"
                class="h-10 flex-1 rounded-lg border border-input text-sm font-bold text-muted-foreground transition-colors hover:bg-accent data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                Refund cash
              </ToggleGroupItem>
              <ToggleGroupItem
                value="CARD"
                :disabled="!cardPaid"
                :title="cardPaid ? undefined : 'No card paid for this sale'"
                class="h-10 flex-1 rounded-lg border border-input text-sm font-bold text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                Back to card
              </ToggleGroupItem>
            </ToggleGroup>
            <Input v-model="reason" placeholder="Reason (optional)" autocomplete="off" maxlength="200" />
            <div
              class="flex items-center justify-between rounded-lg bg-primary/10 px-3 py-2"
              :class="quotePending ? 'opacity-50' : ''"
            >
              <span class="text-sm font-bold text-primary">Refund</span>
              <span class="text-lg font-extrabold tabular-nums text-primary">
                {{ refundQuote && selectedLines.length ? fmt(refundQuote.totalCents) : '—' }}
              </span>
            </div>
            <FieldError v-if="actionError" class="text-xs">{{ actionError }}</FieldError>
            <Button class="h-12 text-base font-bold" :disabled="!canRefund" @click="startRefund">
              {{ executing ? 'Refunding…' : 'Approve & refund…' }}
            </Button>
          </div>
          <FieldError v-else-if="actionError" class="text-xs">{{ actionError }}</FieldError>
        </div>
      </main>
    </div>

    <!-- refund result -->
    <Dialog :open="result !== null" @update:open="(o: boolean) => !o && (result = null)">
      <DialogContent v-if="result" class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Refunded {{ fmt(result.amountCents) }}</DialogTitle>
          <DialogDescription>
            Sale {{ saleNumber(result.saleNumber) }} · {{ result.method === 'CASH' ? 'cash from the drawer' : 'back to the card' }}
            · approved by {{ result.approvedByName ?? '—' }}
          </DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-1.5 text-sm">
          <div v-for="line in result.lines" :key="line.saleLineId" class="flex justify-between gap-3">
            <span class="min-w-0 flex-1 truncate">
              {{ lineName({ productName: line.productName, variantLabel: line.variantLabel }) }}
              <span class="text-xs text-muted-foreground">
                · {{ qtyLabel(line.quantityBase, line.trackingMode) }}{{ line.restock ? '' : ' · no restock' }}
              </span>
            </span>
            <span class="tabular-nums">−{{ fmt(line.amountCents) }}</span>
          </div>
          <Alert
            v-if="result.status === 'FAILED'"
            variant="destructive"
            class="border-destructive/50 bg-destructive/10"
          >
            <TriangleAlert />
            <AlertTitle>Card refund failed — the money has NOT moved</AlertTitle>
            <AlertDescription>
              The record and any restock stand. An admin can retry it from the back office.
            </AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button class="h-11 w-full text-base font-bold" @click="result = null">Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- void: reason first -->
    <Dialog :open="voidOpen" @update:open="(o: boolean) => !o && (voidOpen = false)">
      <DialogContent class="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Void sale {{ detail ? saleNumber(detail.number) : '' }}</DialogTitle>
          <DialogDescription>
            Everything restocks and the money goes back. Only works while the sale's shift
            is still open — otherwise refund it instead.
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="voidContinue">
          <Field>
            <FieldLabel for="return-void-reason">Reason</FieldLabel>
            <Input id="return-void-reason" v-model="voidReason" autocomplete="off" maxlength="200" autofocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="voidOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!voidReason.trim()">Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <RegisterStepUpDialog
      :open="stepUpOpen"
      :title="stepUpTitle"
      detail="Recorded with who asked and who approved."
      @approved="onApproved"
      @close="stepUpOpen = false"
    />
  </div>
</template>
