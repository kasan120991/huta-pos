<script setup lang="ts">
import { ArrowLeftRight, PackagePlus } from '@lucide/vue'
import type {
  CatalogPage,
  CatalogProduct,
  CatalogReference,
  StockLevelRow,
  TransferAvailabilityRow,
  TransferLineRow,
  TransferRow,
} from '@huta/shared/schemas'
import type { BaseQuantity, TrackingMode } from '@huta/shared'
import { formatGrams, formatQuantity, parseGramsToBase } from '@huta/shared'
import type { Socket } from 'socket.io-client'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs'
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
import { ApiError, apiFetch } from '~/composables/useApi'
import { toast } from 'vue-sonner'
import { useTransfersActionCount } from '~/composables/useTransfersAction'
import { useAuthStore } from '~/stores/auth'

/**
 * Transfers at the register (Kasan's picks: 1A Send/Receive tabs · 2B dialog composer ·
 * 3B "Accept & ship" primary · 4A "Receive all" + adjust-a-line · 7A quiet toast).
 *
 * One store plays both parts, so the tab answers "what do I do": TO SEND is work at
 * this counter (accept, trim, ship), TO RECEIVE is stock on its way here. Accept and
 * ship stay separate SERVER calls — "Accept & ship" chains them, and if the ship half
 * hits an oversell the transfer stays cleanly Accepted with the error saying so.
 * Trimming any line demotes the primary to plain Accept: a trimmed approval deserves
 * the deliberate two-step.
 *
 * Quantities follow house rules: EACH counts are whole numbers, WEIGHT is typed grams
 * parsed as strings (never floats). Cost appears NOWHERE on this page — the in-transit
 * value is an admin fact.
 */
definePageMeta({ layout: 'register' })

const router = useRouter()
const auth = useAuthStore()
const booted = ref(false)
const myStoreId = computed(() => auth.terminal?.store.id ?? '')

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')
  booted.value = true
  await Promise.all([loadTransfers(), loadReference()])
  $socket?.on('transfer.changed', onTransferChanged)
})
onUnmounted(() => $socket?.off('transfer.changed', onTransferChanged))

const { refresh: refreshBadge } = useTransfersActionCount()
const { $socket } = useNuxtApp() as unknown as { $socket: Socket | null }

/* ————— data ————— */
const transfers = ref<TransferRow[]>([])
const loading = ref(false)

async function loadTransfers() {
  loading.value = true
  try {
    const data = await apiFetch<{ transfers: TransferRow[] }>('/transfers')
    transfers.value = data.transfers
  } finally {
    loading.value = false
  }
  void refreshBadge()
}

const stores = ref<Array<{ id: string, name: string }>>([])
async function loadReference() {
  try {
    const reference = await apiFetch<CatalogReference>('/catalog/reference')
    stores.value = [...reference.stores]
  } catch {
    stores.value = []
  }
}

/* ————— tabs (1A): send = we are the source, receive = we asked ————— */
const tab = ref<'send' | 'receive'>('send')

const sendRows = computed(() => transfers.value.filter((t) => t.sourceStoreId === myStoreId.value))
const receiveRows = computed(() =>
  transfers.value.filter((t) => t.requestingStoreId === myStoreId.value),
)

const needsAction = (t: TransferRow) =>
  (t.sourceStoreId === myStoreId.value && (t.status === 'PENDING' || t.status === 'ACCEPTED'))
  || (t.requestingStoreId === myStoreId.value && t.status === 'IN_TRANSIT')

/** Actionable first, then newest — the list is a queue before it is a history. */
const byUrgency = (rows: TransferRow[]) =>
  [...rows].sort((a, b) => Number(needsAction(b)) - Number(needsAction(a)))

const visible = computed(() => byUrgency(tab.value === 'send' ? sendRows.value : receiveRows.value))
const sendCount = computed(() => sendRows.value.filter(needsAction).length)
const receiveCount = computed(() => receiveRows.value.filter(needsAction).length)

/**
 * Live work and the archive are two different lists that happened to share a container.
 * Driving the screen, five of seven rows were finished transfers, so the badge said 2 and
 * you scrolled past an archive to reach them. Sorting actionable-first was not enough —
 * a closed transfer is not low-priority work, it is not work.
 */
const CLOSED = new Set(['RECEIVED', 'DECLINED', 'CANCELLED'])
const liveRows = computed(() => visible.value.filter((t) => !CLOSED.has(t.status)))
const doneRows = computed(() => visible.value.filter((t) => CLOSED.has(t.status)))

/**
 * What is actually IN the transfer, for the queue row.
 *
 * With two stores every row's title is the same store name, so the heading distinguishes
 * nothing; the contents are the only thing that tells one row from another at a glance.
 * The strain (the variant label) leads, because on a flower line "Blue Dream" is the name
 * staff use and "Regular Flower" is the shelf it sits on.
 */
function contents(row: TransferRow): string {
  const parts = row.lines.slice(0, 2).map((l) => {
    // On flower the VARIANT is the identity — "Blue Dream", not "Regular Flower". On a
    // packaged good the product is, and its label is a size: "50mg / 2 ct" names nothing.
    const name = l.trackingMode === 'WEIGHT' ? (l.label ?? l.productName) : l.productName
    return `${qty(l.approvedBase ?? l.requestedBase, l.trackingMode)} ${name}`
  })
  const rest = row.lines.length - parts.length
  return rest > 0 ? `${parts.join(', ')} +${rest} more` : parts.join(', ')
}

/* ————— selection ————— */
const selectedId = ref<string | null>(null)
const selected = computed(() => transfers.value.find((t) => t.id === selectedId.value) ?? null)

watch(visible, (list) => {
  // Live work wins the default selection: landing on an archived transfer when something
  // needs doing puts the wrong screen in front of whoever just walked up.
  if (!list.some((t) => t.id === selectedId.value)) {
    selectedId.value = liveRows.value[0]?.id ?? list[0]?.id ?? null
  }
})

function setTab(next: 'send' | 'receive') {
  tab.value = next
  actionError.value = null
}

/* ————— display helpers ————— */
const timeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const when = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '')

const lineName = (line: TransferLineRow) =>
  line.label && line.label !== line.productName
    ? `${line.productName} · ${line.label}`
    : line.productName

