<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, parseGramsToBase, unsafe } from '@huta/shared'
import type { CatalogPage, PurchaseOrderRow, SupplierRow } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Purchase orders — an internal order log, not a document sent to anyone.
 *
 * Master-detail, the same shape as pricing, suppliers and receiving. A DRAFT is editable; a
 * placed order's lines are read-only, because they are the record of what was asked for and
 * editing them would make every variance agree with whatever turned up.
 */

const catalog = useCatalogStore()

const orders = ref<PurchaseOrderRow[]>([])
const suppliers = ref<SupplierRow[]>([])
const selectedId = ref<string | null>(null)
const outstandingOnly = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const creating = ref(false)

async function load(keepSelection = true): Promise<void> {
  const data = await apiFetch<{ orders: PurchaseOrderRow[] }>('/purchase-orders', {
    query: outstandingOnly.value ? { outstandingOnly: 'true' } : {},
  })
  orders.value = data.orders
  if (!keepSelection || !orders.value.some((o) => o.id === selectedId.value)) {
    selectedId.value = orders.value[0]?.id ?? null
  }
}

const supplierData = await apiFetch<{ suppliers: SupplierRow[] }>('/suppliers')
suppliers.value = supplierData.suppliers
await Promise.all([load(false), catalog.loadReference()])

const stores = computed(() => catalog.reference?.stores ?? [])
const order = computed(() => orders.value.find((o) => o.id === selectedId.value) ?? null)
const isDraft = computed(() => order.value?.status === 'DRAFT')

watch(outstandingOnly, () => void load(false))

// --- the draft being built ----------------------------------------------------------------

interface DraftLine {
  variantId: string
  productName: string
  label: string | null
  sku: string
  trackingMode: string
  /** Typed grams for WEIGHT, a whole count for EACH. A string — never a float. */
  quantity: string
  /** Dollars as typed. */
  cost: string
}

const draftStoreId = ref('')
const draftSupplierId = ref('')
const draftExpected = ref('')
const draftLines = ref<DraftLine[]>([])

const search = ref('')
const results = ref<CatalogPage['products']>([])

function syncDraft(): void {
  const current = order.value
  if (!current || creating.value) return
  draftStoreId.value = current.storeId
  draftSupplierId.value = current.supplierId
  draftExpected.value = current.expectedAt ? current.expectedAt.slice(0, 10) : ''
  draftLines.value = current.lines.map((line) => ({
    variantId: line.variantId,
    productName: line.productName,
    label: line.label,
    sku: line.sku,
    trackingMode: line.trackingMode,
    quantity:
      line.trackingMode === TrackingMode.WEIGHT
        ? (line.quantityBase / 1000).toFixed(2)
        : String(line.quantityBase),
    cost:
      line.unitCostCents === null || line.unitCostCents === undefined
        ? ''
        : (line.unitCostCents / 100).toFixed(2),
  }))
}

watch(selectedId, syncDraft, { immediate: true })
watch(orders, syncDraft)

function startNew(): void {
  creating.value = true
  selectedId.value = null
  draftStoreId.value = stores.value[0]?.id ?? ''
  draftSupplierId.value = suppliers.value[0]?.id ?? ''
  draftExpected.value = ''
  draftLines.value = []
  error.value = null
}

function cancelNew(): void {
  creating.value = false
  selectedId.value = orders.value[0]?.id ?? null
  syncDraft()
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void runSearch(), 180)
})

async function runSearch(): Promise<void> {
  const q = search.value.trim()
  if (q.length < 2) {
    results.value = []
    return
  }
  const page = await apiFetch<CatalogPage>('/catalog/products', {
    query: { search: q, page: '1', pageSize: '10' },
  })
  results.value = page.products
}

