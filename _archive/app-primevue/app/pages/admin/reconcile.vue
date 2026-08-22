<script setup lang="ts">
import {
  ADJUSTMENT_REASONS,
  RECONCILE_REASON_CODE,
  TrackingMode,
  divRoundHalfUp,
  formatCents,
  formatQuantity,
  parseGramsToBase,
  unsafe,
} from '@huta/shared'
import type { ReconcileResult, ReconcileRow } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Weight reconciliation — one counting session over a store's flower.
 *
 * Matches how a count actually happens: scale in hand, working down the shelf, one submit at
 * the end. The rule that matters most is that a BLANK field means "not counted" and writes
 * nothing — treating an uncounted shelf as zero would write off the whole pool, and the
 * ledger is append-only so there is no undo.
 */

const catalog = useCatalogStore()

const rows = ref<ReconcileRow[]>([])
const counted = ref<Record<string, string>>({})
const storeId = ref('')
const reasonCode = ref<string>(RECONCILE_REASON_CODE)
const note = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const posted = ref<ReconcileResult | null>(null)

await catalog.loadReference()
const stores = computed(() => catalog.reference?.stores ?? [])
storeId.value = stores.value[0]?.id ?? ''

async function load(): Promise<void> {
  if (!storeId.value) return
  const data = await apiFetch<{ rows: ReconcileRow[] }>(`/inventory/reconcile/${storeId.value}`)
  rows.value = data.rows
  counted.value = {}
  posted.value = null
}

await load()
watch(storeId, () => void load())

/** Grams typed as a string, parsed by the digits — `3.53 * 1000` is 3530.0000000000005. */
function baseOf(variantId: string): number | null {
  const raw = (counted.value[variantId] ?? '').trim()
  if (raw === '') return null
  const parsed = parseGramsToBase(raw)
  return parsed.ok ? parsed.value : null
}

function malformed(variantId: string): boolean {
  const raw = (counted.value[variantId] ?? '').trim()
  return raw !== '' && baseOf(variantId) === null
}

function deltaOf(row: ReconcileRow): number | null {
  const base = baseOf(row.variantId)
  if (base === null) return null
  return base - row.onRecordBase
}

/** What a shortfall is worth at this store's weighted-average cost. */
function valueOf(row: ReconcileRow): number | null {
  const delta = deltaOf(row)
  if (delta === null || delta >= 0) return null
  const avg = row.avgUnitCostCents
  if (avg === null || avg === undefined) return null
  // Same shape as the server's costOutCents: a per-gram rate against a milligram quantity.
  return -divRoundHalfUp(Math.abs(delta) * avg, 1000)
}

const changed = computed(() => rows.value.filter((r) => (deltaOf(r) ?? 0) !== 0))
const anyMalformed = computed(() => rows.value.some((r) => malformed(r.variantId)))
const canPost = computed(() => changed.value.length > 0 && !anyMalformed.value)

const totalDelta = computed(() =>
  changed.value.reduce((sum, row) => sum + (deltaOf(row) ?? 0), 0),
)

const totalValue = computed(() => {
  let sum = 0
  let any = false
  for (const row of changed.value) {
    const value = valueOf(row)
    if (value === null) continue
    any = true
    sum += value
  }
  return any ? sum : null
})

async function post(): Promise<void> {
  if (!canPost.value) return
  saving.value = true
  error.value = null
  try {
    const result = await apiFetch<ReconcileResult>('/inventory/reconcile', {
      method: 'POST',
      body: {
        storeId: storeId.value,
        // Only rows the admin actually typed into. A blank is absent, never zero.
        counts: changed.value.map((r) => ({
          variantId: r.variantId,
          countedBase: baseOf(r.variantId)!,
        })),
        reasonCode: reasonCode.value,
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      },
    })
    // Reload FIRST, then set the confirmation: `load` clears `posted` to reset the sheet,
    // so setting it beforehand meant the message was wiped before it ever rendered.
    await load()
    posted.value = result
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not post that reconciliation.'
  } finally {
    saving.value = false
  }
}

function grams(base: number): string {
  return formatQuantity(unsafe.baseQuantity(Math.abs(base)), TrackingMode.WEIGHT)
}

function money(cents: number | null): string {
  return cents === null ? '—' : formatCents(unsafe.cents(cents))
}

function rowName(row: ReconcileRow): string {
  return row.label ? `${row.productName} · ${row.label}` : row.productName
}
</script>

