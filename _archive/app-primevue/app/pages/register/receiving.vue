<script setup lang="ts">
import { TrackingMode, formatQuantity, parseGramsToBase, unsafe } from '@huta/shared'
import type { CatalogPage, CatalogProduct, CatalogVariant, OpenOrderRow, ReceiptRow, SupplierRow } from '@huta/shared/schemas'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * Take a delivery — scan-and-stack.
 *
 * The register surface, not the back office: staff receive, and a terminal session cannot
 * leave /register. Cost appears nowhere on this screen and is never sent; the server refuses
 * it from a staff principal outright rather than ignoring it, so a delivery posts uncosted
 * and an admin prices it afterward from /admin/receiving.
 *
 * The search field holds focus and reclaims it after every add, so a barcode scanner — which
 * is just a keyboard — works without anyone tapping into a field first.
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
  /** Set when the line came off an order: what the order still expects. A hint, never a prefill. */
  readonly outstandingBase?: number
}

const suppliers = ref<SupplierRow[]>([])
const supplierId = ref<string>('')
const invoiceNumber = ref('')
const lines = ref<Line[]>([])

const term = ref('')
const results = ref<CatalogProduct[]>([])
const searching = ref(false)
const posting = ref(false)
const error = ref<string | null>(null)
const posted = ref<ReceiptRow | null>(null)

const searchInput = ref<HTMLInputElement | null>(null)

// --- receiving against an order ----------------------------------------------------------

const openOrders = ref<OpenOrderRow[]>([])
const order = ref<OpenOrderRow | null>(null)
/** The chooser shows until a choice is made — and only when there is something to choose. */
const chose = ref(false)
const showChooser = computed(() => !chose.value && openOrders.value.length > 0)

