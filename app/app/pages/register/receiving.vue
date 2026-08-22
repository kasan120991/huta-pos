<script setup lang="ts">
import type {
  CatalogPage,
  CatalogProduct,
  CatalogReference,
  CatalogVariant,
  OpenOrderRow,
  ReceiptRow,
  SupplierRow,
} from '@huta/shared/schemas'
import type { BaseQuantity, TrackingMode } from '@huta/shared'
import { formatQuantity, parseGramsToBase } from '@huta/shared'
import { Minus, Plus, ScanLine, Search, X } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
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
import { useAuthStore } from '~/stores/auth'

/**
 * Take a delivery — scan-and-stack.
 *
 * The register surface, not the back office: staff receive quantities only. Cost appears
 * nowhere on this screen and is never sent — the server refuses it from a staff principal
 * outright rather than ignoring it, so a delivery posts uncosted and an admin prices it
 * afterward from /admin/receiving (unless it rides a PO, whose lines carry the cost).
 *
 * The scan bar holds focus and reclaims it after every action, so a barcode scanner —
 * which is just a keyboard — works without anyone tapping into a field first. A window-
 * level fallback catches keystrokes even when focus was lost.
 */
definePageMeta({ layout: 'register' })

const router = useRouter()
const auth = useAuthStore()

interface Line {
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly sku: string
  readonly trackingMode: TrackingMode
  /** Typed grams for WEIGHT, a whole count for EACH. Kept as a string — never a float. */
  quantity: string
  /** Set when the line came off an order: what it still expects. A hint, never a prefill. */
  readonly outstandingBase?: number
}

const suppliers = ref<SupplierRow[]>([])
const supplierId = ref('')
const invoiceNumber = ref('')
const lines = ref<Line[]>([])

const term = ref('')
const results = ref<CatalogProduct[]>([])
const searching = ref(false)
const posting = ref(false)
const error = ref<string | null>(null)
const posted = ref<ReceiptRow | null>(null)

const searchInput = ref<{ focus: () => void } | null>(null)

function focusSearch() {
  void nextTick(() => searchInput.value?.focus())
}

/* ————— guard ————— */
onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')

  const data = await apiFetch<{ suppliers: SupplierRow[] }>('/suppliers')
  suppliers.value = data.suppliers
  await loadOpenOrders()
  focusSearch()
})

/* ————— receiving against an order ————— */
const openOrders = ref<OpenOrderRow[]>([])
const order = ref<OpenOrderRow | null>(null)
/** The chooser shows until a choice is made — and only when there is something to choose. */
const chose = ref(false)
const showChooser = computed(() => !chose.value && openOrders.value.length > 0)

async function loadOpenOrders() {
  try {
    const open = await apiFetch<{ orders: OpenOrderRow[] }>('/receiving/open-orders', {
      query: { storeId: auth.terminal?.store.id },
    })
    openOrders.value = open.orders
  } catch {
    // The chooser is a convenience — a walk-in delivery must not break on its failure.
    openOrders.value = []
  }
}

function chooseWalkIn() {
  chose.value = true
  focusSearch()
}

function chooseOrder(picked: OpenOrderRow) {
  order.value = picked
  supplierId.value = picked.supplierId
  // Pre-stack what is still outstanding, quantities BLANK: the count entered must be what
  // actually arrived, not what the paperwork says. The expected figure rides as a hint.
  lines.value = picked.lines
    .filter((line) => line.outstandingBase > 0)
    .map((line) => ({
      variantId: line.variantId,
      productName: line.productName,
      label: line.label,
      sku: line.sku,
      trackingMode: line.trackingMode as TrackingMode,
      quantity: '',
      outstandingBase: line.outstandingBase,
    }))
  chose.value = true
  focusSearch()
}

/** Drop the link but keep the stack — what is on the counter is on the counter. */
function unlinkOrder() {
  order.value = null
}