<template>
  <section class="reconcile">
    <header class="head">
      <h1>Reconcile flower</h1>
      <span class="count">
        {{ rows.length }} {{ rows.length === 1 ? 'strain' : 'strains' }} on record
      </span>
    </header>

    <div class="filters">
      <select v-model="storeId" class="sel" aria-label="Store">
        <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <span class="hint">Weigh each strain and key what the scale reads. Leave blank to skip.</span>
    </div>

    <Message v-if="posted" severity="success" :closable="false">
      Posted {{ posted.lines.length }}
      {{ posted.lines.length === 1 ? 'correction' : 'corrections' }} at {{ posted.storeName }} —
      {{ posted.totalDeltaBase < 0 ? 'down' : 'up' }} {{ grams(posted.totalDeltaBase) }}<template
        v-if="posted.totalValueCents !== null"
      >, {{ money(posted.totalValueCents) }}</template
      >.
    </Message>

    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Strain</th>
            <th class="num">On record</th>
            <th class="num">Weighed</th>
            <th class="num">Difference</th>
            <th class="num">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.variantId">
            <td>
              <span class="lname">{{ rowName(row) }}</span>
              <span class="lsku">
                {{ row.sku }}
                <template v-if="row.avgUnitCostCents !== null && row.avgUnitCostCents !== undefined">
                  · {{ money(row.avgUnitCostCents) }}/g avg
                </template>
              </span>
            </td>
            <td class="num">{{ grams(row.onRecordBase) }}</td>
            <td class="num">
              <span class="money">
                <InputText
                  v-model="counted[row.variantId]"
                  class="amt"
                  inputmode="decimal"
                  placeholder="—"
                  :class="{ bad: malformed(row.variantId) }"
                  :aria-label="`Weighed amount for ${rowName(row)}`"
                />
                <span class="unit">g</span>
              </span>
            </td>
            <td
              class="num"
              :class="{ down: (deltaOf(row) ?? 0) < 0, up: (deltaOf(row) ?? 0) > 0 }"
            >
              <template v-if="deltaOf(row) === null || deltaOf(row) === 0">—</template>
              <template v-else-if="(deltaOf(row) ?? 0) < 0">−{{ grams(deltaOf(row)!) }}</template>
              <template v-else>+{{ grams(deltaOf(row)!) }}</template>
            </td>
            <td class="num down">{{ money(valueOf(row)) }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="5" class="empty">This store holds no weight-tracked stock.</td>
          </tr>
        </tbody>
        <tfoot v-if="changed.length > 0">
          <tr>
            <td colspan="3" class="num tlabel">
              {{ changed.length }} {{ changed.length === 1 ? 'strain differs' : 'strains differ' }}
            </td>
            <td class="num" :class="{ down: totalDelta < 0, up: totalDelta > 0 }">
              {{ totalDelta < 0 ? '−' : '+' }}{{ grams(totalDelta) }}
            </td>
            <td class="num down">{{ money(totalValue) }}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="why">
      <div class="field">
        <label>Reason</label>
        <div class="chips">
          <button
            v-for="reason in ADJUSTMENT_REASONS"
            :key="reason.code"
            type="button"
            class="chip"
            :class="{ on: reasonCode === reason.code }"
            :aria-pressed="reasonCode === reason.code"
            @click="reasonCode = reason.code"
          >
            {{ reason.label }}
          </button>
        </div>
      </div>
      <div class="field">
        <label for="r-note">Note</label>
        <Textarea id="r-note" v-model="note" rows="2" auto-resize placeholder="Optional" />
      </div>
    </div>

    <p class="caveat">
      A blank field is skipped, not counted as zero. Only the strains you weighed are written,
      and each one posts a movement that cannot be undone — the ledger is append-only.
      A shortfall is written off at this store's average cost.
    </p>

    <div class="foot">
      <span class="hint">
        {{ changed.length === 0 ? 'Nothing to post yet.' : `${changed.length} to post.` }}
      </span>
      <span class="sp" />
      <Button
        label="Post reconciliation"
        size="small"
        :disabled="!canPost"
        :loading="saving"
        @click="post"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
  </section>
</template>

<style scoped>
.reconcile {
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
  gap: 0.75rem;
  flex-wrap: wrap;
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

.sel:focus-visible,
.chip:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.tablewrap {
  overflow-x: auto;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
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

.down {
  color: var(--p-red-600);
}

.up {
  color: var(--p-primary-color);
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
  gap: 0.2rem;
}

.unit {
  color: var(--p-text-muted-color);
  font-size: 0.8125rem;
}

.amt {
  width: 5.5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.amt.bad {
  border-color: var(--p-red-600);
}

.empty {
  text-align: center;
  color: var(--p-text-muted-color);
}

.why {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
  padding: 0.9rem 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

@container content (max-width: 800px) {
  .why {
    grid-template-columns: 1fr;
  }
}

.field {
  display: grid;
  gap: 0.35rem;
  align-content: start;
}

label {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.chips {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
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
}

.sp {
  flex: 1;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
</style>