async function loadOpenOrders(): Promise<void> {
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

function chooseWalkIn(): void {
  chose.value = true
  focusSearch()
}

function chooseOrder(picked: OpenOrderRow): void {
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
function unlinkOrder(): void {
  order.value = null
}

function outstandingLabel(line: Line): string | null {
  if (line.outstandingBase === undefined) return null
  return `${formatQuantity(unsafe.baseQuantity(line.outstandingBase), line.trackingMode)} outstanding`
}

function orderDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function outstandingCount(o: OpenOrderRow): number {
  return o.lines.filter((line) => line.outstandingBase > 0).length
}

const [data] = await Promise.all([
  apiFetch<{ suppliers: SupplierRow[] }>('/suppliers'),
  loadOpenOrders(),
])
suppliers.value = data.suppliers

onMounted(() => focusSearch())

function focusSearch(): void {
  void nextTick(() => searchInput.value?.focus())
}

// --- search ------------------------------------------------------------------------------

async function runSearch(): Promise<void> {
  const q = term.value.trim()
  if (q.length < 2) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const page = await apiFetch<CatalogPage>('/catalog/products', {
      query: { search: q, page: '1', pageSize: '20' },
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
function looksScanned(q: string): boolean {
  return /^\d{6,}$/.test(q)
}

function soleVariant(
  products: readonly CatalogProduct[],
): { product: CatalogProduct; variant: CatalogVariant } | null {
  const flat = products.flatMap((p) => p.variants.map((v) => ({ product: p, variant: v })))
  return flat.length === 1 ? flat[0]! : null
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(term, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void runSearch(), 180)
})

// --- the stack ---------------------------------------------------------------------------

function addVariant(product: CatalogProduct, variant: CatalogVariant): void {
  error.value = null
  const existing = lines.value.find((l) => l.variantId === variant.id)
  if (existing) {
    // A second scan of the same item bumps the count rather than stacking a duplicate row.
    if (existing.trackingMode === TrackingMode.EACH) {
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
    quantity: variant.trackingMode === TrackingMode.EACH ? '1' : '',
  })
  term.value = ''
  results.value = []
  focusSearch()
}

function removeLine(variantId: string): void {
  lines.value = lines.value.filter((l) => l.variantId !== variantId)
  focusSearch()
}

/** Base units for one line, or null when what was typed is not usable yet. */
function baseOf(line: Line): number | null {
  const raw = line.quantity.trim()
  if (raw === '') return null

  if (line.trackingMode === TrackingMode.WEIGHT) {
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

/** Counted separately: "18 units and 14g" is the only honest summary across both modes. */
const summary = computed(() => {
  let units = 0
  let weightBase = 0
  for (const line of lines.value) {
    const base = baseOf(line)
    if (base === null) continue
    if (line.trackingMode === TrackingMode.WEIGHT) weightBase += base
    else units += base
  }
  const parts: string[] = []
  if (units > 0) parts.push(`${units} ${units === 1 ? 'unit' : 'units'}`)
  if (weightBase > 0) {
    parts.push(formatQuantity(unsafe.baseQuantity(weightBase), TrackingMode.WEIGHT))
  }
  return parts.join(' + ') || 'nothing yet'
})

// --- post --------------------------------------------------------------------------------

async function post(): Promise<void> {
  if (!ready.value) return
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

function startAnother(): void {
  posted.value = null
  order.value = null
  supplierId.value = ''
  chose.value = false
  // The order just received may now be closed — the chooser must not offer it again.
  void loadOpenOrders()
  focusSearch()
}

function variantName(product: CatalogProduct, variant: CatalogVariant): string {
  return variant.label ? `${product.name} · ${variant.label}` : product.name
}

function lineName(line: Line): string {
  return line.label ? `${line.productName} · ${line.label}` : line.productName
}
</script>

<template>
  <div class="recv">
    <header class="bar">
      <Button
        label="Back"
        icon="pi pi-arrow-left"
        severity="secondary"
        variant="text"
        @click="router.push('/register')"
      />
      <h1>Take a delivery</h1>
      <span class="spacer" />
      <span class="note">{{ order ? 'Cost comes from the order.' : 'Cost is entered by an admin later.' }}</span>
    </header>

    <!-- posted confirmation -->
    <section v-if="posted" class="done">
      <div class="tick">✓</div>
      <h2>Delivery posted</h2>
      <p>
        {{ posted.lines.length }} {{ posted.lines.length === 1 ? 'line' : 'lines' }} received into
        {{ posted.storeName }}<template v-if="posted.supplierName"> from {{ posted.supplierName }}</template
        ><template v-if="posted.purchaseOrderReference"> against {{ posted.purchaseOrderReference }}</template
        >. Stock is updated.
      </p>
      <div class="dactions">
        <Button label="Take another delivery" size="large" @click="startAnother" />
        <Button
          label="Back to register"
          severity="secondary"
          size="large"
          @click="router.push('/register')"
        />
      </div>
    </section>

    <!-- step 1: is this delivery against an order? Only when open orders exist. -->
    <section v-else-if="showChooser" class="choose">
      <h2>Is this delivery against an order?</h2>
      <div class="ocards">
        <button
          v-for="o in openOrders"
          :key="o.id"
          type="button"
          class="ocard"
          @click="chooseOrder(o)"
        >
          <span class="otop">
            <span class="po">{{ o.reference }}</span>
            <span class="obadge" :class="{ part: o.status === 'PARTIALLY_RECEIVED' }">
              {{ o.status === 'PARTIALLY_RECEIVED' ? 'Part received' : 'Ordered' }}
            </span>
            <span class="oout">
              {{ outstandingCount(o) }} {{ outstandingCount(o) === 1 ? 'line' : 'lines' }} outstanding
            </span>
          </span>
          <span class="osub">
            {{ o.supplierName }} · ordered {{ orderDate(o.orderedAt) }}
            <template v-if="o.expectedAt"> · expected {{ orderDate(o.expectedAt) }}</template>
          </span>
        </button>
        <button type="button" class="ocard walkin" @click="chooseWalkIn">
          No order — walk-in or sample delivery
        </button>
      </div>
    </section>

    <template v-else>
      <!-- the pinned order, unmissable while receiving against it -->
      <section v-if="order" class="obanner">
        <span class="obtext">Receiving against {{ order.reference }} · {{ order.supplierName }}</span>
        <button type="button" class="unlink" @click="unlinkOrder">✕ Unlink</button>
      </section>

      <!-- header: supplier + invoice -->
      <section class="meta">
        <div class="field">
          <label for="sup">Supplier</label>
          <select id="sup" v-model="supplierId" class="sel" :disabled="order !== null">
            <option value="">No supplier — sample or walk-in</option>
            <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="field">
          <label for="inv">Invoice number</label>
          <InputText id="inv" v-model="invoiceNumber" class="inv" placeholder="Optional" />
        </div>
      </section>

      <!-- scan bar -->
      <section class="scan">
        <input
          ref="searchInput"
          v-model="term"
          class="scanbox"
          type="text"
          placeholder="Scan a barcode, or search by name or SKU"
          aria-label="Scan or search a product"
          autocomplete="off"
        />
        <span v-if="searching" class="spin">Searching…</span>
      </section>

      <!-- search results -->
      <section v-if="results.length > 0" class="results">
        <template v-for="p in results" :key="p.id">
          <button
            v-for="v in p.variants"
            :key="v.id"
            type="button"
            class="hit"
            @click="addVariant(p, v)"
          >
            <span class="hn">{{ variantName(p, v) }}</span>
            <span class="hs">{{ v.sku }}</span>
            <span class="hm">{{ v.trackingMode === 'WEIGHT' ? 'by weight' : 'each' }}</span>
            <span class="hplus">+</span>
          </button>
        </template>
      </section>

      <!-- the stack -->
      <section class="stack">
        <p v-if="lines.length === 0" class="empty">
          Nothing on this delivery yet. Scan an item to start.
        </p>

        <div v-for="line in lines" v-else :key="line.variantId" class="line">
          <div class="ln">
            <span class="lname">{{ lineName(line) }}</span>
            <span class="lsku">{{ line.sku }}</span>
          </div>

          <span v-if="outstandingLabel(line)" class="hintq">{{ outstandingLabel(line) }}</span>

          <div class="qty">
            <input
              v-model="line.quantity"
              class="qbox"
              :class="{ bad: line.quantity.trim() !== '' && baseOf(line) === null }"
              type="text"
              inputmode="decimal"
              :aria-label="`Quantity for ${lineName(line)}`"
              :placeholder="line.trackingMode === 'WEIGHT' ? '0.00' : '0'"
            />
            <span class="unit">{{ line.trackingMode === 'WEIGHT' ? 'g' : 'ea' }}</span>
          </div>

          <button type="button" class="rm" :aria-label="`Remove ${lineName(line)}`" @click="removeLine(line.variantId)">
            ✕
          </button>
        </div>
      </section>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <!-- footer -->
      <footer class="foot">
        <span class="sum">
          {{ lines.length }} {{ lines.length === 1 ? 'line' : 'lines' }} · {{ summary }}
        </span>
        <Button
          label="Post delivery"
          size="large"
          class="post"
          :disabled="!ready"
          :loading="posting"
          @click="post"
        />
      </footer>
    </template>
  </div>
</template>

<style scoped>
/*
 * A fixed 1080p landscape screen with touch input: large tap targets, no hover-only
 * affordances, and as little typing as the task allows.
 */
.recv {
  display: grid;
  grid-template-rows: auto auto auto 1fr auto;
  gap: 1rem;
  padding: 1.25rem 1.75rem 1.5rem;
  min-height: 100dvh;
  align-content: start;
}

.bar {
  display: flex;
  align-items: center;
  gap: 1rem;
}

h1 {
  margin: 0;
  font-size: 1.375rem;
  letter-spacing: -0.015em;
}

.spacer {
  flex: 1;
}

.note {
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}

.meta {
  display: flex;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.field {
  display: grid;
  gap: 0.35rem;
}

label {
  font-size: 0.6875rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.sel {
  font: inherit;
  font-size: 1rem;
  padding: 0.6rem 0.7rem;
  min-width: 20rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.inv {
  font-size: 1rem;
  padding: 0.6rem 0.7rem;
  min-width: 14rem;
}

.scanbox {
  width: 100%;
  font: inherit;
  font-size: 1.375rem;
  padding: 1rem 1.1rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 2px solid var(--p-primary-color);
  border-radius: 0.6rem;
}

.scanbox:focus {
  outline: 3px solid color-mix(in srgb, var(--p-primary-color) 35%, transparent);
  outline-offset: 1px;
}

.scan {
  position: relative;
}

.spin {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.results {
  display: grid;
  gap: 0.3rem;
  max-height: 18rem;
  overflow-y: auto;
  padding: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.hit {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto 2.5rem;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  text-align: left;
  padding: 0.7rem 0.8rem;
  font: inherit;
  font-size: 1rem;
  color: var(--p-text-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.45rem;
  cursor: pointer;
}

.hit:hover,
.hit:focus-visible {
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  border-color: var(--p-primary-color);
  outline: none;
}

.hn {
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hs,
.hm {
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.hplus {
  justify-self: end;
  font-size: 1.5rem;
  color: var(--p-primary-color);
}

.stack {
  display: grid;
  gap: 0.4rem;
  align-content: start;
  min-height: 12rem;
  padding: 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.empty {
  margin: 0;
  padding: 2rem 0;
  text-align: center;
  color: var(--p-text-muted-color);
}

.line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 1rem;
  padding: 0.65rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.line:last-child {
  border-bottom: none;
}

.ln {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
}

.lname {
  font-size: 1.0625rem;
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lsku {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.qty {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.qbox {
  width: 7rem;
  font: inherit;
  font-size: 1.25rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
  padding: 0.55rem 0.7rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.45rem;
}

.qbox:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.qbox.bad {
  border-color: var(--p-red-600);
}

.unit {
  width: 1.5rem;
  font-size: 0.9375rem;
  color: var(--p-text-muted-color);
}

.rm {
  width: 2.75rem;
  height: 2.75rem;
  font: inherit;
  font-size: 1.125rem;
  color: var(--p-text-muted-color);
  background: transparent;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.45rem;
  cursor: pointer;
}

.rm:hover,
.rm:focus-visible {
  color: var(--p-red-600);
  border-color: var(--p-red-600);
  outline: none;
}

.foot {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding-top: 0.25rem;
}

.sum {
  font-size: 1rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.post {
  margin-left: auto;
  min-width: 14rem;
}

.hintq {
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

/* --- the order chooser -------------------------------------------------------------- */

.choose {
  display: grid;
  gap: 1.25rem;
  max-width: 40rem;
  width: 100%;
  margin: 0 auto;
  padding: 1rem 1.5rem 2rem;
}

.choose h2 {
  margin: 0;
  font-size: 1.375rem;
  letter-spacing: -0.015em;
  text-align: center;
}

.ocards {
  display: grid;
  gap: 0.85rem;
}

/* Touch-first: whole-card targets, nothing under 44px tall. */
.ocard {
  display: grid;
  gap: 0.3rem;
  text-align: left;
  font: inherit;
  padding: 1rem 1.15rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  cursor: pointer;
}

.ocard:hover {
  border-color: var(--p-primary-color);
}

.ocard:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.otop {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.po {
  font-weight: 700;
  font-size: 1.0625rem;
}

.obadge {
  padding: 0.1rem 0.45rem;
  border-radius: 0.3rem;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.obadge.part {
  background: color-mix(in srgb, var(--p-amber-500) 16%, transparent);
  color: var(--p-amber-600, #b45309);
}

.oout {
  margin-left: auto;
  font-size: 0.875rem;
}

.osub {
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}

.ocard.walkin {
  text-align: center;
  justify-items: center;
  font-weight: 620;
  color: var(--p-text-muted-color);
}

/* The pinned order — visible for the whole receive, not just at the pick. */
.obanner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 1.5rem;
  padding: 0.6rem 0.9rem;
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.obtext {
  font-weight: 620;
  font-size: 0.9375rem;
}

.unlink {
  margin-left: auto;
  padding: 0.35rem 0.7rem;
  font: inherit;
  font-size: 0.8125rem;
  color: inherit;
  background: none;
  border: 1px solid transparent;
  border-radius: 0.35rem;
  cursor: pointer;
}

.unlink:hover {
  border-color: currentColor;
}

.unlink:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.done {
  display: grid;
  justify-items: center;
  gap: 0.6rem;
  padding: 4rem 1rem;
  text-align: center;
}

.tick {
  width: 4rem;
  height: 4rem;
  display: grid;
  place-items: center;
  font-size: 2rem;
  color: var(--p-primary-color);
  border: 2px solid var(--p-primary-color);
  border-radius: 50%;
}

.done h2 {
  margin: 0;
  font-size: 1.5rem;
}

.done p {
  margin: 0;
  color: var(--p-text-muted-color);
}

.dactions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}
</style>
