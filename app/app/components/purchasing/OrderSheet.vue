<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatQuantity, receiptLineValueCents } from '@huta/shared'
import type { ShelfRow } from '~/composables/usePurchaseOrderDraft'
import { parseUnitCost, unitOf } from '~/lib/purchase-order-lines'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'

/**
 * What is actually being ordered — the keyed rows, and only those.
 *
 * Bound to the SAME maps the shelf writes, so there is nothing to add and nothing to sync:
 * a row appears here the moment its quantity parses and vanishes when it is cleared.
 *
 * Cost lives here rather than on the shelf. Left is "how many", right is "what it costs",
 * which keeps the shelf rows narrow enough to survive a 1280px window with the sidebar out.
 */

const props = defineProps<{
  lines: ReadonlyArray<{ row: ShelfRow, base: number }>
  cost: Record<string, string>
  valueCents: number | null
  class?: HTMLAttributes['class']
}>()

const emit = defineEmits<{ remove: [variantId: string], touchCost: [variantId: string] }>()

const qty = (base: number, mode: TrackingMode) => formatQuantity(base as BaseQuantity, mode)
const money = (cents: number | null) => (cents == null ? '—' : formatCents(cents as Cents))

const badCost = (variantId: string) => parseUnitCost(props.cost[variantId]) === 'invalid'

/**
 * The line's value, from the ALREADY-PARSED base rather than re-parsing the box — same
 * `receiptLineValueCents` the server runs, so the figure here cannot disagree with the order.
 */
function lineValue(entry: { row: ShelfRow, base: number }): number | null {
  const unit = parseUnitCost(props.cost[entry.row.variantId])
  if (unit === null || unit === 'invalid') return null
  return receiptLineValueCents(entry.row.trackingMode, entry.base as BaseQuantity, unit as Cents)
}

const uncosted = computed(() => props.lines.filter((l) => (props.cost[l.row.variantId] ?? '').trim() === '').length)
</script>

<template>
  <div :class="cn('overflow-hidden rounded-xl border bg-card', props.class)">
    <div class="flex items-center gap-2 border-b bg-background/40 px-3 py-2">
      <span class="text-sm font-semibold">This order</span>
      <Badge variant="secondary" class="h-5 px-1.5 text-xs">
        {{ lines.length }} {{ lines.length === 1 ? 'line' : 'lines' }}
      </Badge>
    </div>

    <p v-if="!lines.length" class="px-3 py-8 text-center text-sm text-muted-foreground">
      Key a quantity on the left and it appears here.
    </p>

    <template v-else>
      <div v-for="entry in lines" :key="entry.row.variantId" class="border-b px-3 py-2.5 last:border-b-0">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ entry.row.name }}</span>
          <span class="text-xs text-muted-foreground">
            {{ qty(entry.base, entry.row.trackingMode) }}
            <template v-if="entry.row.orphan"> · <span class="text-amber-500">not this supplier’s</span></template>
          </span>
        </div>
        <button
          type="button"
          class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :aria-label="`Remove ${entry.row.name} from this order`"
          @click="emit('remove', entry.row.variantId)"
        >
          ✕
        </button>
      </div>

      <div class="mt-1.5 flex items-center gap-2">
        <InputGroup
          class="h-8 w-28"
          :class="badCost(entry.row.variantId) ? 'border-red-400/60' : ''"
        >
          <InputGroupAddon class="text-xs">$</InputGroupAddon>
          <InputGroupInput
            v-model="props.cost[entry.row.variantId]"
            inputmode="decimal"
            autocomplete="off"
            class="text-sm tabular-nums"
            :aria-label="`Unit cost of ${entry.row.name}`"
            @input="emit('touchCost', entry.row.variantId)"
          />
          <InputGroupAddon align="inline-end" class="text-xs">/{{ unitOf(entry.row.trackingMode) }}</InputGroupAddon>
        </InputGroup>
        <span class="ml-auto text-sm font-medium tabular-nums">{{ money(lineValue(entry)) }}</span>
        </div>
      </div>
    </template>

    <div v-if="lines.length" class="flex items-baseline gap-2 border-t px-3 py-2.5">
      <span class="text-xs text-muted-foreground">Order value</span>
      <span class="ml-auto text-base font-bold tabular-nums">{{ money(valueCents) }}</span>
    </div>

    <!--
      Uncosted lines are legal — the server takes unitCostCents as optional and an uncosted
      delivery lands in the receiving desk's costing queue. Said plainly rather than blocked.
    -->
    <p v-if="uncosted" class="border-t px-3 py-2 text-xs text-muted-foreground">
      {{ uncosted }} {{ uncosted === 1 ? 'line has' : 'lines have' }} no cost yet — that’s allowed,
      and it lands in the costing queue when the delivery arrives.
    </p>

    <div v-if="$slots.actions" class="border-t p-3">
      <slot name="actions" />
    </div>
  </div>
</template>
