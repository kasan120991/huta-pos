<script setup lang="ts">
import type { CatalogProduct, CatalogVariant } from '@huta/shared/schemas'
import type { BaseQuantity, Cents } from '@huta/shared'
import { formatCents, formatQuantity } from '@huta/shared'
import { ChevronRight } from '@lucide/vue'
import { Badge } from '~/components/ui/badge'

const props = defineProps<{ product: CatalogProduct }>()
const emit = defineEmits<{ open: [] }>()

const expanded = ref(false)
const imageFailed = ref(false)

const initial = computed(() => props.product.name.charAt(0).toUpperCase())

/** First cannabinoid as a potency chip: "THCa 24.5%" or "Delta-8 25mg". */
const potency = computed(() => {
  const link = props.product.cannabinoids[0]
  if (!link) return null
  if (link.percentBps !== null) return `${link.cannabinoid.name} ${(link.percentBps / 100).toFixed(1)}%`
  if (link.mgPerUnit !== null) return `${link.cannabinoid.name} ${link.mgPerUnit}mg`
  return link.cannabinoid.name
})

const extraCannabinoids = computed(() =>
  props.product.cannabinoids.slice(1, 3).map((l) => l.cannabinoid.name),
)

/**
 * Display-only price summary: a WEIGHT variant shows its group's base rate, EACH
 * variants a single price or range. Never used to compute a charge — the register asks
 * the server.
 */
const priceLabel = computed(() => {
  const weight = props.product.variants.find((v) => v.trackingMode === 'WEIGHT' && v.priceGroup)
  if (weight?.priceGroup) return `${formatCents(weight.priceGroup.basePricePerGramCents as Cents)}/g`
  const prices = props.product.variants
    .map((v) => v.priceCents)
    .filter((p): p is number => p !== null)
  if (prices.length === 0) return '—'
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  return min === max
    ? formatCents(min as Cents)
    : `${formatCents(min as Cents)}–${formatCents(max as Cents)}`
})

const stockLabel = computed(() => {
  const s = props.product.stock
  if (s.status === 'OUT') return 'Out of stock'
  if (s.quantityBase === null || s.trackingMode === null) return `${s.variantCount - s.outCount}/${s.variantCount} in stock`
  return formatQuantity(s.quantityBase as BaseQuantity, s.trackingMode)
})

const statusClass: Record<string, string> = {
  OK: 'bg-primary',
  LOW: 'bg-amber-500',
  OUT: 'bg-red-400',
}
const statusText: Record<string, string> = {
  OK: 'text-foreground',
  LOW: 'text-amber-500',
  OUT: 'text-red-400',
}

function variantStockLabel(v: CatalogVariant): string {
  if (v.stock.status === 'OUT') return 'Out'
  return formatQuantity(v.stock.quantityBase as BaseQuantity, v.trackingMode)
}

function variantPrice(v: CatalogVariant): string {
  if (v.trackingMode === 'WEIGHT' && v.priceGroup)
    return `${formatCents(v.priceGroup.basePricePerGramCents as Cents)}/g`
  return v.priceCents !== null ? formatCents(v.priceCents as Cents) : '—'
}
</script>

<template>
  <div class="border-b border-border/50 last:border-b-0">
    <!--
      The row itself is a pointer convenience; the accessible control is the product-name
      button inside it. A role="button" row would nest the chevron button inside another
      button, which is invalid ARIA.
    -->
    <div
      class="grid cursor-pointer grid-cols-[24px_40px_minmax(0,1fr)_110px_90px_110px_130px_80px] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40 has-[button.rowname:focus-visible]:bg-accent/40"
      @click="emit('open')"
    >
      <button
        type="button"
        class="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${product.variants.length} variants`"
        @click.stop="expanded = !expanded"
      >
        <ChevronRight class="size-4 transition-transform" :class="expanded ? 'rotate-90' : ''" />
      </button>

      <div class="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-sm font-semibold text-primary">
        <img
          v-if="product.imageUrl && !imageFailed"
          :src="product.imageUrl"
          alt=""
          class="size-full object-cover"
          @error="imageFailed = true"
        >
        <span v-else>{{ initial }}</span>
      </div>

      <div class="min-w-0">
        <button
          type="button"
          class="rowname block max-w-full truncate rounded text-left text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          :aria-label="`Open ${product.name}`"
          @click.stop="emit('open')"
        >
          {{ product.name }}
        </button>
        <div class="mt-0.5 flex flex-wrap items-center gap-1">
          <span v-if="product.brand" class="rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">{{ product.brand.name }}</span>
          <span v-if="potency" class="rounded-full border border-primary/35 px-1.5 text-[11px] text-primary">{{ potency }}</span>
          <span v-for="name in extraCannabinoids" :key="name" class="rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">{{ name }}</span>
        </div>
      </div>

      <div class="truncate text-sm text-muted-foreground">{{ product.category.name }}</div>

      <div class="text-sm">
        <span class="rounded-md border border-input px-2 py-0.5 tabular-nums">{{ product.variants.length }}</span>
        <span class="ml-1 text-xs text-muted-foreground">{{ product.stock.trackingMode === 'WEIGHT' ? 'weight' : 'each' }}</span>
      </div>

      <div class="text-sm tabular-nums">{{ priceLabel }}</div>

      <div class="flex items-center gap-1.5 text-sm" :class="statusText[product.stock.status]">
        <span class="size-1.5 rounded-full" :class="statusClass[product.stock.status]" />
        <span class="tabular-nums">{{ stockLabel }}</span>
      </div>

      <div>
        <Badge
          v-if="product.active"
          class="border-transparent bg-primary/10 text-primary"
        >
          Active
        </Badge>
        <Badge v-else variant="secondary">Inactive</Badge>
      </div>
    </div>

    <div v-if="expanded" class="bg-accent/20 px-3 pb-2">
      <div
        v-for="v in product.variants"
        :key="v.id"
        class="grid grid-cols-[24px_40px_minmax(0,1fr)_110px_90px_110px_130px_80px] items-center gap-3 py-1.5 text-sm"
      >
        <span />
        <span />
        <div class="min-w-0">
          <span class="font-medium">{{ v.label ?? product.name }}</span>
          <span class="ml-2 font-mono text-xs text-muted-foreground">{{ v.sku }}</span>
          <span v-if="!v.active" class="ml-2 text-xs text-muted-foreground">(inactive)</span>
        </div>
        <span />
        <span />
        <span class="tabular-nums">{{ variantPrice(v) }}</span>
        <div class="flex items-center gap-1.5" :class="statusText[v.stock.status]">
          <span class="size-1.5 rounded-full" :class="statusClass[v.stock.status]" />
          <span class="tabular-nums">{{ variantStockLabel(v) }}</span>
        </div>
        <span />
      </div>
    </div>
  </div>
</template>
