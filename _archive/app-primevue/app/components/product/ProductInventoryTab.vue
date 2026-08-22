<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, unsafe } from '@huta/shared'
import type {
  CatalogProductDetail,
  CatalogVariant,
  ProductInsights,
  StockLevelRow,
  WeightVarianceRow,
} from '@huta/shared/schemas'
import { computed } from 'vue'

/**
 * Inventory: per-store levels with the adjust entry point, and weight variance per WEIGHT
 * variant — every one of them, not just the first, which is what the old page showed.
 *
 * Admin columns (avg cost, basis value) come from the insights payload; the levels rows in
 * the detail payload deliberately carry none of that.
 */
const props = defineProps<{
  product: CatalogProductDetail
  insights: ProductInsights | null
}>()

const emit = defineEmits<{
  adjust: [variant: CatalogVariant, storeId: string, storeName: string]
}>()

const insightByVariant = computed(() => {
  const map = new Map<string, { levels: readonly StockLevelRow[]; variance?: readonly WeightVarianceRow[] }>()
  for (const row of props.insights?.variants ?? []) {
    map.set(row.variantId, { levels: row.levels, ...(row.variance ? { variance: row.variance } : {}) })
  }
  return map
})

const showCostColumns = computed(() =>
  (props.insights?.variants ?? []).some((v) => v.levels.some((l) => l.costBasisCents !== undefined)),
)

interface LevelRow {
  storeId: string
  storeName: string
  quantityBase: number
  reorderPointBase: number | null
  avgUnitCostCents: number | null | undefined
  costBasisCents: number | null | undefined
}

/**
 * Store rows for one variant. Insights rows carry names, reorder points and cost; without
 * insights (staff), fall back to the payload's per-store quantities and the product's
 * `stores` list for names.
 */
function levelsFor(variant: CatalogVariant): LevelRow[] {
  const fromInsights = insightByVariant.value.get(variant.id)?.levels
  if (fromInsights) {
    return fromInsights.map((l) => ({
      storeId: l.storeId,
      storeName: l.storeName,
      quantityBase: l.quantityBase,
      reorderPointBase: l.reorderPointBase,
      avgUnitCostCents: l.avgUnitCostCents,
      costBasisCents: l.costBasisCents,
    }))
  }
  return props.product.stores.map((store) => ({
    storeId: store.id,
    storeName: store.name,
    quantityBase:
      variant.stock.byStore.find((s) => s.storeId === store.id)?.quantityBase ?? 0,
    reorderPointBase:
      variant.stockLevels.find((s) => s.storeId === store.id)?.reorderPointBase ?? null,
    avgUnitCostCents: undefined,
    costBasisCents: undefined,
  }))
}

function varianceFor(variant: CatalogVariant): readonly WeightVarianceRow[] | null {
  const rows = insightByVariant.value.get(variant.id)?.variance
  if (!rows) return null
  return rows
}

function qty(base: number, mode: TrackingMode): string {
  return formatQuantity(unsafe.baseQuantity(base), mode)
}

function money(cents: number | null | undefined, perGram: boolean): string {
  if (cents === null || cents === undefined) return '—'
  return perGram
    ? `${formatCents(unsafe.cents(cents))}/g`
    : formatCents(unsafe.cents(cents))
}
</script>

<template>
  <div class="inventory">
    <section v-for="variant in product.variants" :key="variant.id" class="vblock">
      <div class="vhead">
        <span class="vname">{{ variant.label ?? 'Standard' }}</span>
        <span class="sku">{{ variant.sku }}</span>
        <Tag v-if="!variant.active" severity="warn" value="Inactive" />
        <StockPill :status="variant.stock.status" />
      </div>

      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th class="num">On hand</th>
              <th class="num">Reorder at</th>
              <th v-if="showCostColumns" class="num">Avg cost</th>
              <th v-if="showCostColumns" class="num">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="level in levelsFor(variant)" :key="level.storeId">
              <td>{{ level.storeName }}</td>
              <td class="num" :class="{ zero: level.quantityBase === 0 }">
                <button
                  type="button"
                  class="qtybtn"
                  :aria-label="`Adjust ${variant.label ?? 'Standard'} at ${level.storeName}`"
                  @click="emit('adjust', variant, level.storeId, level.storeName)"
                >
                  {{ qty(level.quantityBase, variant.trackingMode) }}
                </button>
              </td>
              <td class="num muted">
                <template v-if="level.reorderPointBase !== null">
                  {{ qty(level.reorderPointBase, variant.trackingMode) }}
                </template>
                <EmptyValue v-else label="—" />
              </td>
              <td v-if="showCostColumns" class="num">
                {{ money(level.avgUnitCostCents, variant.trackingMode === TrackingMode.WEIGHT) }}
              </td>
              <td v-if="showCostColumns" class="num">
                {{ money(level.costBasisCents, false) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="varianceFor(variant)">
        <div class="varhead">
          <span class="k">Weight variance</span>
          <span class="vsub">last 90 days</span>
        </div>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th class="num">Received</th>
                <th class="num">Lost</th>
                <th class="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in varianceFor(variant) ?? []" :key="row.storeId">
                <td>{{ row.storeName }}</td>
                <td class="num">{{ qty(row.receivedBase, TrackingMode.WEIGHT) }}</td>
                <td class="num">{{ qty(row.lostBase, TrackingMode.WEIGHT) }}</td>
                <td class="num">
                  <span v-if="row.lossRateBps === null" class="muted">No stock received</span>
                  <span v-else class="rate" :class="{ high: row.lossRateBps > 300 }">
                    {{ (row.lossRateBps / 100).toFixed(2) }}%
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="vnote">
          Flower loses moisture and keyed gram sales accumulate drift, so some loss is
          normal. A strain losing far more than its peers is what is worth a look.
        </p>
      </template>
    </section>

    <p class="hint">Click a store's quantity to adjust it.</p>
  </div>
</template>

<style scoped>
.inventory {
  display: grid;
  gap: 1.25rem;
}

.vblock {
  display: grid;
  gap: 0.6rem;
}

.vhead {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.vname {
  font-weight: 600;
  font-size: 0.9375rem;
}

.sku {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
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

.muted,
td.zero .qtybtn {
  color: var(--p-text-muted-color);
}

.qtybtn {
  font: inherit;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  color: inherit;
  background: none;
  border: 0;
  border-bottom: 1px dashed var(--p-content-border-color);
  padding: 0.05rem 0.15rem;
  cursor: pointer;
  border-radius: 0.2rem;
}

.qtybtn:hover {
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
  color: var(--p-primary-color);
  border-bottom-color: transparent;
}

.qtybtn:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.varhead {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.k {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.vsub {
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

.rate {
  font-weight: 620;
}

/* Above 3% is where a strain starts to look unlike its peers rather than like moisture. */
.rate.high {
  color: var(--p-amber-600, #b45309);
}

.vnote,
.hint {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}
</style>