const qty = (base: number, mode: TrackingMode) => formatQuantity(base as BaseQuantity, mode)

const otherStoreName = (t: TransferRow) =>
  t.sourceStoreId === myStoreId.value ? t.requestingStoreName : t.sourceStoreName

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
}
const STATUS_CLASS: Record<string, string> = {
  PENDING: 'bg-amber-500/15 text-amber-500',
  ACCEPTED: 'bg-primary/10 text-primary',
  IN_TRANSIT: 'bg-sky-400/10 text-sky-400',
  RECEIVED: 'bg-accent text-muted-foreground',
  DECLINED: 'bg-red-400/10 text-red-400',
  CANCELLED: 'bg-accent text-muted-foreground',
}

/* ————— accept (3B): approve inputs prefilled with requested ————— */
const approvals = ref<Record<string, string>>({})

watch(selected, (t) => {
  actionError.value = null
  adjusting.value = false
  if (t && t.status === 'PENDING' && t.sourceStoreId === myStoreId.value) {
    approvals.value = Object.fromEntries(
      t.lines.map((l) => [
        l.id,
        l.trackingMode === 'WEIGHT'
          ? formatGrams(l.requestedBase as BaseQuantity, { suffix: false })
          : String(l.requestedBase),
      ]),
    )
  } else {
    approvals.value = {}
  }
  if (t && t.status === 'IN_TRANSIT' && t.requestingStoreId === myStoreId.value) {
    counts.value = Object.fromEntries(
      t.lines
        .filter((l) => (l.approvedBase ?? 0) > 0)
        .map((l) => [
          l.id,
          l.trackingMode === 'WEIGHT'
            ? formatGrams((l.approvedBase ?? 0) as BaseQuantity, { suffix: false })
            : String(l.approvedBase ?? 0),
        ]),
    )
  } else {
    counts.value = {}
  }
})

/* ————— what is actually on the shelf HERE (the T1 sheet's spine) —————
 *
 * The request composer shows the OTHER store's availability while you ask. The store being
 * asked to give the stock up — where the decision is genuinely made — had none, so accepting
 * 28g of a strain with 20g in the jar succeeded and the oversell surfaced at SHIP, after the
 * accept had already committed. One batched read per opened transfer, source-store scoped,
 * with no cost key in it by construction.
 *
 * Only fetched when THIS store is the source and the transfer can still move: on a received
 * or declined transfer today's shelf count is a live number wearing an archive's clothes.
 */
const onHandByVariant = ref<Record<string, number> | null>(null)
const onHandFailed = ref(false)

async function loadAvailability(t: TransferRow | null) {
  onHandByVariant.value = null
  onHandFailed.value = false
  if (!t) return
  const fulfilling = t.sourceStoreId === myStoreId.value
  if (!fulfilling || (t.status !== 'PENDING' && t.status !== 'ACCEPTED')) return
  try {
    const data = await apiFetch<{ availability: TransferAvailabilityRow[] }>(
      `/transfers/${t.id}/availability`,
    )
    // Guard against a slow answer for a transfer the cashier has already moved off.
    if (selectedId.value !== t.id) return
    onHandByVariant.value = Object.fromEntries(
      data.availability.map((a) => [a.variantId, a.quantityBase]),
    )
  } catch {
    // A hint, never a blocker — the accept still works, it just goes in blind, and the
    // sheet says "couldn't check" rather than a lying "none here".
    if (selectedId.value === t.id) onHandFailed.value = true
  }
}

watch(selected, (t) => void loadAvailability(t))
/** Refetch after any action commits — a ship changes the very numbers this column shows. */
watch(transfers, () => void loadAvailability(selected.value))

const onHand = (line: TransferLineRow): number | null =>
  onHandByVariant.value?.[line.variantId] ?? null

/** Base units for what is going out on this line, whichever leg is being worked. */
function sendingBase(line: TransferLineRow): number | null {
  if (selected.value?.status === 'PENDING') return approvedOf(line)
  return line.approvedBase
}

/** What the shelf holds after this transfer ships. Null while availability is unknown. */
function leaves(line: TransferLineRow): number | null {
  const have = onHand(line)
  const going = sendingBase(line)
  if (have === null || going === null) return null
  return have - going
}

/** Asking for more than is on the shelf — the case that used to fail only at ship time. */
const overShelf = (line: TransferLineRow) => {
  const left = leaves(line)
  return left !== null && left < 0
}
const anyOverShelf = computed(() => selected.value?.lines.some(overShelf) ?? false)

const trimmedLines = computed(
  () =>
    selected.value?.lines.filter((l) => approvedOf(l) !== null && approvedOf(l) !== l.requestedBase)
      .length ?? 0,
)

/** Base units keyed for a line, or null when the input is unparseable. Zero is legal. */
function keyedBase(raw: string | undefined, mode: TrackingMode): number | null {
  const s = (raw ?? '').trim()
  if (s === '') return null
  if (mode === 'WEIGHT') {
    const parsed = parseGramsToBase(s)
    return parsed.ok && parsed.value >= 0 ? parsed.value : null
  }
  return /^\d+$/.test(s) ? Number(s) : null
}

const approvedOf = (line: TransferLineRow) => keyedBase(approvals.value[line.id], line.trackingMode)

const approveInvalid = (line: TransferLineRow) => {
  const base = approvedOf(line)
  return base === null || base > line.requestedBase
}

const anyApproveInvalid = computed(() => selected.value?.lines.some(approveInvalid) ?? false)
const trimmed = computed(
  () => selected.value?.lines.some((l) => approvedOf(l) !== null && approvedOf(l) !== l.requestedBase) ?? false,
)
const allZero = computed(
  () => selected.value?.lines.every((l) => approvedOf(l) === 0) ?? false,
)

function acceptBody(t: TransferRow) {
  return {
    lines: t.lines.map((l) => ({ lineId: l.id, approvedBase: approvedOf(l) ?? l.requestedBase })),
  }
}

/* ————— receive (4A): one tap, adjust only when something is missing ————— */
const adjusting = ref(false)
const counts = ref<Record<string, string>>({})

