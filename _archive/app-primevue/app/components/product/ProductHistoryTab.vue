<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, unsafe } from '@huta/shared'
import type { CatalogProductDetail, CatalogVariant, MovementRow } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * The movement ledger — what an investigation reads to answer "why is this at zero".
 *
 * Movements are per VARIANT, so a multi-variant product picks one with chips; most
 * products have a single variant and see their ledger immediately. Cost columns render
 * off key presence, the same optional-key contract as everywhere else.
 */
const props = defineProps<{
  product: CatalogProductDetail
  storeId: string | null
}>()

const catalog = useCatalogStore()

const selectedId = ref<string | null>(props.product.variants[0]?.id ?? null)
const rows = ref<MovementRow[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const expanded = ref(false)

const VISIBLE = 15

const selectedVariant = computed<CatalogVariant | null>(
  () => props.product.variants.find((v) => v.id === selectedId.value) ?? null,
)

const visibleRows = computed(() => (expanded.value ? rows.value : rows.value.slice(0, VISIBLE)))

const showCost = computed(() => rows.value.some((r) => r.unitCostCents !== undefined))

async function load(): Promise<void> {
  if (selectedId.value === null) return
  loading.value = true
  error.value = null
  try {
    rows.value = await catalog.getMovements(selectedId.value, props.storeId)
  } catch (err) {
    rows.value = []
    error.value = err instanceof ApiError ? err.message : 'Could not load the movement history.'
  } finally {
    loading.value = false
  }
}

watch([selectedId, () => props.storeId], () => void load(), { immediate: true })

const TYPE_SEVERITY: Record<string, 'success' | 'info' | 'warn' | 'danger'> = {
  RECEIVE: 'success',
  RETURN: 'success',
  TRANSFER_IN: 'info',
  TRANSFER_OUT: 'info',
  SALE: 'info',
  ADJUSTMENT: 'warn',
  SHRINKAGE: 'danger',
}

function typeLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function qty(base: number, mode: TrackingMode): string {
  return formatQuantity(unsafe.baseQuantity(base), mode)
}

function delta(base: number, mode: TrackingMode): string {
  const magnitude = qty(Math.abs(base), mode)
  return base < 0 ? `−${magnitude}` : `+${magnitude}`
}
</script>

<template>
  <div class="history">
    <div v-if="product.variants.length > 1" class="picker" role="group" aria-label="Variant">
      <button
        v-for="variant in product.variants"
        :key="variant.id"
        type="button"
        class="vchip"
        :class="{ on: variant.id === selectedId }"
        :aria-pressed="variant.id === selectedId"
        @click="selectedId = variant.id"
      >
        {{ variant.label ?? variant.sku }}
      </button>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-else class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Type</th>
            <th>Store</th>
            <th class="num">Change</th>
            <th class="num">Balance</th>
            <th v-if="showCost" class="num">Unit cost</th>
            <th>Who</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0 && !loading">
            <td class="empty" colspan="8">No movements recorded yet.</td>
          </tr>
          <tr v-for="row in visibleRows" :key="row.id">
            <td class="muted nowrap">{{ when(row.createdAt) }}</td>
            <td class="nowrap">
              <Tag :severity="TYPE_SEVERITY[row.type] ?? 'info'" :value="typeLabel(row.type)" />
              <span v-if="row.reasonCode" class="reason">{{ row.reasonCode }}</span>
            </td>
            <td>{{ row.storeName }}</td>
            <td
              class="num"
              :class="{ neg: row.quantityBase < 0, pos: row.quantityBase > 0 }"
            >
              <template v-if="selectedVariant">
                {{ delta(row.quantityBase, selectedVariant.trackingMode) }}
              </template>
            </td>
            <td class="num">
              <template v-if="selectedVariant">
                {{ qty(row.balanceAfterBase, selectedVariant.trackingMode) }}
              </template>
            </td>
            <td v-if="showCost" class="num">
              <template v-if="row.unitCostCents != null">
                {{ formatCents(unsafe.cents(row.unitCostCents)) }}
              </template>
              <EmptyValue v-else label="—" />
            </td>
            <td class="muted">
              <template v-if="row.userName">{{ row.userName }}</template>
              <EmptyValue v-else label="—" />
            </td>
            <td class="note">{{ row.note ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="veil" aria-live="polite">Loading…</div>
    </div>

    <button
      v-if="rows.length > VISIBLE && !expanded"
      type="button"
      class="more"
      @click="expanded = true"
    >
      Show all {{ rows.length }} movements
    </button>
    <p v-else-if="rows.length > 0" class="cap">
      The most recent {{ rows.length }} movements{{ storeId ? ' at this store' : '' }}.
    </p>
  </div>
</template>

<style scoped>
.history {
  display: grid;
  gap: 0.6rem;
  position: relative;
}

.picker {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.vchip {
  padding: 0.2rem 0.6rem;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 560;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 2rem;
  cursor: pointer;
}

.vchip.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
  font-weight: 620;
}

.vchip:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.tablewrap {
  position: relative;
  overflow-x: auto;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  text-align: left;
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  font-weight: 650;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}

td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: 0.8125rem;
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: 0;
}

th.num,
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.nowrap {
  white-space: nowrap;
}

.muted {
  color: var(--p-text-muted-color);
}

.reason {
  margin-left: 0.35rem;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

td.neg {
  color: var(--p-red-500);
}

td.pos {
  color: var(--p-primary-color);
}

td.note {
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

td.empty {
  padding: 1.5rem 0.6rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 2.5rem;
  background: color-mix(in srgb, var(--p-content-background) 65%, transparent);
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.more {
  justify-self: start;
  padding: 0;
  font: inherit;
  font-size: 0.75rem;
  color: var(--p-primary-color);
  font-weight: 620;
  background: none;
  border: 0;
  cursor: pointer;
}

.more:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.cap {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}
</style>
