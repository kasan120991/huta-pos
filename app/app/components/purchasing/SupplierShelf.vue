<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { BaseQuantity, TrackingMode } from '@huta/shared'
import { formatGrams, formatQuantity } from '@huta/shared'
import type { ShelfRow } from '~/composables/usePurchaseOrderDraft'
import { parseQty, unitOf } from '~/lib/purchase-order-lines'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Spinner } from '~/components/ui/spinner'
import { PackageSearch } from '@lucide/vue'
import { cn } from '~/lib/utils'

/**
 * The supplier's shelf — every product they sell, with your stock position beside it and a
 * quantity box on each row.
 *
 * The screen answers "what do I need to order?" rather than only recording an answer you
 * arrived at elsewhere, which is why on-hand and the reorder threshold sit on the row.
 *
 * ⚠️ Every box opens BLANK. `qtySeed` gives a deliberately added line a `1`, but a rendered
 * shelf row is not a line yet — seeding 41 boxes would mean "order one of everything".
 */

const props = defineProps<{
  rows: readonly ShelfRow[]
  qty: Record<string, string>
  supplierId: string
  loading?: boolean
  class?: HTMLAttributes['class']
}>()

const emit = defineEmits<{ remove: [variantId: string] }>()

/**
 * ONE column template, named once and shared by the header and every row, so the two cannot
 * drift a column apart. (`register/transfers.vue` learned this the hard way.)
 */
const columns = 'grid-cols-[minmax(0,1fr)_64px_78px_92px]'

const qty = (base: number, mode: TrackingMode) => formatQuantity(base as BaseQuantity, mode)

/** Grouped by category, orphans in their own group pinned to the top. */
const groups = computed(() => {
  const out: Array<{ key: string, label: string, orphan: boolean, rows: ShelfRow[] }> = []
  for (const row of props.rows) {
    const label = row.orphan ? 'Not on this supplier’s list' : row.categoryName || 'Uncategorised'
    const key = row.orphan ? '__orphan' : label
    const last = out[out.length - 1]
    if (last && last.key === key) last.rows.push(row)
    else out.push({ key, label, orphan: row.orphan, rows: [row] })
  }
  return out
})

const isKeyed = (row: ShelfRow) => parseQty(props.qty[row.variantId], row.trackingMode) !== null
const isBad = (row: ShelfRow) => {
  const raw = (props.qty[row.variantId] ?? '').trim()
  return raw !== '' && parseQty(raw, row.trackingMode) === null
}
/** Below reorder is only knowable where a threshold exists — null means only OUT is knowable. */
const isLow = (row: ShelfRow) =>
  row.reorderBase !== null && row.reorderBase > 0 && row.onHandBase <= row.reorderBase

function fillSuggested(row: ShelfRow) {
  if (row.suggestedBase <= 0) return
  props.qty[row.variantId] =
    row.trackingMode === 'WEIGHT'
      ? formatGrams(row.suggestedBase as BaseQuantity, { suffix: false })
      : String(row.suggestedBase)
}
</script>

<template>
  <div :class="cn('overflow-hidden rounded-xl border bg-card', props.class)">
    <div
      class="grid items-center gap-3 border-b bg-background/40 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
      :class="columns"
    >
      <span>Item</span>
      <span class="text-right">On hand</span>
      <span class="text-right">Suggested</span>
      <span class="text-right">Order</span>
    </div>

    <div v-if="loading" class="flex items-center justify-center gap-2 px-3 py-10 text-sm text-muted-foreground">
      <Spinner aria-hidden="true" />
      Loading this supplier’s products…
    </div>

    <Empty v-else-if="!rows.length" class="flex-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><PackageSearch /></EmptyMedia>
        <EmptyTitle>Nothing on this shelf</EmptyTitle>
        <EmptyDescription>
          No products are filed under this supplier yet. Use “Search all products” to order
          anything else.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <template v-for="group in groups" :key="group.key">
      <div
        class="flex items-center gap-2 border-b px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.11em]"
        :class="group.orphan ? 'bg-amber-500/10 text-amber-500' : 'bg-background/60 text-muted-foreground'"
      >
        {{ group.label }}
        <span class="font-medium normal-case tracking-normal opacity-70">
          {{ group.rows.length }} {{ group.rows.length === 1 ? 'product' : 'products' }}
        </span>
        <span v-if="group.orphan" class="ml-auto font-medium normal-case tracking-normal">
          Still ordered — remove a row to drop it
        </span>
      </div>

      <div
        v-for="row in group.rows"
        :key="row.variantId"
        class="grid items-center gap-3 border-b px-3 py-2 last:border-b-0"
        :class="[
          columns,
          isKeyed(row) ? 'bg-primary/[0.06]' : isLow(row) && !row.orphan ? 'bg-amber-500/[0.06]' : '',
        ]"
      >
        <div class="min-w-0">
          <span class="block truncate text-sm font-medium">{{ row.name }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ row.sku }}</span>
        </div>

        <span
          v-if="!row.orphan"
          class="text-right text-sm tabular-nums"
          :class="row.onHandBase <= 0 ? 'text-amber-500' : 'text-foreground'"
        >{{ qty(row.onHandBase, row.trackingMode) }}</span>
        <span v-else class="text-right text-sm text-muted-foreground">—</span>

        <div class="text-right">
          <button
            v-if="row.suggestedBase > 0"
            type="button"
            class="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :class="isKeyed(row) ? 'text-primary' : ''"
            @click="fillSuggested(row)"
          >
            Suggest {{ qty(row.suggestedBase, row.trackingMode) }}
          </button>
          <span v-else class="text-xs text-muted-foreground">—</span>
        </div>

        <div class="flex items-center justify-end gap-1">
          <InputGroup
            class="h-8 w-[76px]"
            :class="isBad(row) ? 'border-red-400/60' : isKeyed(row) ? 'border-primary/50' : ''"
          >
            <InputGroupInput
              v-model="props.qty[row.variantId]"
              :inputmode="row.trackingMode === 'WEIGHT' ? 'decimal' : 'numeric'"
              autocomplete="off"
              class="text-sm tabular-nums"
              :aria-label="`Order quantity of ${row.name}`"
            />
            <InputGroupAddon align="inline-end" class="text-xs">{{ unitOf(row.trackingMode) }}</InputGroupAddon>
          </InputGroup>
          <button
            v-if="row.orphan"
            type="button"
            class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :aria-label="`Remove ${row.name} from this order`"
            @click="emit('remove', row.variantId)"
          >
            ✕
          </button>
        </div>
        </div>
      </template>
    </template>
  </div>
</template>