function addLine(productName: string, variant: { id: string; label: string | null; sku: string; trackingMode: string }): void {
  if (draftLines.value.some((l) => l.variantId === variant.id)) return
  draftLines.value.push({
    variantId: variant.id,
    productName,
    label: variant.label,
    sku: variant.sku,
    trackingMode: variant.trackingMode,
    quantity: variant.trackingMode === TrackingMode.WEIGHT ? '' : '1',
    cost: '',
  })
  search.value = ''
  results.value = []
}

function removeLine(variantId: string): void {
  draftLines.value = draftLines.value.filter((l) => l.variantId !== variantId)
}

/** Dollars typed as a string, parsed by the digits — never `parseFloat * 100`. */
function dollarsToCents(input: string): number | null {
  const raw = input.trim().replace(/^\$/, '')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

function baseOf(line: DraftLine): number | null {
  const raw = line.quantity.trim()
  if (raw === '') return null
  if (line.trackingMode === TrackingMode.WEIGHT) {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : null
  }
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

const draftValid = computed(
  () =>
    draftLines.value.length > 0 &&
    draftSupplierId.value !== '' &&
    draftStoreId.value !== '' &&
    draftLines.value.every((l) => baseOf(l) !== null),
)

function draftBody() {
  return {
    supplierId: draftSupplierId.value,
    ...(draftExpected.value
      ? { expectedAt: new Date(`${draftExpected.value}T12:00:00Z`).toISOString() }
      : {}),
    lines: draftLines.value.map((l) => {
      const cents = dollarsToCents(l.cost)
      return {
        variantId: l.variantId,
        quantityBase: baseOf(l)!,
        ...(cents === null ? {} : { unitCostCents: cents }),
      }
    }),
  }
}

async function act(fn: () => Promise<unknown>, fallback: string): Promise<void> {
  saving.value = true
  error.value = null
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : fallback
  } finally {
    saving.value = false
  }
}

async function saveDraft(): Promise<void> {
  if (!draftValid.value) {
    error.value = 'Every line needs a quantity, and the order needs a supplier and a store.'
    return
  }
  await act(async () => {
    if (creating.value) {
      const created = await apiFetch<PurchaseOrderRow>('/purchase-orders', {
        method: 'POST',
        body: { storeId: draftStoreId.value, ...draftBody() },
      })
      creating.value = false
      await load(false)
      selectedId.value = created.id
    } else {
      await apiFetch(`/purchase-orders/${order.value!.id}`, {
        method: 'PATCH',
        body: draftBody(),
      })
      await load()
    }
  }, 'Could not save that order.')
}

async function place(): Promise<void> {
  await act(async () => {
    await apiFetch(`/purchase-orders/${order.value!.id}/place`, { method: 'POST' })
    await load()
  }, 'Could not place that order.')
}

async function cancel(): Promise<void> {
  await act(async () => {
    await apiFetch(`/purchase-orders/${order.value!.id}/cancel`, { method: 'POST' })
    await load()
  }, 'Could not cancel that order.')
}

async function close(): Promise<void> {
  await act(async () => {
    await apiFetch(`/purchase-orders/${order.value!.id}/close-short`, { method: 'POST' })
    await load()
  }, 'Could not close that order.')
}

// --- display -------------------------------------------------------------------------------

function qty(base: number, trackingMode: string): string {
  return formatQuantity(unsafe.baseQuantity(base), trackingMode as TrackingMode)
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return formatCents(unsafe.cents(cents))
}

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ORDERED: 'Ordered',
  PARTIALLY_RECEIVED: 'Part received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
}

function statusClass(status: string): string {
  if (status === 'PARTIALLY_RECEIVED') return 'warn'
  if (status === 'RECEIVED' || status === 'CANCELLED') return 'mute'
  if (status === 'DRAFT') return 'mute'
  return ''
}

function lineName(line: { productName: string; label: string | null }): string {
  return line.label ? `${line.productName} · ${line.label}` : line.productName
}

const outstandingCount = computed(() => orders.value.filter((o) => o.outstanding).length)
</script>