function outstandingLabel(line: Line): string | null {
  if (line.outstandingBase === undefined) return null
  return `${formatQuantity(line.outstandingBase as BaseQuantity, line.trackingMode)} outstanding`
}

const orderDateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const orderDate = (iso: string) => orderDateFmt.format(new Date(iso))
const outstandingCount = (o: OpenOrderRow) => o.lines.filter((l) => l.outstandingBase > 0).length

/* ————— search / scan ————— */
async function runSearch() {
  const q = term.value.trim()
  if (q.length < 2) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const page = await apiFetch<CatalogPage>('/catalog/products', {
      query: { search: q, page: 1, pageSize: 20 },
    })
    results.value = page.products as CatalogProduct[]

    // A scan yields exactly one variant. Adding it straight away is the whole point of a
    // scanner — pausing to confirm a unique barcode match would defeat it.
    const only = soleVariant(page.products as CatalogProduct[])
    if (only && looksScanned(q)) {
      addVariant(only.product, only.variant)
      term.value = ''
      results.value = []
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not search the catalog.'
  } finally {
    searching.value = false
  }
}

/** A barcode is long and all digits; a human searching types words. */
const looksScanned = (q: string) => /^\d{6,}$/.test(q)

/* ————— camera scanning (CONTINUOUS: staff walk the box, cancel when it's empty) ————— */
const scannerOpen = ref(false)
const scannerFeedback = ref<{ seq: number, text: string } | null>(null)
let feedbackSeq = 0

function toastScanner(text: string) {
  scannerFeedback.value = { seq: ++feedbackSeq, text }
}

async function onCameraScanned(code: string) {
  try {
    const page = await apiFetch<CatalogPage>('/catalog/products', {
      query: { search: code, page: 1, pageSize: 20 },
    })
    const only = soleVariant(page.products as CatalogProduct[])
    if (!only) {
      toastScanner(page.products.length ? 'Several matches — search by name' : 'No match in the catalog')
      return
    }
    addVariant(only.product, only.variant)
    const line = lines.value.find((l) => l.variantId === only.variant.id)
    toastScanner(
      only.variant.trackingMode === 'EACH'
        ? `✓ ${variantName(only.product, only.variant)} ×${line?.quantity || 1}`
        : `✓ ${variantName(only.product, only.variant)} — key the grams`,
    )
  } catch {
    toastScanner('Could not search the catalog')
  }
}

function soleVariant(products: readonly CatalogProduct[]) {
  const flat = products.flatMap((p) => p.variants.map((v) => ({ product: p, variant: v })))
  return flat.length === 1 ? flat[0]! : null
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(term, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void runSearch(), 180)
})

/**
 * Window-level fallback: if a keystroke lands while nothing is focused (someone tapped
 * the backdrop), send it to the scan bar so a scanner never fires into the void.
 */
function onWindowKeydown(event: KeyboardEvent) {
  if (posted.value || showChooser.value || quickOpen.value) return
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    term.value += event.key
    focusSearch()
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))

/* ————— the stack ————— */
function addVariant(product: CatalogProduct, variant: CatalogVariant) {
  error.value = null
  const existing = lines.value.find((l) => l.variantId === variant.id)
  if (existing) {
    // A second scan of the same item bumps the count rather than stacking a duplicate row.
    if (existing.trackingMode === 'EACH') {
      existing.quantity = String((Number(existing.quantity) || 0) + 1)
    }
    focusSearch()
    return
  }
  lines.value.push({
    variantId: variant.id,
    productName: product.name,
    label: variant.label,
    sku: variant.sku,
    trackingMode: variant.trackingMode,
    quantity: variant.trackingMode === 'EACH' ? '1' : '',
  })
  term.value = ''
  results.value = []
  focusSearch()
}

function removeLine(variantId: string) {
  lines.value = lines.value.filter((l) => l.variantId !== variantId)
  focusSearch()
}