const countOf = (line: TransferLineRow) => keyedBase(counts.value[line.id], line.trackingMode)
const countInvalid = (line: TransferLineRow) => {
  const base = countOf(line)
  return base === null || base > (line.approvedBase ?? 0)
}
const anyCountInvalid = computed(
  () =>
    selected.value?.lines.filter((l) => (l.approvedBase ?? 0) > 0).some(countInvalid) ?? false,
)
const anyShort = computed(
  () =>
    selected.value?.lines.some(
      (l) => (l.approvedBase ?? 0) > 0 && countOf(l) !== null && countOf(l)! < (l.approvedBase ?? 0),
    ) ?? false,
)

/** Exactly the states with something to press. Anything else renders no footer at all. */
const hasFooter = computed(() => {
  const t = selected.value
  if (!t) return false
  if (tab.value === 'send') return t.status === 'PENDING' || t.status === 'ACCEPTED'
  return t.status === 'IN_TRANSIT' || t.status === 'PENDING' || t.status === 'ACCEPTED'
})

/* ————— sheet column templates —————
 *
 * Named here rather than inlined so the header row and every body row are laid out by the
 * SAME string — the deliveries count sheet's rule, learned when a header and its rows drifted
 * a column apart.
 */
const fulfilColumns = 'grid-cols-[minmax(0,1fr)_120px_110px_150px_120px]'
const shipColumns = 'grid-cols-[minmax(0,1fr)_120px_140px_120px]'
const receiveColumns = 'grid-cols-[minmax(0,1fr)_130px_150px]'
/**
 * Four columns only once there is a received figure to put in one. A transfer still in
 * transit was reserving 130px and a blank header for a column that could not have content.
 */
const recordColumns = computed(() =>
  selected.value?.status === 'RECEIVED'
    ? 'grid-cols-[minmax(0,1fr)_120px_120px_130px]'
    : 'grid-cols-[minmax(0,1fr)_120px_120px]',
)

/* ————— actions ————— */
const busy = ref(false)
const actionError = ref<string | null>(null)

async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  actionError.value = null
  try {
    await fn()
    await loadTransfers()
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
    await loadTransfers()
  } finally {
    busy.value = false
  }
}

function acceptOnly() {
  const t = selected.value
  if (!t || anyApproveInvalid.value || allZero.value) return
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/accept`, { method: 'POST', body: acceptBody(t) })
  })
}

function acceptAndShip() {
  const t = selected.value
  if (!t || anyApproveInvalid.value || allZero.value || trimmed.value) return
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/accept`, { method: 'POST', body: acceptBody(t) })
    try {
      await apiFetch(`/transfers/${t.id}/ship`, { method: 'POST', body: {} })
    } catch (err) {
      // The accept committed — the transfer is cleanly Accepted, only the ship failed
      // (usually an oversell). Say exactly that instead of a generic error.
      const reason = err instanceof ApiError ? err.message : 'something went wrong'
      throw new ApiError({
        status: 409,
        code: 'CONFLICT',
        message: `Accepted, but couldn't ship: ${reason}`,
      })
    }
  })
}

function ship() {
  const t = selected.value
  if (!t) return
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/ship`, { method: 'POST', body: {} })
  })
}

function receiveAll() {
  const t = selected.value
  if (!t) return
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/receive`, { method: 'POST', body: {} })
  })
}

function confirmReceipt() {
  const t = selected.value
  if (!t || anyCountInvalid.value) return
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/receive`, {
      method: 'POST',
      body: {
        lines: t.lines
          .filter((l) => (l.approvedBase ?? 0) > 0)
          .map((l) => ({ lineId: l.id, receivedBase: countOf(l) ?? l.approvedBase ?? 0 })),
      },
    })
    adjusting.value = false
  })
}

/* decline: the reason is required — the requester reads it */
const declineOpen = ref(false)
const declineReason = ref('')

function startDecline() {
  declineReason.value = ''
  declineOpen.value = true
}

function confirmDecline() {
  const t = selected.value
  if (!t || !declineReason.value.trim()) return
  declineOpen.value = false
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/decline`, {
      method: 'POST',
      body: { reason: declineReason.value.trim() },
    })
  })
}

/* cancel: requester's exit before the goods move */
const cancelOpen = ref(false)
const cancelReason = ref('')

function startCancel() {
  cancelReason.value = ''
  cancelOpen.value = true
}

function confirmCancel() {
  const t = selected.value
  if (!t) return
  cancelOpen.value = false
  void run(async () => {
    await apiFetch(`/transfers/${t.id}/cancel`, {
      method: 'POST',
      body: cancelReason.value.trim() ? { reason: cancelReason.value.trim() } : {},
    })
  })
}

/* ————— the request composer (2B: a dialog) ————— */
interface ComposeLine {
  variantId: string
  name: string
  sku: string
  trackingMode: TrackingMode
  qty: string
  /**
   * The full cross-store picture, so changing the source re-reads availability.
   * Null = still fetching; an EMPTY array is a real answer (no stock rows anywhere).
   */
  levels: StockLevelRow[] | null
  /** The lookup errored — say "couldn't check", never a lying "none there". */
  levelsFailed?: boolean
}

const composeOpen = ref(false)
const cSourceId = ref('')
const cNote = ref('')
const cLines = ref<ComposeLine[]>([])
const cError = ref<string | null>(null)
const sending = ref(false)

const otherStores = computed(() => stores.value.filter((s) => s.id !== myStoreId.value))

