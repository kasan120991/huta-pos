<script setup lang="ts">
import { STOCK_STATUS_LABELS, type StockStatus } from '@huta/shared'

/**
 * Stock status as a shape, not just a number.
 *
 * The status is resolved server-side and rendered here verbatim — this component has no
 * threshold logic of its own, because the threshold falls back through the product's
 * category and a bare quantity carries no unit. That is precisely what the old cell got
 * wrong: it compared milligrams against a hardcoded `3`.
 *
 * `OK` renders nothing. A badge on every healthy row is noise, and the point of the pill
 * is that the eye finds the rows that need attention without reading digits.
 */
const props = defineProps<{
  status: StockStatus
  /** Shown on LOW so "why is this amber" has an answer on screen, not in a tooltip. */
  reorderBase?: number | null
  label?: string | null
}>()
</script>

<template>
  <span
    v-if="props.status !== 'OK'"
    class="pill"
    :class="props.status.toLowerCase()"
  >
    {{ props.label || STOCK_STATUS_LABELS[props.status] }}
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  padding: 0.08rem 0.4rem;
  border-radius: 3px;
  font-size: 0.6875rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.out {
  background: color-mix(in srgb, var(--p-red-500) 14%, transparent);
  color: var(--p-red-700);
}

.low {
  background: color-mix(in srgb, var(--p-amber-500) 18%, transparent);
  color: var(--p-amber-700);
}

.app-dark .out {
  color: var(--p-red-300);
}

.app-dark .low {
  color: var(--p-amber-300);
}
</style>