<template>
  <section class="orders">
    <header class="head">
      <h1>Purchase orders</h1>
      <span class="count">
        {{ outstandingCount }} outstanding · {{ orders.length }}
        {{ orders.length === 1 ? 'order' : 'orders' }}
      </span>
    </header>

    <div class="filters">
      <button
        type="button"
        class="chip"
        :class="{ on: outstandingOnly }"
        :aria-pressed="outstandingOnly"
        @click="outstandingOnly = !outstandingOnly"
      >
        Outstanding only
      </button>
      <span class="sp" />
      <Button label="New order" severity="secondary" size="small" @click="startNew" />
    </div>

    <div class="body">
      <!-- master -->
      <aside class="list">
        <ul class="rows">
          <li v-for="o in orders" :key="o.id">
            <button
              type="button"
              class="row"
              :class="{ on: o.id === selectedId }"
              @click="creating = false; selectedId = o.id"
            >
              <span class="nm">{{ o.reference }}</span>
              <span class="sub">{{ o.supplierName }} · {{ when(o.orderedAt) }}</span>
              <span class="f">
                <span class="badge" :class="statusClass(o.status)">
                  {{ STATUS_LABEL[o.status] ?? o.status }}
                </span>
              </span>
            </button>
          </li>
          <li v-if="orders.length === 0" class="empty">
            {{ outstandingOnly ? 'Nothing outstanding.' : 'No orders yet.' }}
          </li>
        </ul>
      </aside>

      <!-- detail -->
      <div v-if="order || creating" class="editor">
        <div class="ename">
          <span class="n">{{ creating ? 'New order' : order?.reference }}</span>
          <span v-if="order" class="badge" :class="statusClass(order.status)">
            {{ STATUS_LABEL[order.status] ?? order.status }}
          </span>
          <span v-if="order" class="badge mute">{{ order.storeName }}</span>
          <span v-if="order?.daysToFirstReceipt !== null && order" class="badge">
            First delivery in {{ order.daysToFirstReceipt }}d
          </span>
          <span v-if="order?.daysToFullReceipt !== null && order" class="badge">
            Complete in {{ order.daysToFullReceipt }}d
          </span>
        </div>

        <!-- header fields: editable only while a draft -->
        <div class="grid">
          <div class="field">
            <label for="o-store">Store</label>
            <select
              id="o-store"
              v-model="draftStoreId"
              class="sel"
              :disabled="!creating"
            >
              <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
          <div class="field">
            <label for="o-sup">Supplier</label>
            <select
              id="o-sup"
              v-model="draftSupplierId"
              class="sel"
              :disabled="!creating && !isDraft"
            >
              <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
          <div class="field">
            <label for="o-exp">Expected</label>
            <input
              id="o-exp"
              v-model="draftExpected"
              class="sel"
              type="date"
              :disabled="!creating && !isDraft"
            />
          </div>
        </div>

        <!-- line picker, drafts only -->
        <div v-if="creating || isDraft" class="field">
          <label for="o-find">Add a product</label>
          <InputText id="o-find" v-model="search" placeholder="Search by name or SKU" />
          <div v-if="results.length > 0" class="hits">
            <template v-for="p in results" :key="p.id">
              <button
                v-for="v in p.variants"
                :key="v.id"
                type="button"
                class="hit"
                @click="addLine(p.name, v)"
              >
                <span>{{ v.label ? `${p.name} · ${v.label}` : p.name }}</span>
                <span class="hs">{{ v.sku }}</span>
              </button>
            </template>
          </div>
        </div>

        <!-- lines -->
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Ordered</th>
                <th v-if="!creating && !isDraft" class="num">Received</th>
                <th v-if="!creating && !isDraft" class="num">Outstanding</th>
                <th class="num">Unit cost</th>
                <th v-if="creating || isDraft" />
              </tr>
            </thead>

            <!-- draft: editable -->
            <tbody v-if="creating || isDraft">
              <tr v-for="line in draftLines" :key="line.variantId">
                <td>
                  <span class="lname">{{ lineName(line) }}</span>
                  <span class="lsku">{{ line.sku }}</span>
                </td>
                <td class="num">
                  <span class="money">
                    <InputText
                      v-model="line.quantity"
                      class="amt"
                      inputmode="decimal"
                      :class="{ bad: line.quantity.trim() !== '' && baseOf(line) === null }"
                      :aria-label="`Quantity for ${lineName(line)}`"
                    />
                    <span class="unit">{{ line.trackingMode === 'WEIGHT' ? 'g' : 'ea' }}</span>
                  </span>
                </td>
                <td class="num">
                  <span class="money">
                    <span class="sym">$</span>
                    <InputText
                      v-model="line.cost"
                      class="amt"
                      inputmode="decimal"
                      :aria-label="`Unit cost for ${lineName(line)}`"
                    />
                    <span class="unit">{{ line.trackingMode === 'WEIGHT' ? '/g' : '/ea' }}</span>
                  </span>
                </td>
                <td class="num">
                  <button
                    type="button"
                    class="rm"
                    :aria-label="`Remove ${lineName(line)}`"
                    @click="removeLine(line.variantId)"
                  >
                    ✕
                  </button>
                </td>
              </tr>
              <tr v-if="draftLines.length === 0">
                <td colspan="4" class="empty">Search above to add the first line.</td>
              </tr>
            </tbody>

            <!-- placed: read-only, with what turned up -->
            <tbody v-else-if="order">
              <tr v-for="line in order.lines" :key="line.id">
                <td>
                  <span class="lname">{{ lineName(line) }}</span>
                  <span class="lsku">{{ line.sku }}</span>
                </td>
                <td class="num">{{ qty(line.quantityBase, line.trackingMode) }}</td>
                <td class="num">{{ qty(line.receivedBase, line.trackingMode) }}</td>
                <td class="num" :class="{ over: line.varianceBase > 0, short: line.varianceBase < 0 }">
                  <template v-if="line.varianceBase === 0">—</template>
                  <template v-else-if="line.varianceBase > 0">
                    +{{ qty(line.varianceBase, line.trackingMode) }} over
                  </template>
                  <template v-else>
                    {{ qty(-line.varianceBase, line.trackingMode) }} to come
                  </template>
                </td>
                <td class="num">{{ money(line.unitCostCents) }}</td>
              </tr>
            </tbody>

            <tfoot v-if="order && !creating && !isDraft">
              <tr>
                <td :colspan="4" class="num tlabel">Order value</td>
                <td class="num">{{ money(order.totalCostCents) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="order && !isDraft && !creating" class="who">
          Placed by {{ order.orderedByName }} on {{ when(order.orderedAt) }}.
          <template v-if="order.receiptCount > 0">
            {{ order.receiptCount }} {{ order.receiptCount === 1 ? 'delivery' : 'deliveries' }} so far.
          </template>
        </p>

        <div class="foot">
          <template v-if="creating || isDraft">
            <span class="hint">Lines can only be changed while the order is a draft.</span>
            <span class="sp" />
            <Button
              v-if="creating"
              label="Cancel"
              severity="secondary"
              variant="text"
              size="small"
              @click="cancelNew"
            />
            <Button
              :label="creating ? 'Save draft' : 'Save changes'"
              severity="secondary"
              size="small"
              :loading="saving"
              @click="saveDraft"
            />
            <Button
              v-if="!creating"
              label="Place order"
              size="small"
              :loading="saving"
              @click="place"
            />
          </template>

          <template v-else-if="order">
            <span class="hint">
              A placed order's lines are the record of what was asked for.
            </span>
            <span class="sp" />
            <Button
              v-if="order.status === 'PARTIALLY_RECEIVED'"
              label="Close short"
              severity="secondary"
              size="small"
              :loading="saving"
              @click="close"
            />
            <Button
              v-if="order.outstanding"
              label="Cancel order"
              severity="danger"
              variant="text"
              size="small"
              :loading="saving"
              @click="cancel"
            />
          </template>
        </div>

        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      </div>

      <p v-else class="state">No orders yet.</p>
    </div>
  </section>
</template>

<style scoped>
.orders {
  display: grid;
  gap: 1rem;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 1rem;
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: -0.015em;
}

.count {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.filters {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.chip {
  padding: 0.25rem 0.6rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
  cursor: pointer;
}

.chip.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
  font-weight: 620;
}

.chip:focus-visible,
.row:focus-visible,
.sel:focus-visible,
.hit:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.body {
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@container content (max-width: 1000px) {
  .body {
    grid-template-columns: 1fr;
  }
}

.list {
  padding: 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.15rem;
  max-height: 30rem;
  overflow-y: auto;
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 0.5rem;
  text-align: left;
  padding: 0.4rem 0.5rem;
  font: inherit;
  color: var(--p-text-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  cursor: pointer;
}

.row:hover {
  background: var(--p-surface-50);
}

.app-dark .row:hover {
  background: var(--p-surface-800);
}

.row.on {
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
  border-color: var(--p-primary-color);
}

.nm {
  font-size: 0.875rem;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
}

.sub {
  grid-column: 1;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.f {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
}

.empty {
  padding: 0.6rem 0.5rem;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  text-align: center;
}

.editor {
  display: grid;
  gap: 0.9rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.ename {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.ename .n {
  font-size: 1.0625rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}

.badge {
  font-size: 0.6875rem;
  font-weight: 620;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
  white-space: nowrap;
}

.badge.mute {
  background: color-mix(in srgb, var(--p-text-muted-color) 14%, transparent);
  color: var(--p-text-muted-color);
}

.badge.warn {
  background: color-mix(in srgb, var(--p-amber-500) 25%, transparent);
  color: var(--p-amber-600, #b45309);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem;
}

.field {
  display: grid;
  gap: 0.3rem;
  align-content: start;
}

label {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.sel {
  font: inherit;
  font-size: 0.875rem;
  padding: 0.4rem 0.5rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
}

.sel:disabled {
  color: var(--p-text-muted-color);
  background: var(--p-surface-50);
}

.app-dark .sel:disabled {
  background: var(--p-surface-900);
}

.hits {
  display: grid;
  gap: 0.15rem;
  max-height: 12rem;
  overflow-y: auto;
  margin-top: 0.3rem;
  padding: 0.3rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
}

.hit {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  text-align: left;
  padding: 0.35rem 0.45rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--p-text-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.3rem;
  cursor: pointer;
}

.hit:hover {
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  border-color: var(--p-primary-color);
}

.hs {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

.tablewrap {
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.45rem;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

th,
td {
  padding: 0.5rem 0.875rem;
  text-align: left;
  border-bottom: 1px solid var(--p-content-border-color);
}

th {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

tbody tr:last-child td {
  border-bottom: none;
}

tfoot td {
  border-top: 1px solid var(--p-content-border-color);
  border-bottom: none;
  font-weight: 620;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.tlabel {
  color: var(--p-text-muted-color);
  font-weight: 560;
}

.over {
  color: var(--p-amber-600, #b45309);
}

.short {
  color: var(--p-text-muted-color);
}

.lname {
  display: block;
  font-weight: 560;
}

.lsku {
  display: block;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

.money {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}

.sym,
.unit {
  color: var(--p-text-muted-color);
  font-size: 0.8125rem;
}

.amt {
  width: 5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.amt.bad {
  border-color: var(--p-red-600);
}

.rm {
  width: 1.9rem;
  height: 1.9rem;
  font: inherit;
  color: var(--p-text-muted-color);
  background: transparent;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.3rem;
  cursor: pointer;
}

.rm:hover {
  color: var(--p-red-600);
  border-color: var(--p-red-600);
}

.who {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.foot {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.sp {
  flex: 1;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.state {
  color: var(--p-text-muted-color);
}
</style>