function bump(line: Line, delta: number) {
  const next = (Number(line.quantity) || 0) + delta
  line.quantity = next > 0 ? String(next) : ''
}

/** Base units for one line, or null when what was typed is not usable yet. */
function baseOf(line: Line): number | null {
  const raw = line.quantity.trim()
  if (raw === '') return null
  if (line.trackingMode === 'WEIGHT') {
    // Parsed from the digits of the string. `3.53 * 1000` is 3530.0000000000005.
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

const ready = computed(
  () => lines.value.length > 0 && lines.value.every((l) => baseOf(l) !== null),
)
const emptyCount = computed(() => lines.value.filter((l) => baseOf(l) === null).length)

/**
 * The sheet's columns, data-driven (Kasan's D3 pick, 2026-08-21).
 *
 * Expected appears ONLY when receiving against an order. On a walk-in there is nothing to
 * expect — most deliveries here are walk-ins, and a permanently empty column would be dead
 * weight on the common case to serve the rare one.
 */
const sheetColumns = computed(() =>
  order.value
    ? 'minmax(0,1fr) 110px 200px 44px'
    : 'minmax(0,1fr) 200px 44px',
)

/**
 * How the count compares to what the order still expects — visible WHILE typing rather than
 * discovered after posting.
 *
 * Only meaningful against an order line. An over-delivery flags immediately (the server
 * treats it as a variance); a short one is normal while an order is open, so it is stated
 * plainly rather than coloured as a problem.
 */
function variance(line: Line): { label: string, over: boolean } | null {
  if (line.outstandingBase === undefined) return null
  const counted = baseOf(line)
  if (counted === null) return null
  const diff = counted - line.outstandingBase
  if (diff === 0) return null
  const size = formatQuantity(Math.abs(diff) as BaseQuantity, line.trackingMode)
  return { label: diff > 0 ? `${size} over` : `${size} short`, over: diff > 0 }
}

/** Counted separately: "18 units and 14g" is the only honest summary across both modes. */
const summary = computed(() => {
  let units = 0
  let weightBase = 0
  for (const line of lines.value) {
    const base = baseOf(line)
    if (base === null) continue
    if (line.trackingMode === 'WEIGHT') weightBase += base
    else units += base
  }
  const parts: string[] = []
  if (units > 0) parts.push(`${units} ${units === 1 ? 'unit' : 'units'}`)
  if (weightBase > 0) parts.push(formatQuantity(weightBase as BaseQuantity, 'WEIGHT'))
  return parts.join(' + ') || 'nothing yet'
})

/* ————— quick-product: the 7a endpoint finally gets its button ————— */
const quickOpen = ref(false)
const quickName = ref('')
const quickCategoryId = ref('')
const quickSku = ref('')
const quickBarcode = ref('')
const quickSaving = ref(false)
const quickError = ref<string | null>(null)
const reference = ref<CatalogReference | null>(null)

const leafCategories = computed(() => {
  const cats = reference.value?.categories ?? []
  const hasChildren = new Set(cats.filter((c) => c.parentId !== null).map((c) => c.parentId))
  const byId = new Map(cats.map((c) => [c.id, c]))
  return cats
    .filter((c) => !hasChildren.has(c.id))
    .map((c) => ({ id: c.id, label: c.parentId ? `${byId.get(c.parentId)?.name} › ${c.name}` : c.name }))
})

async function openQuick() {
  quickOpen.value = true
  quickName.value = ''
  quickCategoryId.value = ''
  quickSku.value = ''
  quickBarcode.value = ''
  quickError.value = null
  if (!reference.value) {
    reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  }
}

async function quickCreate() {
  if (!quickName.value.trim() || !quickCategoryId.value || !quickSku.value.trim() || quickSaving.value) return
  quickSaving.value = true
  quickError.value = null
  try {
    const created = await apiFetch<{ productId: string, name: string, variantId: string, sku: string }>(
      '/receiving/quick-product',
      {
        method: 'POST',
        body: {
          name: quickName.value.trim(),
          categoryId: quickCategoryId.value,
          sku: quickSku.value.trim(),
          ...(quickBarcode.value.trim() ? { barcode: quickBarcode.value.trim() } : {}),
        },
      },
    )
    lines.value.push({
      variantId: created.variantId,
      productName: created.name,
      label: null,
      sku: created.sku,
      trackingMode: 'EACH',
      quantity: '1',
    })
    quickOpen.value = false
    focusSearch()
  } catch (err) {
    quickError.value = err instanceof ApiError ? err.message : 'Something went wrong. Try again.'
  } finally {
    quickSaving.value = false
  }
}

/* ————— post ————— */
async function post() {
  if (!ready.value || posting.value) return
  posting.value = true
  error.value = null
  try {
    const receipt = await apiFetch<ReceiptRow>('/receiving/receipts', {
      method: 'POST',
      body: {
        // The terminal's own store. Staff would be scoped server-side anyway; an ADMIN
        // covering the counter has no store on their principal, so without this the
        // server rightly refuses with "a store must be specified".
        ...(auth.terminal ? { storeId: auth.terminal.store.id } : {}),
        ...(order.value ? { purchaseOrderId: order.value.id } : {}),
        ...(supplierId.value ? { supplierId: supplierId.value } : {}),
        ...(invoiceNumber.value.trim() ? { invoiceNumber: invoiceNumber.value.trim() } : {}),
        lines: lines.value.map((l) => ({ variantId: l.variantId, quantityBase: baseOf(l)! })),
      },
    })
    posted.value = receipt
    lines.value = []
    invoiceNumber.value = ''
    term.value = ''
    results.value = []
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not post that delivery.'
  } finally {
    posting.value = false
  }
}

function startAnother() {
  posted.value = null
  order.value = null
  supplierId.value = ''
  chose.value = false
  // The order just received may now be closed — the chooser must not offer it again.
  void loadOpenOrders()
  focusSearch()
}

const lineName = (l: Line) => (l.label && l.label !== l.productName ? `${l.productName} · ${l.label}` : l.productName)
const variantName = (p: CatalogProduct, v: CatalogVariant) =>
  v.label && v.label !== p.name ? `${p.name} · ${v.label}` : p.name
</script>

<template>
  <div class="flex flex-1 flex-col">
    <RegisterBar>
      <span class="text-xs">
        {{ order ? 'Cost comes from the order.' : 'Cost is entered by an admin later.' }}
      </span>
    </RegisterBar>

    <div class="flex min-h-0 flex-1">
    <RegisterRail active="/register/receiving" />
    <div class="flex min-w-0 flex-1 flex-col">
    <!--
      The delivery's own facts — who it is from, its invoice, which order it answers — sit
      in the header. They used to share the footer with the count and the Post button, which
      put the field that matters most for costing in the smallest control on the screen.
    -->
    <div class="flex flex-wrap items-center gap-3 px-5 py-2">
      <div class="min-w-0">
        <h1 class="text-lg font-bold tracking-tight">Take a delivery</h1>
        <p v-if="order" class="text-xs text-muted-foreground">
          Against
          <span class="font-mono font-semibold text-primary">{{ order.reference }}</span>
          · {{ order.supplierName }} · supplier locked ·
          <button
            type="button"
            class="underline underline-offset-2 hover:text-foreground"
            @click="unlinkOrder"
          >
            Unlink
          </button>
        </p>
      </div>

      <div v-if="!posted && !showChooser" class="ml-auto flex items-center gap-2">
        <span
          v-if="order"
          class="inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm text-muted-foreground"
        >
          {{ order.supplierName }} 🔒
        </span>
        <Select v-else v-model="supplierId">
          <!--
            `data-[size=default]:h-10`, not `h-10`: SelectTrigger's own base carries
            `data-[size=default]:h-8`, and an attribute selector outranks a plain utility —
            so a bare h-10 loses and the select renders 8px shorter than the invoice box
            beside it.
          -->
          <SelectTrigger class="data-[size=default]:h-10 w-40" aria-label="Supplier">
            <SelectValue placeholder="Supplier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">
              {{ supplier.name }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          v-model="invoiceNumber"
          placeholder="Invoice #"
          autocomplete="off"
          class="h-10 w-36"
          aria-label="Invoice number"
        />
      </div>
    </div>

    <!-- posted confirmation -->
    <section v-if="posted" class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div class="flex size-16 items-center justify-center rounded-full bg-primary text-2xl text-primary-foreground" aria-hidden="true">✓</div>
      <h2 class="text-2xl font-bold tracking-tight">Delivery posted</h2>
      <p class="max-w-md text-muted-foreground">
        {{ posted.lines.length }} {{ posted.lines.length === 1 ? 'line' : 'lines' }} received into
        {{ posted.storeName }}<template v-if="posted.supplierName"> from {{ posted.supplierName }}</template><template v-if="posted.purchaseOrderReference"> against {{ posted.purchaseOrderReference }}</template>.
        Stock is updated.
      </p>
      <div class="mt-2 flex gap-3">
        <Button size="lg" class="h-12 px-6 text-base" @click="startAnother">Take another delivery</Button>
        <Button size="lg" variant="outline" class="h-12 px-6 text-base" @click="router.push('/register')">
          Back to register
        </Button>
      </div>
    </section>

    <!-- step 1: against an order? Only when open orders exist. -->
    <section v-else-if="showChooser" class="flex flex-1 flex-col items-center gap-5 px-8 pt-8">
      <h2 class="text-xl font-bold tracking-tight">Is this delivery against an order?</h2>
      <div class="flex w-full max-w-lg flex-col gap-3">
        <button
          v-for="o in openOrders"
          :key="o.id"
          type="button"
          class="flex flex-col gap-1 rounded-2xl border bg-card p-4 text-left transition-colors hover:bg-accent/40"
          @click="chooseOrder(o)"
        >
          <span class="flex items-center gap-2.5">
            <span class="font-mono text-sm font-semibold text-primary">{{ o.reference }}</span>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              :class="o.status === 'PARTIALLY_RECEIVED' ? 'bg-amber-500/10 text-amber-500' : 'bg-primary/10 text-primary'"
            >
              {{ o.status === 'PARTIALLY_RECEIVED' ? 'Part received' : 'Ordered' }}
            </span>
            <span class="ml-auto text-xs text-muted-foreground">
              {{ outstandingCount(o) }} {{ outstandingCount(o) === 1 ? 'line' : 'lines' }} outstanding
            </span>
          </span>
          <span class="text-sm text-muted-foreground">
            {{ o.supplierName }} · ordered {{ orderDate(o.orderedAt) }}<template v-if="o.expectedAt"> · expected {{ orderDate(o.expectedAt) }}</template>
          </span>
        </button>
        <button
          type="button"
          class="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          @click="chooseWalkIn"
        >
          No order — walk-in or sample delivery
        </button>
      </div>
    </section>

    <!-- the working screen -->
    <section v-else class="flex min-h-0 flex-1 flex-col">
      <div class="relative px-5 pt-1">
        <div class="relative">
          <Search class="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-primary" />
          <SearchInput
            ref="searchInput"
            v-model="term"
            scanner
            placeholder="Scan a barcode or search the catalog…"
            autocomplete="off"
            spellcheck="false"
            class="h-12 border-primary/60 pl-10 text-base shadow-[0_0_0_3px_rgba(34,197,94,0.10)]"
            aria-label="Scan or search"
            @scan="scannerOpen = !scannerOpen"
          />
          <RegisterCameraScanner
            :open="scannerOpen"
            :feedback="scannerFeedback"
            @scanned="onCameraScanned"
            @close="scannerOpen = false"
          />
        </div>
        <div
          v-if="results.length && term.trim().length >= 2"
          class="absolute inset-x-5 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-xl"
        >
          <template v-for="product in results" :key="product.id">
            <button
              v-for="variant in product.variants"
              :key="variant.id"
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-accent"
              @click="addVariant(product, variant)"
            >
              <span class="min-w-0 flex-1 truncate font-medium">{{ variantName(product, variant) }}</span>
              <span class="font-mono text-xs text-muted-foreground">{{ variant.sku }}</span>
              <span class="text-xs text-muted-foreground">{{ variant.trackingMode === 'WEIGHT' ? 'weight' : 'each' }}</span>
            </button>
          </template>
        </div>
      </div>


      <!--
        The count sheet. Every figure sits in ONE vertical track so the eye runs straight
        down the counts instead of crossing the screen once per item, and an uncounted line
        is tinted and says so — blank-on-open is deliberate (an expected figure must never be
        rubber-stamped) but it used to look identical to a counted one, which is the way a
        wrong delivery gets posted.
      -->
      <div class="mt-2 min-h-0 flex-1 overflow-y-auto px-5 pb-2">
        <Empty v-if="!lines.length" class="flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ScanLine /></EmptyMedia>
            <EmptyTitle>Nothing counted yet</EmptyTitle>
            <EmptyDescription>Scan the first item — or search it by name.</EmptyDescription>
          </EmptyHeader>
        </Empty>

        <div v-else class="overflow-hidden rounded-2xl border bg-card">
          <div
            class="grid gap-3 border-b px-4 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
            :style="{ gridTemplateColumns: sheetColumns }"
          >
            <span>Item</span>
            <span v-if="order" class="text-right">Expected</span>
            <span class="text-center">Counted</span>
            <span><span class="sr-only">Remove</span></span>
          </div>

          <div
            v-for="line in lines"
            :key="line.variantId"
            class="grid items-center gap-3 border-b px-4 py-2 last:border-b-0"
            :class="baseOf(line) === null ? 'bg-amber-500/[0.07]' : ''"
            :style="{ gridTemplateColumns: sheetColumns }"
          >
            <div class="min-w-0">
              <div class="truncate text-[15px] font-semibold">{{ lineName(line) }}</div>
              <div class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span class="font-mono">{{ line.sku }}</span>
                <span v-if="baseOf(line) === null" class="font-semibold text-amber-500">
                  Not counted
                </span>
                <span
                  v-else-if="variance(line)"
                  class="font-semibold"
                  :class="variance(line)!.over ? 'text-amber-500' : 'text-muted-foreground'"
                >
                  {{ variance(line)!.label }}
                </span>
              </div>
            </div>

            <!-- What the order still expects. Absent entirely on a walk-in. -->
            <span v-if="order" class="text-right text-sm tabular-nums text-muted-foreground">
              <template v-if="line.outstandingBase !== undefined">
                {{ formatQuantity(line.outstandingBase as BaseQuantity, line.trackingMode) }}
              </template>
              <template v-else>—</template>
            </span>

            <div class="flex items-center justify-center gap-2">
              <template v-if="line.trackingMode === 'EACH'">
                <button
                  type="button"
                  class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-lg hover:bg-accent/70"
                  :aria-label="`One fewer ${lineName(line)}`"
                  @click="bump(line, -1)"
                >
                  <Minus class="size-4" />
                </button>
                <Input
                  v-model="line.quantity"
                  inputmode="numeric"
                  autocomplete="off"
                  class="h-11 w-16 text-center text-lg font-semibold tabular-nums"
                  :class="baseOf(line) !== null ? 'border-primary/45' : 'border-amber-500/50'"
                  :aria-label="`Quantity of ${lineName(line)}`"
                />
                <button
                  type="button"
                  class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-lg hover:bg-accent/70"
                  :aria-label="`One more ${lineName(line)}`"
                  @click="bump(line, 1)"
                >
                  <Plus class="size-4" />
                </button>
              </template>
              <!-- h-11 stays a 44px touch target: it goes on the GROUP, which owns the border. -->
              <InputGroup
                v-else
                class="h-11 w-full"
                :class="baseOf(line) !== null ? 'border-primary/45' : 'border-amber-500/50'"
              >
                <InputGroupInput
                  v-model="line.quantity"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="grams"
                  class="text-right text-lg font-semibold tabular-nums"
                  :aria-label="`Grams of ${lineName(line)}`"
                />
                <InputGroupAddon align="inline-end">g</InputGroupAddon>
              </InputGroup>
            </div>

            <button
              type="button"
              class="flex size-9 items-center justify-center justify-self-end rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              :aria-label="`Remove ${lineName(line)}`"
              @click="removeLine(line.variantId)"
            >
              <X class="size-4" />
            </button>
          </div>
        </div>

        <Button variant="outline" class="mt-3 h-10" @click="openQuick">
          ＋ Not in the catalog?
        </Button>
      </div>

      <FieldError v-if="error" class="px-5 pb-1">{{ error }}</FieldError>

      <!--
        The footer does ONE job now: say what has been counted and post it. Supplier, invoice
        and the quick-product escape hatch moved out — they are facts and actions, not the
        gate. Post stays disabled until every line carries a figure.
      -->
      <div class="flex flex-wrap items-center gap-3 border-t bg-card px-5 py-3">
        <span class="text-sm text-muted-foreground">
          Counted: <span class="font-semibold text-foreground">{{ summary }}</span>
        </span>
        <span
          v-if="emptyCount > 0"
          class="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-500"
        >
          {{ emptyCount }} {{ emptyCount === 1 ? 'line' : 'lines' }} still to count
        </span>
        <Button
          size="lg"
          class="ml-auto h-12 px-6 text-base font-bold"
          :disabled="!ready || posting"
          @click="post"
        >
          {{ posting ? 'Posting…' : 'Post delivery' }}
        </Button>
      </div>
    </section>
    </div>
    </div>

    <!-- quick-product -->
    <Dialog :open="quickOpen" @update:open="(o: boolean) => !o && (quickOpen = false)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to the catalog</DialogTitle>
          <DialogDescription>
            For an item that isn't in the system yet. It arrives
            <span class="font-medium text-foreground">inactive and unpriced</span> — stock posts now,
            an admin prices and activates it later.
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="quickCreate">
          <Field>
            <FieldLabel for="qp-name">Name</FieldLabel>
            <Input id="qp-name" v-model="quickName" autocomplete="off" autofocus />
          </Field>
          <div class="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel for="qp-category">Category</FieldLabel>
              <Select v-model="quickCategoryId">
                <SelectTrigger id="qp-category" class="w-full">
                  <SelectValue placeholder="Pick one" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="cat in leafCategories" :key="cat.id" :value="cat.id">
                    {{ cat.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="qp-sku">SKU</FieldLabel>
              <Input id="qp-sku" v-model="quickSku" autocomplete="off" class="font-mono" />
            </Field>
          </div>
          <Field>
            <FieldLabel for="qp-barcode">
              Barcode <span class="font-normal text-muted-foreground">(optional — scan into this field)</span>
            </FieldLabel>
            <Input id="qp-barcode" v-model="quickBarcode" autocomplete="off" />
          </Field>
          <FieldError v-if="quickError">{{ quickError }}</FieldError>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="quickOpen = false">Cancel</Button>
            <Button type="submit" :disabled="quickSaving || !quickName.trim() || !quickCategoryId || !quickSku.trim()">
              {{ quickSaving ? 'Adding…' : 'Add & stack it' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