function startCompose() {
  cSourceId.value = otherStores.value[0]?.id ?? ''
  cNote.value = ''
  cLines.value = []
  cError.value = null
  term.value = ''
  results.value = []
  composeOpen.value = true
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
        query: { search: q, page: 1, pageSize: 8 },
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

async function addComposeLine(hit: { variantId: string, name: string, sku: string, trackingMode: TrackingMode }) {
  term.value = ''
  results.value = []
  if (cLines.value.some((l) => l.variantId === hit.variantId)) return
  // A request's count starts at one; grams are keyed — the PO composer's rule, for the
  // same reason: this is what's being ASKED for, not a count of what arrived.
  cLines.value.push({
    ...hit,
    qty: hit.trackingMode === 'EACH' ? '1' : '',
    levels: null,
  })
  // Write through the ARRAY, not the local object: push wraps the element in a reactive
  // proxy, and mutating the raw original never triggers a re-render — the availability
  // line would sit on "checking…" until some other interaction repainted it.
  const stored = cLines.value.find((l) => l.variantId === hit.variantId)
  try {
    const data = await apiFetch<{ levels: StockLevelRow[] }>(`/inventory/levels/${hit.variantId}`)
    if (stored) stored.levels = data.levels
  } catch {
    // Availability is a hint; the request can still be sent without it.
    if (stored) stored.levelsFailed = true
  }
}

function removeComposeLine(variantId: string) {
  cLines.value = cLines.value.filter((l) => l.variantId !== variantId)
}

function availabilityAtSource(line: ComposeLine): number | null {
  if (line.levels === null) return null
  return line.levels.find((l) => l.storeId === cSourceId.value)?.quantityBase ?? 0
}

function bumpCompose(line: ComposeLine, delta: number) {
  const next = (Number(line.qty) || 0) + delta
  line.qty = next > 0 ? String(next) : '1'
}

const composeLineBase = (line: ComposeLine): number | null => {
  const base = keyedBase(line.qty, line.trackingMode)
  return base !== null && base > 0 ? base : null
}

const composeValid = computed(
  () =>
    cSourceId.value !== ''
    && cLines.value.length >= 1
    && cLines.value.every((l) => composeLineBase(l) !== null),
)

async function sendRequest() {
  if (!composeValid.value || sending.value) return
  sending.value = true
  cError.value = null
  try {
    const created = await apiFetch<TransferRow>('/transfers', {
      method: 'POST',
      body: {
        sourceStoreId: cSourceId.value,
        // Explicit for an admin covering the counter — their principal has no home store.
        requestingStoreId: myStoreId.value,
        ...(cNote.value.trim() ? { note: cNote.value.trim() } : {}),
        lines: cLines.value.map((l) => ({ variantId: l.variantId, quantityBase: composeLineBase(l)! })),
      },
    })
    composeOpen.value = false
    await loadTransfers()
    tab.value = 'receive'
    selectedId.value = created.id
  } catch (err) {
    cError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    sending.value = false
  }
}

/* ————— the live nudge (7A: quiet corner toast) ————— */

function onTransferChanged(payload: {
  transferId: string
  status: string
  requestingStoreId: string
  sourceStoreId: string
}) {
  const mine = payload.requestingStoreId === myStoreId.value || payload.sourceStoreId === myStoreId.value
  if (!mine) return
  // The socket fires whether or not this session can still read — a register whose
  // access token lapsed mid-shift (the known token-refresh gap) must not spray
  // unhandled rejections; the next signed-in action refetches anyway.
  void loadTransfers().catch(() => {}).then(() => {
    const row = transfers.value.find((t) => t.id === payload.transferId)
    if (!row) return
    // Only events that need THIS store's hands get a toast; everything else just refetched.
    if (payload.status === 'PENDING' && payload.sourceStoreId === myStoreId.value) {
      showToast(`${row.requestingStoreName} requests stock`, `${row.lines.length} line${row.lines.length === 1 ? '' : 's'}`, row.id, 'send')
    } else if (payload.status === 'IN_TRANSIT' && payload.requestingStoreId === myStoreId.value) {
      showToast(`On its way from ${row.sourceStoreName}`, 'Receive it when it arrives', row.id, 'receive')
    }
  })
}

/**
 * Sonner, mounted once in `layouts/register.vue`.
 *
 * PERSISTS UNTIL DISMISSED (Kasan, 2026-08-22) — `duration: Infinity` on the Toaster.
 * A request that arrives while nobody is looking at the screen is the whole case for
 * the toast existing, and the old 6s window meant the counter missed it and found out
 * later from the badge.
 *
 * Sonner is also what makes persistence SAFE. The hand-rolled version had one slot, so
 * a second request replaced the first and that nudge vanished unseen — a bug that only
 * grew teeth once toasts stopped expiring. These STACK instead.
 *
 * The transfer id is the toast id, so the same transfer changing twice updates its
 * existing toast rather than adding a duplicate.
 */
function showToast(title: string, sub: string, transferId: string, which: 'send' | 'receive') {
  toast(title, {
    id: transferId,
    description: sub,
    action: {
      label: 'View',
      onClick: () => {
        tab.value = which
        selectedId.value = transferId
      },
    },
  })
}
</script>

<template>
  <div class="flex h-dvh flex-col">
    <RegisterBar />

    <div v-if="booted" class="flex min-h-0 flex-1">
      <RegisterRail active="/register/transfers" />

      <!-- the queue -->
      <section class="flex w-[360px] shrink-0 flex-col gap-3 border-r p-4" aria-label="Transfers">
        <div class="flex items-center justify-between gap-2">
          <h1 class="text-lg font-extrabold tracking-tight">Transfers</h1>
          <Button size="sm" class="h-9 font-bold" @click="startCompose">＋ Request stock</Button>
        </div>

        <!--
          The panel below is driven by `tab` with v-if rather than TabsContent — one store
          plays both parts and the queue, the selection and the sheet all key off it, so the
          content is not a simple per-tab slot. Tabs still owns the strip's roving focus.
        -->
        <Tabs
          :model-value="tab"
          class="w-full"
          @update:model-value="(v) => setTab(v as 'send' | 'receive')"
        >
          <!--
            ⚠ `group-data-horizontal/tabs:h-auto`, not a bare `h-auto`: tabsListVariants
            carries `group-data-horizontal/tabs:h-8`, and a MODIFIED utility beats an
            unmodified one, so the list stayed 32px while these 40px triggers spilled 4px
            out of it top and bottom. Same shape as SelectTrigger's data-[size=default]:h-8.
          -->
          <TabsList class="h-auto w-full gap-1 rounded-xl border bg-card p-1 group-data-horizontal/tabs:h-auto">
            <TabsTrigger
              value="send"
              class="h-10 flex-1 gap-1.5 rounded-lg text-sm font-bold text-muted-foreground data-active:bg-accent data-active:text-foreground"
            >
              To send
              <span
                v-if="sendCount"
                class="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-black"
              >{{ sendCount }}</span>
            </TabsTrigger>
            <TabsTrigger
              value="receive"
              class="h-10 flex-1 gap-1.5 rounded-lg text-sm font-bold text-muted-foreground data-active:bg-accent data-active:text-foreground"
            >
              To receive
              <span
                v-if="receiveCount"
                class="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-black"
              >{{ receiveCount }}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div v-if="loading" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true" />
          <Empty v-if="!visible.length && !loading" class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ArrowLeftRight /></EmptyMedia>
              <EmptyTitle>{{ tab === 'send' ? 'No requests to fill' : 'Nothing requested yet' }}</EmptyTitle>
            </EmptyHeader>
          </Empty>

          <div class="flex flex-col gap-2">
            <!--
              Live work first, then the archive behind a divider. The contents line is what
              tells one row from another: with two stores every heading is the same store
              name, so the title alone distinguishes nothing.
            -->
            <button
              v-for="row in liveRows"
              :key="row.id"
              type="button"
              class="flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors"
              :class="[
                selectedId === row.id ? 'border-primary/50 bg-primary/8' : 'bg-card hover:bg-accent/40',
                needsAction(row) ? 'border-l-[3px] border-l-amber-500' : '',
              ]"
              @click="selectedId = row.id"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="text-sm font-bold">{{ otherStoreName(row) }}</span>
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="STATUS_CLASS[row.status]"
                >
                  {{ STATUS_LABEL[row.status] }}
                </span>
              </span>
              <span class="text-xs text-foreground/80">{{ contents(row) }}</span>
              <span class="text-[11px] text-muted-foreground">
                {{ row.requestedByName }} · {{ when(row.createdAt) }}
              </span>
            </button>

            <template v-if="doneRows.length">
              <p class="mt-2 px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Finished · {{ doneRows.length }}
              </p>
              <button
                v-for="row in doneRows"
                :key="row.id"
                type="button"
                class="flex flex-col gap-0.5 rounded-xl border p-3 text-left opacity-60 transition-opacity hover:opacity-100"
                :class="selectedId === row.id ? 'border-primary/50 bg-primary/8 opacity-100' : 'bg-card'"
                @click="selectedId = row.id"
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="text-sm font-semibold text-muted-foreground">{{ otherStoreName(row) }}</span>
                  <span
                    class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    :class="STATUS_CLASS[row.status]"
                  >
                    {{ STATUS_LABEL[row.status] }}
                  </span>
                </span>
                <span class="text-xs text-muted-foreground">{{ contents(row) }} · {{ when(row.createdAt) }}</span>
              </button>
            </template>
          </div>
        </div>
      </section>

      <!-- the picked transfer: header · sheet · pinned footer (Kasan's T1 pick) -->
      <main class="flex min-w-0 flex-1 flex-col">
        <p
          v-if="!selected"
          class="m-auto max-w-xs rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground"
        >
          {{ tab === 'send'
            ? 'When the other store asks for stock, it lands here.'
            : 'Request stock with the button above — the other store fills it.' }}
        </p>

        <template v-else>
          <!-- ————— header ————— -->
          <div class="border-b px-5 py-3">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 class="text-xl font-extrabold tracking-tight">
                <template v-if="tab === 'send'">{{ selected.requestingStoreName }} asks for stock</template>
                <template v-else>From {{ selected.sourceStoreName }}</template>
                <span
                  class="ml-1.5 align-middle rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="STATUS_CLASS[selected.status]"
                >
                  {{ STATUS_LABEL[selected.status] }}
                </span>
              </h2>
              <p class="text-xs text-muted-foreground">
                {{ selected.requestedByName }} · {{ when(selected.createdAt) }}
                <template v-if="selected.acceptedByName"> · accepted {{ selected.acceptedByName }}</template>
                <template v-if="selected.shippedByName"> · shipped {{ selected.shippedByName }}</template>
                <template v-if="selected.receivedByName"> · received {{ selected.receivedByName }}</template>
              </p>
            </div>
            <p v-if="selected.note" class="mt-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
              {{ selected.note }}
            </p>
            <p
              v-if="selected.reason"
              class="mt-2 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm"
            >
              <b class="text-red-400">{{ selected.status === 'DECLINED' ? 'Declined' : 'Cancelled' }}</b>
              <span class="text-muted-foreground"> — {{ selected.reason }}</span>
            </p>
          </div>

          <!-- ————— the sheet ————— -->
          <!--
            Capped and left-aligned rather than filling the pane: at 1480px the item name and
            its on-hand figure end up ~900px apart, which is the row-scanning problem the
            deliveries count sheet was rebuilt to avoid in the first place.
          -->
          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div class="max-w-5xl">
            <!-- SEND · PENDING: fill it, against what is actually on the shelf -->
            <template v-if="tab === 'send' && selected.status === 'PENDING'">
              <div
                class="grid items-center gap-3 border-b pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
                :class="fulfilColumns"
              >
                <span>Item</span>
                <span class="text-right">On hand here</span>
                <span class="text-right">Asked for</span>
                <span class="text-right">Sending</span>
                <span class="text-right">Leaves us</span>
              </div>
              <div
                v-for="line in selected.lines"
                :key="line.id"
                class="grid items-center gap-3 border-b py-3"
                :class="[fulfilColumns, overShelf(line) ? 'bg-red-400/[0.07]' : '']"
              >
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold">{{ lineName(line) }}</span>
                  <span class="font-mono text-[11px] text-muted-foreground">{{ line.sku }}</span>
                </span>
                <span class="text-right text-sm tabular-nums">
                  <template v-if="onHandFailed">
                    <span class="text-xs text-muted-foreground">couldn&apos;t check</span>
                  </template>
                  <template v-else-if="onHand(line) === null">
                    <span class="text-xs text-muted-foreground">…</span>
                  </template>
                  <template v-else-if="onHand(line) === 0">
                    <span class="font-semibold text-amber-500">none here</span>
                  </template>
                  <template v-else>{{ qty(onHand(line)!, line.trackingMode) }}</template>
                </span>
                <span class="text-right text-sm tabular-nums text-muted-foreground">
                  {{ qty(line.requestedBase, line.trackingMode) }}
                </span>
                <span class="flex flex-col items-end gap-1">
                  <!-- h-11 on the GROUP: it owns the border, so a 44px touch target set on
                       the inner control would collapse to the group's default 32px. -->
                  <InputGroup
                    class="h-11 w-[130px]"
                    :class="approveInvalid(line) || overShelf(line)
                      ? 'border-red-400/70'
                      : approvedOf(line) !== null && approvedOf(line) !== line.requestedBase
                        ? 'border-amber-500/70 text-amber-500'
                        : ''"
                  >
                    <InputGroupInput
                      v-model="approvals[line.id]"
                      :inputmode="line.trackingMode === 'WEIGHT' ? 'decimal' : 'numeric'"
                      autocomplete="off"
                      class="text-right text-base font-bold tabular-nums"
                      :aria-label="`Send quantity of ${lineName(line)}`"
                    />
                    <InputGroupAddon
                      v-if="line.trackingMode === 'WEIGHT'"
                      align="inline-end"
                      class="text-xs"
                    >g</InputGroupAddon>
                  </InputGroup>
                  <!--
                    The silent state made loud: an untouched line says nothing, a trimmed one
                    says exactly how much it lost. Keyed ABOVE the request is its own case —
                    subtracting there produced "trimmed −−572.00g", a double negative for a
                    figure that was never a trim.
                  -->
                  <span
                    v-if="approvedOf(line) !== null && approvedOf(line)! > line.requestedBase"
                    class="text-[11px] font-semibold text-red-400"
                  >
                    more than asked for
                  </span>
                  <span
                    v-else-if="approvedOf(line) !== null && approvedOf(line) !== line.requestedBase"
                    class="text-[11px] font-semibold text-amber-500"
                  >
                    {{ approvedOf(line) === 0
                      ? 'skipped'
                      : `trimmed −${qty(line.requestedBase - approvedOf(line)!, line.trackingMode)}` }}
                  </span>
                </span>
                <span class="text-right text-sm tabular-nums">
                  <template v-if="leaves(line) === null"><span class="text-muted-foreground">—</span></template>
                  <template v-else-if="leaves(line)! < 0">
                    <span class="font-semibold text-red-400">
                      {{ qty(-leaves(line)!, line.trackingMode) }} short
                    </span>
                  </template>
                  <template v-else>{{ qty(leaves(line)!, line.trackingMode) }}</template>
                </span>
              </div>

              <p
                v-if="anyOverShelf"
                class="mt-3 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-medium text-red-400"
              >
                More than is on the shelf here. Trim those lines to what you actually have —
                shipping would be refused anyway, and only after the accept had gone through.
              </p>
              <p v-else class="mt-3 text-xs text-muted-foreground">
                Trim a line to send less; zero it to skip it. More than was asked for won&apos;t go.
              </p>
            </template>

            <!-- SEND · ACCEPTED: what is about to leave -->
            <template v-else-if="tab === 'send' && selected.status === 'ACCEPTED'">
              <div
                class="grid items-center gap-3 border-b pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
                :class="shipColumns"
              >
                <span>Item</span>
                <span class="text-right">On hand here</span>
                <span class="text-right">Sending</span>
                <span class="text-right">Leaves us</span>
              </div>
              <div
                v-for="line in selected.lines"
                :key="line.id"
                class="grid items-center gap-3 border-b py-3"
                :class="[shipColumns, (line.approvedBase ?? 0) === 0 ? 'opacity-50' : '']"
              >
                <span class="min-w-0 truncate text-sm font-semibold">{{ lineName(line) }}</span>
                <span class="text-right text-sm tabular-nums">
                  <template v-if="onHand(line) === null"><span class="text-muted-foreground">—</span></template>
                  <template v-else>{{ qty(onHand(line)!, line.trackingMode) }}</template>
                </span>
                <span class="text-right text-base font-bold tabular-nums">
                  {{ (line.approvedBase ?? 0) > 0 ? qty(line.approvedBase!, line.trackingMode) : 'skipped' }}
                </span>
                <span class="text-right text-sm tabular-nums">
                  <template v-if="leaves(line) === null"><span class="text-muted-foreground">—</span></template>
                  <template v-else-if="leaves(line)! < 0">
                    <span class="font-semibold text-red-400">
                      {{ qty(-leaves(line)!, line.trackingMode) }} short
                    </span>
                  </template>
                  <template v-else>{{ qty(leaves(line)!, line.trackingMode) }}</template>
                </span>
              </div>
              <p
                v-if="anyOverShelf"
                class="mt-3 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-medium text-red-400"
              >
                The shelf has moved since this was accepted — shipping will be refused until
                there is enough on hand.
              </p>
              <p v-else class="mt-3 text-xs text-muted-foreground">
                Shipping takes the stock out of this store — it belongs to nobody until
                {{ selected.requestingStoreName }} receives it.
              </p>
            </template>

            <!-- RECEIVE · IN_TRANSIT: count it in -->
            <template v-else-if="tab === 'receive' && selected.status === 'IN_TRANSIT'">
              <div
                class="grid items-center gap-3 border-b pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
                :class="receiveColumns"
              >
                <span>Item</span>
                <span class="text-right">Shipped</span>
                <span class="text-right">{{ adjusting ? 'Counted' : 'Receiving' }}</span>
              </div>
              <div
                v-for="line in selected.lines.filter((l) => (l.approvedBase ?? 0) > 0)"
                :key="line.id"
                class="grid items-center gap-3 border-b py-3"
                :class="receiveColumns"
              >
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold">{{ lineName(line) }}</span>
                  <span class="font-mono text-[11px] text-muted-foreground">{{ line.sku }}</span>
                </span>
                <span class="text-right text-sm tabular-nums text-muted-foreground">
                  {{ qty(line.approvedBase!, line.trackingMode) }}
                </span>
                <span v-if="adjusting" class="flex flex-col items-end gap-1">
                  <InputGroup
                    class="h-11 w-[130px]"
                    :class="countInvalid(line)
                      ? 'border-red-400/70'
                      : countOf(line) !== null && countOf(line)! < (line.approvedBase ?? 0)
                        ? 'border-amber-500/70 text-amber-500'
                        : ''"
                  >
                    <InputGroupInput
                      v-model="counts[line.id]"
                      :inputmode="line.trackingMode === 'WEIGHT' ? 'decimal' : 'numeric'"
                      autocomplete="off"
                      class="text-right text-base font-bold tabular-nums"
                      :aria-label="`Received quantity of ${lineName(line)}`"
                    />
                    <InputGroupAddon
                      v-if="line.trackingMode === 'WEIGHT'"
                      align="inline-end"
                      class="text-xs"
                    >g</InputGroupAddon>
                  </InputGroup>
                  <span
                    v-if="countOf(line) !== null && countOf(line)! < (line.approvedBase ?? 0)"
                    class="text-[11px] font-semibold text-amber-500"
                  >
                    {{ qty((line.approvedBase ?? 0) - countOf(line)!, line.trackingMode) }} short
                  </span>
                </span>
                <span v-else class="text-right text-base font-bold tabular-nums">
                  {{ qty(line.approvedBase!, line.trackingMode) }}
                </span>
              </div>
              <p v-if="adjusting && anyShort" class="mt-3 text-xs font-medium text-amber-500">
                Anything short is recorded on this transfer — the missing amount is not
                restocked anywhere.
              </p>
              <p v-else class="mt-3 text-xs text-muted-foreground">
                Counts default to what was shipped — this is our own ship record, not a
                supplier&apos;s word. Adjust a line only if the box disagrees with it.
              </p>
            </template>

            <!-- everything else: the record -->
            <template v-else>
              <div
                class="grid items-center gap-3 border-b pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
                :class="recordColumns"
              >
                <span>Item</span>
                <span class="text-right">Asked for</span>
                <span class="text-right">{{ selected.status === 'RECEIVED' ? 'Sent' : 'Approved' }}</span>
                <span v-if="selected.status === 'RECEIVED'" class="text-right">Received</span>
              </div>
              <div
                v-for="line in selected.lines"
                :key="line.id"
                class="grid items-center gap-3 border-b py-3"
                :class="recordColumns"
              >
                <span class="min-w-0 truncate text-sm font-semibold">{{ lineName(line) }}</span>
                <span class="text-right text-sm tabular-nums text-muted-foreground">
                  {{ qty(line.requestedBase, line.trackingMode) }}
                </span>
                <span class="text-right text-sm tabular-nums">
                  <template v-if="line.approvedBase === null"><span class="text-muted-foreground">—</span></template>
                  <template v-else-if="line.approvedBase === 0"><span class="text-muted-foreground">skipped</span></template>
                  <template v-else>{{ qty(line.approvedBase, line.trackingMode) }}</template>
                </span>
                <span v-if="selected.status === 'RECEIVED'" class="text-right text-sm tabular-nums">
                  {{ qty(line.receivedBase ?? 0, line.trackingMode) }}
                  <span
                    v-if="(line.receivedBase ?? 0) < (line.approvedBase ?? 0)"
                    class="block text-xs font-semibold text-amber-500"
                  >
                    {{ qty((line.approvedBase ?? 0) - (line.receivedBase ?? 0), line.trackingMode) }} short
                  </span>
                </span>
              </div>

              <p
                v-if="tab === 'receive' && (selected.status === 'PENDING' || selected.status === 'ACCEPTED')"
                class="mt-3 text-xs text-muted-foreground"
              >
                Waiting on {{ selected.sourceStoreName }} —
                {{ selected.status === 'PENDING' ? 'they haven\'t answered yet.' : 'accepted, not yet shipped.' }}
              </p>
              <p
                v-else-if="tab === 'send' && selected.status === 'IN_TRANSIT'"
                class="mt-3 text-xs text-muted-foreground"
              >
                On its way — {{ selected.requestingStoreName }} confirms when it arrives.
              </p>
            </template>
            </div>
          </div>

          <!--
            The footer: one place the decision always lives — and NOTHING when there is no
            decision. A bar reading "nothing left to do" under a transfer that is actively in
            transit contradicts the sheet above it, which already says where the stock is.
          -->
          <div v-if="hasFooter" class="border-t bg-muted/20 px-5 py-3">
            <div class="max-w-5xl">
            <FieldError v-if="actionError" class="mb-2">{{ actionError }}</FieldError>

            <!-- SEND · PENDING -->
            <div v-if="tab === 'send' && selected.status === 'PENDING'" class="flex items-center gap-3">
              <button
                type="button"
                class="rounded-lg border border-destructive/40 px-4 py-2.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10"
                :disabled="busy"
                @click="startDecline"
              >
                Decline…
              </button>
              <span class="flex-1" />
              <p v-if="allZero" class="text-xs text-amber-500">
                Every line is zero — decline instead, so the reason travels back.
              </p>
              <span v-else-if="trimmedLines" class="text-xs font-medium text-amber-500">
                {{ trimmedLines }} line{{ trimmedLines === 1 ? '' : 's' }} trimmed
              </span>
              <Button
                v-if="!trimmed"
                variant="outline"
                class="h-14 px-5 text-base font-bold"
                :disabled="busy || anyApproveInvalid || allZero || anyOverShelf"
                @click="acceptOnly"
              >
                Accept only
              </Button>
              <Button
                class="h-14 px-7 text-base font-bold"
                :disabled="busy || anyApproveInvalid || allZero || anyOverShelf"
                @click="trimmed ? acceptOnly() : acceptAndShip()"
              >
                {{ busy ? 'Working…' : trimmed ? 'Accept' : 'Accept & ship' }}
              </Button>
            </div>

            <!-- SEND · ACCEPTED -->
            <div v-else-if="tab === 'send' && selected.status === 'ACCEPTED'" class="flex items-center gap-3">
              <span class="flex-1" />
              <Button class="h-14 px-7 text-base font-bold" :disabled="busy" @click="ship">
                {{ busy ? 'Shipping…' : `Mark shipped to ${selected.requestingStoreName}` }}
              </Button>
            </div>

            <!-- RECEIVE · IN_TRANSIT -->
            <div v-else-if="tab === 'receive' && selected.status === 'IN_TRANSIT'" class="flex items-center gap-3">
              <Button
                variant="ghost"
                class="text-muted-foreground"
                :disabled="busy"
                @click="adjusting = !adjusting"
              >
                {{ adjusting ? 'Back' : 'Count a line…' }}
              </Button>
              <span class="flex-1" />
              <Button
                v-if="!adjusting"
                class="h-14 px-7 text-base font-bold"
                :disabled="busy"
                @click="receiveAll"
              >
                {{ busy ? 'Receiving…' : 'Receive all' }}
              </Button>
              <Button
                v-else
                class="h-14 px-7 text-base font-bold"
                :disabled="busy || anyCountInvalid"
                @click="confirmReceipt"
              >
                {{ busy ? 'Receiving…' : 'Confirm receipt' }}
              </Button>
            </div>

            <!-- RECEIVE · waiting: the requester's exit -->
            <div
              v-else-if="tab === 'receive' && (selected.status === 'PENDING' || selected.status === 'ACCEPTED')"
              class="flex items-center"
            >
              <button
                type="button"
                class="rounded-lg border border-destructive/40 px-4 py-2.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10"
                :disabled="busy"
                @click="startCancel"
              >
                Cancel request…
              </button>
            </div>

            </div>
          </div>
        </template>
      </main>
    </div>

    <!-- 2B: the request composer -->
    <Dialog :open="composeOpen" @update:open="(o: boolean) => !o && (composeOpen = false)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request stock</DialogTitle>
          <DialogDescription>
            The other store accepts and ships; you confirm when it arrives.
          </DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-3">
          <div v-if="otherStores.length > 1">
            <span class="mb-1 block text-xs font-medium">From</span>
            <Select v-model="cSourceId">
              <SelectTrigger class="data-[size=default]:h-10 w-full" aria-label="Source store"><SelectValue placeholder="Pick a store" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="store in otherStores" :key="store.id" :value="store.id">{{ store.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p v-else-if="otherStores.length === 1" class="text-sm text-muted-foreground">
            From <b class="text-foreground">{{ otherStores[0]!.name }}</b>
          </p>

          <div class="relative">
            <SearchInput
              v-model="term"
              placeholder="Search products or scan…"
              autocomplete="off"
              aria-label="Search products to request"
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
                @click="addComposeLine(hit)"
              >
                <span class="min-w-0 flex-1 truncate font-medium">{{ hit.name }}</span>
                <span class="font-mono text-xs text-muted-foreground">{{ hit.sku }}</span>
              </button>
            </div>
          </div>

          <div v-if="cLines.length" class="flex flex-col gap-2">
            <div
              v-for="line in cLines"
              :key="line.variantId"
              class="flex items-center gap-2 rounded-xl border bg-card p-2.5"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold">{{ line.name }}</span>
                <span
                  class="text-xs"
                  :class="availabilityAtSource(line) === 0 ? 'font-medium text-amber-500'
                    : availabilityAtSource(line) === null ? 'text-muted-foreground' : 'text-sky-400'"
                >
                  <template v-if="line.levelsFailed">couldn't check availability</template>
                  <template v-else-if="availabilityAtSource(line) === null">checking availability…</template>
                  <template v-else-if="availabilityAtSource(line) === 0">none on hand there</template>
                  <template v-else>
                    they have {{ qty(availabilityAtSource(line)!, line.trackingMode) }}
                  </template>
                </span>
              </span>
              <template v-if="line.trackingMode === 'EACH'">
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-lg bg-accent hover:bg-accent/70"
                  :aria-label="`One fewer ${line.name}`"
                  @click="bumpCompose(line, -1)"
                >−</button>
                <Input
                  v-model="line.qty"
                  inputmode="numeric"
                  autocomplete="off"
                  class="h-9 w-14 text-center font-semibold tabular-nums"
                  :class="composeLineBase(line) === null ? 'border-red-400/60' : ''"
                  :aria-label="`Quantity of ${line.name}`"
                />
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-lg bg-accent hover:bg-accent/70"
                  :aria-label="`One more ${line.name}`"
                  @click="bumpCompose(line, 1)"
                >＋</button>
              </template>
              <InputGroup
                v-else
                class="h-9 w-24"
                :class="composeLineBase(line) === null && line.qty.trim() !== '' ? 'border-red-400/60' : ''"
              >
                <InputGroupInput
                  v-model="line.qty"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="0.0"
                  class="text-right font-semibold tabular-nums"
                  :aria-label="`Grams of ${line.name}`"
                />
                <InputGroupAddon align="inline-end" class="text-xs">g</InputGroupAddon>
              </InputGroup>
              <button
                type="button"
                class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                :aria-label="`Remove ${line.name}`"
                @click="removeComposeLine(line.variantId)"
              >✕</button>
            </div>
          </div>
          <Empty v-else class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><PackagePlus /></EmptyMedia>
              <EmptyTitle>Nothing added yet</EmptyTitle>
              <EmptyDescription>Search above to add what this store needs.</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <Input v-model="cNote" placeholder="Note (optional)" autocomplete="off" maxlength="500" />
          <FieldError v-if="cError">{{ cError }}</FieldError>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="composeOpen = false">Cancel</Button>
          <Button class="font-bold" :disabled="!composeValid || sending" @click="sendRequest">
            {{ sending ? 'Sending…' : 'Send request' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- decline: reason required -->
    <Dialog :open="declineOpen" @update:open="(o: boolean) => !o && (declineOpen = false)">
      <DialogContent class="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Decline this request</DialogTitle>
          <DialogDescription>
            {{ selected?.requestingStoreName }} sees the reason — say why so they don't just ask again.
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="confirmDecline">
          <Field>
            <FieldLabel for="transfer-decline-reason">Reason</FieldLabel>
            <Input id="transfer-decline-reason" v-model="declineReason" autocomplete="off" maxlength="500" autofocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="declineOpen = false">Back</Button>
            <Button type="submit" variant="destructive" :disabled="!declineReason.trim()">Decline</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- cancel: the requester's exit -->
    <Dialog :open="cancelOpen" @update:open="(o: boolean) => !o && (cancelOpen = false)">
      <DialogContent class="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Cancel this request?</DialogTitle>
          <DialogDescription>
            It closes for good — ask again with a fresh request if you still need the stock.
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="confirmCancel">
          <Field>
            <FieldLabel for="transfer-cancel-reason">
              Reason <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="transfer-cancel-reason" v-model="cancelReason" autocomplete="off" maxlength="500" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="cancelOpen = false">Keep it</Button>
            <Button type="submit" variant="destructive">Cancel request</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
