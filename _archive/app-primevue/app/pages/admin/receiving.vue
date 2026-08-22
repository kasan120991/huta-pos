<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, receiptLineValueCents, unsafe } from '@huta/shared'
import type { ReceiptRow, VarianceLine } from '@huta/shared/schemas'
import { computed, onUnmounted, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Deliveries and the costing queue.
 *
 * Staff receive quantities; cost is entered here. Everything on this page is cost-bearing,
 * which is why it lives in the back office — a terminal session cannot reach it, and the
 * server strips cost by capability regardless.
 */

const catalog = useCatalogStore()

const receipts = ref<ReceiptRow[]>([])
const selectedId = ref<string | null>(null)
const uncostedOnly = ref(true)
const needsReviewOnly = ref(false)
const storeId = ref<string>('')
const saving = ref(false)
const error = ref<string | null>(null)
const savedAt = ref<number | null>(null)
const reviewCount = ref(0)
const variance = ref<VarianceLine[]>([])

async function load(keepSelection = true): Promise<void> {
  const data = await apiFetch<{ receipts: ReceiptRow[] }>('/receiving/receipts', {
    query: {
      ...(uncostedOnly.value ? { uncostedOnly: 'true' } : {}),
      ...(needsReviewOnly.value ? { needsReviewOnly: 'true' } : {}),
      ...(storeId.value ? { storeId: storeId.value } : {}),
    },
  })
  receipts.value = data.receipts
  if (!keepSelection || !receipts.value.some((r) => r.id === selectedId.value)) {
    selectedId.value = receipts.value[0]?.id ?? null
  }
  await refreshReviewCount()
}

/** The badge on the chip — kept separate so it is right whatever filter is showing. */
async function refreshReviewCount(): Promise<void> {
  const data = await apiFetch<{ receipts: ReceiptRow[] }>('/receiving/receipts', {
    query: { needsReviewOnly: 'true' },
  })
  reviewCount.value = data.receipts.length
}

await Promise.all([load(false), catalog.loadReference()])

/**
 * A flagged delivery announces itself.
 *
 * The payload is a hint to REFETCH, never the thing that updates the list — the house rule is
 * explicit that a socket event must not be the only thing mutating state that matters. A
 * dropped event costs a slower refresh and nothing else.
 */
const { $socket } = useNuxtApp()

function onVariance(): void {
  void load()
}

$socket.on('receipt.variance', onVariance)
onUnmounted(() => {
  $socket.off('receipt.variance', onVariance)
})

const stores = computed(() => catalog.reference?.stores ?? [])
const selected = computed(() => receipts.value.find((r) => r.id === selectedId.value) ?? null)

/** Cost per line as typed, in dollars. Keyed by line id. */
const drafts = ref<Record<string, string>>({})

function syncDrafts(): void {
  const r = selected.value
  if (!r) return
  const next: Record<string, string> = {}
  for (const line of r.lines) {
    next[line.id] =
      line.unitCostCents === null || line.unitCostCents === undefined
        ? ''
        : (line.unitCostCents / 100).toFixed(2)
  }
  drafts.value = next
}

watch(selectedId, syncDrafts, { immediate: true })
watch(receipts, syncDrafts)
watch([uncostedOnly, needsReviewOnly, storeId], () => void load(false))

/**
 * The two queues are alternatives, not composable filters.
 *
 * ANDing them asks "which deliveries need costing AND need review", which is a question
 * nobody has — and because "Needs costing" is on by default, turning on "Needs review"
 * produced an empty list and looked broken. Turning one on turns the other off; turning
 * both off shows every delivery.
 */
function showQueue(queue: 'costing' | 'review'): void {
  if (queue === 'costing') {
    uncostedOnly.value = !uncostedOnly.value
    if (uncostedOnly.value) needsReviewOnly.value = false
  } else {
    needsReviewOnly.value = !needsReviewOnly.value
    if (needsReviewOnly.value) uncostedOnly.value = false
  }
}

/** The ordered-vs-received comparison, fetched only when there is something to compare. */
async function loadVariance(): Promise<void> {
  const current = selected.value
  if (!current?.hasVariance) {
    variance.value = []
    return
  }
  const data = await apiFetch<{ variance: VarianceLine[] }>(
    `/receiving/receipts/${current.id}/variance`,
  )
  variance.value = data.variance
}

watch(selectedId, () => void loadVariance(), { immediate: true })

async function markReviewed(): Promise<void> {
  const current = selected.value
  if (!current) return
  saving.value = true
  error.value = null
  try {
    await apiFetch(`/receiving/receipts/${current.id}/review`, { method: 'POST' })
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not mark that reviewed.'
  } finally {
    saving.value = false
  }
}

const VARIANCE_LABEL: Record<string, string> = {
  OVER: 'Over',
  SHORT: 'Short',
  UNEXPECTED: 'Not ordered',
}

function varianceQty(line: VarianceLine, base: number | null): string {
  if (base === null) return '—'
  return formatQuantity(unsafe.baseQuantity(Math.abs(base)), line.trackingMode as TrackingMode)
}

/** Dollars typed as a string, parsed by the digits — never `parseFloat * 100`. */
function dollarsToCents(input: string): number | null {
  const raw = input.trim().replace(/^\$/, '')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/**
 * What a line is worth at the cost currently typed.
 *
 * Uses the SAME `receiptLineValueCents` the server uses, so the preview cannot disagree
 * with the basis that actually lands — including the per-gram/per-milligram conversion that
 * makes flower cost 1000x wrong if anyone does it by hand.
 */
function lineValue(line: ReceiptRow['lines'][number]): string {
  const cents = dollarsToCents(drafts.value[line.id] ?? '')
  if (cents === null) return '—'
  return formatCents(
    receiptLineValueCents(line.trackingMode as TrackingMode, line.quantityBase, cents),
  )
}

function qty(line: ReceiptRow['lines'][number]): string {
  return formatQuantity(
    unsafe.baseQuantity(line.quantityBase),
    line.trackingMode as TrackingMode,
  )
}

/** Per item for EACH, per gram for WEIGHT — labelled, because the two are not comparable. */
function costUnit(line: ReceiptRow['lines'][number]): string {
  return line.trackingMode === TrackingMode.WEIGHT ? '/g' : '/ea'
}

const totalTyped = computed(() => {
  const r = selected.value
  if (!r) return null
  let sum = 0
  let any = false
  for (const line of r.lines) {
    const cents = dollarsToCents(drafts.value[line.id] ?? '')
    if (cents === null) continue
    any = true
    sum += receiptLineValueCents(line.trackingMode as TrackingMode, line.quantityBase, cents)
  }
  return any ? sum : null
})

const dirty = computed(() => {
  const r = selected.value
  if (!r) return false
  return r.lines.some((line) => {
    const typed = dollarsToCents(drafts.value[line.id] ?? '')
    const current = line.unitCostCents ?? null
    return typed !== null && typed !== current
  })
})

async function save(): Promise<void> {
  const r = selected.value
  if (!r) return

  const costs = r.lines
    .map((line) => ({ lineId: line.id, unitCostCents: dollarsToCents(drafts.value[line.id] ?? '') }))
    .filter((c): c is { lineId: string; unitCostCents: number } => c.unitCostCents !== null)

  if (costs.length === 0) {
    error.value = 'Enter a cost on at least one line.'
    return
  }

  saving.value = true
  error.value = null
  try {
    await apiFetch(`/receiving/receipts/${r.id}/costs`, { method: 'PATCH', body: { costs } })
    await load()
    savedAt.value = Date.now()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save those costs.'
  } finally {
    saving.value = false
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function lineName(line: ReceiptRow['lines'][number]): string {
  return line.label ? `${line.productName} · ${line.label}` : line.productName
}
</script>

<template>
  <section class="receiving">
    <header class="head">
      <h1>Receiving</h1>
      <span class="count">
        {{ receipts.length }} {{ receipts.length === 1 ? 'delivery' : 'deliveries' }}
      </span>
    </header>

    <div class="filters">
      <button
        type="button"
        class="chip"
        :class="{ on: uncostedOnly }"
        :aria-pressed="uncostedOnly"
        @click="showQueue('costing')"
      >
        Needs costing
      </button>
      <button
        type="button"
        class="chip"
        :class="{ on: needsReviewOnly }"
        :aria-pressed="needsReviewOnly"
        @click="showQueue('review')"
      >
        Needs review
        <span v-if="reviewCount > 0" class="badge warn">{{ reviewCount }}</span>
      </button>
      <select v-model="storeId" class="sel" aria-label="Store">
        <option value="">All stores</option>
        <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
    </div>

    <div class="body">
      <!-- master -->
      <aside class="list">
        <ul class="rows">
          <li v-for="r in receipts" :key="r.id">
            <button
              type="button"
              class="row"
              :class="{ on: r.id === selectedId }"
              @click="selectedId = r.id"
            >
              <span class="nm">{{ r.supplierName ?? 'No supplier' }}</span>
              <span class="sub">
                {{ when(r.receivedAt) }} · {{ r.storeName }}
                <template v-if="r.purchaseOrderReference"> · {{ r.purchaseOrderReference }}</template>
              </span>
              <span class="f">
                <span v-if="r.hasVariance && !r.reviewedAt" class="flag alert">!</span>
                <span v-else-if="r.uncostedLineCount" class="flag">{{ r.uncostedLineCount }}</span>
              </span>
            </button>
          </li>
          <li v-if="receipts.length === 0" class="empty">
            {{ uncostedOnly ? 'Everything is costed.' : 'No deliveries yet.' }}
          </li>
        </ul>
      </aside>

      <!-- detail -->
      <div v-if="selected" class="editor">
        <div class="ename">
          <span class="n">{{ selected.supplierName ?? 'Standalone delivery' }}</span>
          <span class="badge">{{ selected.storeName }}</span>
          <span v-if="selected.purchaseOrderReference" class="badge alt">
            {{ selected.purchaseOrderReference }}
          </span>
          <span v-if="selected.invoiceNumber" class="badge alt">
            Invoice {{ selected.invoiceNumber }}
          </span>
          <span v-if="selected.uncostedLineCount" class="badge warn">
            {{ selected.uncostedLineCount }} uncosted
          </span>
          <span v-if="selected.hasVariance && !selected.reviewedAt" class="badge warn">
            Variance
          </span>
        </div>

        <p class="who">
          Received by {{ selected.receivedByName }} on {{ when(selected.receivedAt) }}.
          <template v-if="selected.reviewedAt">
            Reviewed by {{ selected.reviewedByName }} on {{ when(selected.reviewedAt) }}.
          </template>
        </p>

        <!-- what differs from the order -->
        <div v-if="selected.hasVariance && variance.length > 0" class="varbox">
          <div class="vhead">
            <span class="vt">Against {{ selected.purchaseOrderReference }}</span>
            <span class="hint">Stock is already posted — variances are flagged, not blocked.</span>
          </div>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th class="num">Ordered</th>
                  <th class="num">Received</th>
                  <th class="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in variance" :key="line.variantId">
                  <td>
                    <span class="lname">
                      {{ line.label ? `${line.productName} · ${line.label}` : line.productName }}
                    </span>
                    <span class="lsku">{{ VARIANCE_LABEL[line.kind] ?? line.kind }}</span>
                  </td>
                  <td class="num">{{ varianceQty(line, line.orderedBase) }}</td>
                  <td class="num">{{ varianceQty(line, line.receivedBase) }}</td>
                  <td class="num" :class="line.kind === 'SHORT' ? 'shortv' : 'overv'">
                    {{ line.differenceBase > 0 ? '+' : '−' }}{{ varianceQty(line, line.differenceBase) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="vfoot">
            <span class="spacer" />
            <Button
              label="Mark reviewed"
              size="small"
              :loading="saving"
              @click="markReviewed"
            />
          </div>
        </div>

        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Received</th>
                <th class="num">Unit cost</th>
                <th class="num">Line value</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in selected.lines" :key="line.id">
                <td>
                  <span class="lname">{{ lineName(line) }}</span>
                  <span class="lsku">{{ line.sku }}</span>
                </td>
                <td class="num">{{ qty(line) }}</td>
                <td class="num">
                  <span class="money">
                    <span class="sym">$</span>
                    <InputText
                      v-model="drafts[line.id]"
                      class="amt"
                      inputmode="decimal"
                      :aria-label="`Unit cost for ${lineName(line)}`"
                    />
                    <span class="unit">{{ costUnit(line) }}</span>
                  </span>
                </td>
                <td class="num val">{{ lineValue(line) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" class="num tlabel">Delivery value</td>
                <td class="num val">
                  {{ totalTyped === null ? '—' : formatCents(unsafe.cents(totalTyped)) }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!--
          Stated on screen, not just in a docstring. An admin costing a week-old delivery
          needs to know the number will not be exact.
        -->
        <p class="caveat">
          Cost is added to each store's current stock. If some of this delivery has already
          sold, the value lands on what remains — the average will read a little high. Costs
          already reported on a customer's receipt are never restated.
        </p>

        <div class="foot">
          <span class="hint">Per gram for weight-tracked items, per item for everything else.</span>
          <span class="spacer" />
          <Button
            label="Save costs"
            size="small"
            :disabled="!dirty"
            :loading="saving"
            @click="save"
          />
        </div>

        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <p v-else-if="savedAt" class="ok">Saved.</p>
      </div>

      <p v-else class="state">Select a delivery.</p>
    </div>
  </section>
</template>

<style scoped>
.receiving {
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
  gap: 0.5rem;
  align-items: center;
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

.sel {
  font: inherit;
  font-size: 0.8125rem;
  padding: 0.25rem 0.45rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
}

.chip:focus-visible,
.sel:focus-visible,
.row:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.body {
  display: grid;
  grid-template-columns: 18rem minmax(0, 1fr);
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
  padding: 0.45rem 0.5rem;
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
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.flag {
  display: inline-block;
  min-width: 1.25rem;
  text-align: center;
  font-size: 0.6875rem;
  font-weight: 650;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-text-muted-color) 16%, transparent);
  color: var(--p-text-muted-color);
}

.flag.alert {
  background: color-mix(in srgb, var(--p-amber-500) 25%, transparent);
  color: var(--p-amber-600, #b45309);
}

.varbox {
  display: grid;
  gap: 0.6rem;
  padding: 0.85rem;
  border: 1px solid var(--p-amber-500);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--p-amber-500) 6%, transparent);
}

.vhead {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.vt {
  font-size: 0.875rem;
  font-weight: 650;
}

.vfoot {
  display: flex;
  align-items: center;
}

.overv {
  color: var(--p-amber-600, #b45309);
}

.shortv {
  color: var(--p-red-600);
}

.empty {
  padding: 0.6rem 0.5rem;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
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
  gap: 0.6rem;
  flex-wrap: wrap;
}

.ename .n {
  font-size: 1.0625rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.badge {
  font-size: 0.6875rem;
  font-weight: 620;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.badge.alt {
  background: color-mix(in srgb, var(--p-text-muted-color) 14%, transparent);
  color: var(--p-text-muted-color);
}

.badge.warn {
  background: color-mix(in srgb, var(--p-amber-500) 25%, transparent);
  color: var(--p-amber-600, #b45309);
}

.who {
  margin: 0;
  font-size: 0.8125rem;
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

.val {
  font-variant-numeric: tabular-nums;
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
  width: 5.5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.caveat {
  margin: 0;
  padding: 0.6rem 0.75rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--p-text-muted-color);
  background: var(--p-surface-50);
  border-left: 3px solid var(--p-amber-500);
  border-radius: 0 0.3rem 0.3rem 0;
}

.app-dark .caveat {
  background: var(--p-surface-900);
}

.foot {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.ok {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-primary-color);
}

.state {
  color: var(--p-text-muted-color);
}
</style>
