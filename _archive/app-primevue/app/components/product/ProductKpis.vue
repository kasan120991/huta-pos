<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, unsafe } from '@huta/shared'
import type { CatalogProductDetail, ProductInsights } from '@huta/shared/schemas'
import { computed } from 'vue'

/**
 * The KPI strip. On hand is for everyone; everything else is cost-derived and renders only
 * when the insights payload arrived — staff never see the cells, not empty cells.
 */
const props = defineProps<{
  product: CatalogProductDetail
  insights: ProductInsights | null
}>()

/**
 * On hand, honouring the tracking-mode rule: quantities only sum within a mode, so a
 * product mixing gummies and grams shows both figures rather than a nonsense total.
 */
const onHand = computed(() => {
  const stock = props.product.stock
  if (stock.trackingMode !== null && stock.quantityBase !== null) {
    return formatQuantity(unsafe.baseQuantity(stock.quantityBase), stock.trackingMode)
  }
  const byMode = new Map<TrackingMode, number>()
  for (const variant of props.product.variants) {
    byMode.set(
      variant.trackingMode,
      (byMode.get(variant.trackingMode) ?? 0) + variant.stock.quantityBase,
    )
  }
  return [...byMode.entries()]
    .map(([mode, total]) => formatQuantity(unsafe.baseQuantity(total), mode))
    .join(' + ')
})

const storesNote = computed(() => {
  const n = props.product.stores.length
  return n === 1 ? (props.product.stores[0]?.name ?? '') : `${n} stores`
})

const value = computed(() => {
  if (!props.insights) return null
  return props.insights.valueAtCostCents === null
    ? 'unknown'
    : formatCents(unsafe.cents(props.insights.valueAtCostCents))
})

const margin = computed(() => {
  if (!props.insights) return null
  return props.insights.marginBps === null
    ? '—'
    : `${(props.insights.marginBps / 100).toFixed(1)}%`
})

const loss = computed(() => {
  const rate = props.insights?.lossRate90d
  if (rate === undefined || rate === null) return null
  return rate.lossRateBps === null ? '—' : `${(rate.lossRateBps / 100).toFixed(2)}%`
})
</script>

<template>
  <div class="kpis">
    <div class="kpi">
      <div class="k">On hand</div>
      <div class="v">{{ onHand }}<small>{{ storesNote }}</small></div>
    </div>
    <div v-if="value !== null" class="kpi">
      <div class="k">Value at cost</div>
      <div class="v" :class="{ dim: value === 'unknown' }">{{ value }}</div>
    </div>
    <div v-if="margin !== null" class="kpi">
      <div class="k">Margin</div>
      <div class="v" :class="{ dim: margin === '—' }">{{ margin }}</div>
    </div>
    <div v-if="loss !== null" class="kpi">
      <div class="k">Loss rate · 90d</div>
      <div class="v" :class="{ dim: loss === '—' }">{{ loss }}</div>
    </div>
  </div>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem;
}

.kpi {
  padding: 0.6rem 0.85rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.k {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.v {
  margin-top: 0.1rem;
  font-size: 1.15rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}

.v small {
  margin-left: 0.35rem;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--p-text-muted-color);
}

.v.dim {
  color: var(--p-text-muted-color);
  font-weight: 500;
}
</style>
