<script setup lang="ts">
import type {
  CatalogProductDetail,
  CatalogVariant,
  ProductInsights,
} from '@huta/shared/schemas'
import type { BaseQuantity, Cents } from '@huta/shared'
import { formatCents, formatQuantity } from '@huta/shared'
import { Spinner } from '~/components/ui/spinner'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { apiFetch } from '~/composables/useApi'
import { quantityWithUnit } from '~/lib/sale-format'
import { useAuthStore } from '~/stores/auth'

/**
 * The catalog slide-over (Kasan's A pick, 2026-08-22) — stock and value first.
 *
 * It used to restate the row you clicked: name, category, brand, supplier, a variant list, and
 * a link to the real page. Driving it against the live catalogue found four things, and the
 * redesign is shaped by them:
 *
 *   1. Flower printed `$10.00/g` — the base rate with NO ladder, so the eighth read as $35.00
 *      when it rings $30.00. The same money bug fixed on the register catalog on 2026-08-22.
 *   2. No cost anywhere, in the one surface where cost belongs and is already on the payload.
 *   3. Stock was a cross-store SUM with nothing saying so — 474.50g is Baytree's 474.50 plus
 *      Ashley's 77.00, and which store holds it is where a transfer decision starts.
 *   4. `variant.identity` shipped since 2026-08-21 and was read zero times, so the first strain
 *      given its own potency would still have shown the shelf's.
 *
 * It was also 65% empty, because it reserved room for a description and a COA that the
 * catalogue does not have: **2 descriptions and 0 COAs across 286 active products**. Those
 * blocks are still here and still last, but strictly conditional.
 *
 * NO SERVER WORK: per-store levels, the tier ladder and the resolved identity were all already
 * on `/catalog/products/:id`, and the per-store cost basis on the admin-only insights endpoint
 * the product workspace already uses.
 */
const props = defineProps<{
  productId: string | null
  storeId: string | undefined
  /** id → name for the stock rows. The page already holds these from /catalog/reference. */
  stores: ReadonlyArray<{ id: string, name: string }>
}>()
const emit = defineEmits<{ close: [] }>()

const auth = useAuthStore()

const detail = ref<CatalogProductDetail | null>(null)
const insights = ref<ProductInsights | null>(null)
const loading = ref(false)
const imageFailed = ref(false)

watch(
  () => props.productId,
  async (id) => {
    detail.value = null
    insights.value = null
    imageFailed.value = false
    if (!id) return
    loading.value = true
    try {
      detail.value = await apiFetch<CatalogProductDetail>(`/catalog/products/${id}`, {
        query: { storeId: props.storeId },
      })
      // Admin-only and non-essential: the endpoint is gated on `cost.view`, so the panel has
      // to render without it rather than treating a refusal as a failure. Same rule the
      // product workspace follows.
      if (auth.isAdmin) {
        try {
          insights.value = await apiFetch<ProductInsights>(
            `/catalog/products/${id}/insights`,
            { query: { storeId: props.storeId } },
          )
        } catch {
          insights.value = null
        }
      }
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

const storeName = (id: string) => props.stores.find((s) => s.id === id)?.name ?? 'Unknown store'

/**
 * Per-store rows for one variant, cost attached where it is known.
 *
 * Quantities come from the DETAIL payload, which is the authority on what is on hand; the
 * insights row only contributes money. A store with no cost basis renders an em dash — never
 * $0.00, which would be a claim that the stock was free (see the costing rules).
 */
function levelsFor(v: CatalogVariant) {
  const money = insights.value?.variants.find((x) => x.variantId === v.id)?.levels ?? []
  return v.stockLevels
    .filter((l) => l.quantityBase > 0)
    .map((l) => ({
      storeId: l.storeId,
      name: storeName(l.storeId),
      quantityBase: l.quantityBase,
      basisCents: money.find((m) => m.storeId === l.storeId)?.costBasisCents ?? null,
    }))
    .sort((a, b) => b.quantityBase - a.quantityBase)
}

/**
 * What a variant sells for, as a HEADLINE.
 *
 * A weight variant is prefixed "from" and points at the ladder below, because a per-gram rate
 * read alone and multiplied is exactly the mistake that misquoted an eighth by $5. An EACH
 * price is the whole answer and stands on its own.
 */
function variantPrice(v: CatalogVariant): string {
  if (v.trackingMode === 'WEIGHT' && v.priceGroup)
    return `from ${formatCents(v.priceGroup.basePricePerGramCents as Cents)}/g`
  return v.priceCents !== null ? formatCents(v.priceCents as Cents) : '—'
}

const qty = (base: number, mode: CatalogVariant['trackingMode']) =>
  formatQuantity(base as BaseQuantity, mode)

const statusClass: Record<string, string> = {
  OK: 'bg-primary',
  LOW: 'bg-amber-500',
  OUT: 'bg-red-400',
}

/**
 * The price ladder, from the FIRST weight variant's group — every strain on a shelf prices
 * through the same group, which is the whole reason the group exists. Rendered as the totals
 * an admin typed, never as a rate multiplied back: `extendTier` does not round-trip.
 */
const ladder = computed(() => {
  const group = detail.value?.variants.find((v) => v.trackingMode === 'WEIGHT')?.priceGroup
  if (!group) return null
  const rows = [
    { label: qty(1000, 'WEIGHT'), total: group.basePricePerGramCents },
    ...group.tiers.map((t) => ({
      label: qty(t.minQuantityBase, 'WEIGHT'),
      total: t.totalPriceCents,
    })),
  ]
  return { name: group.name, rows }
})

/**
 * Stock on hand whose cost nobody recorded — an honest gap, not a zero.
 *
 * ⚠️ Totalled PER TRACKING MODE, never across them. "Units sold" is meaningless across a gummy
 * and a gram, and the same is true here: 9 items plus 15 000 mg is not 15 009 of anything.
 * Nothing in the schema stops a product carrying both, so this groups rather than assuming.
 */
const uncosted = computed(() => {
  if (!detail.value || !insights.value) return []
  const byMode = new Map<CatalogVariant['trackingMode'], number>()
  for (const v of detail.value.variants) {
    const money = insights.value.variants.find((x) => x.variantId === v.id)?.levels ?? []
    for (const l of v.stockLevels) {
      if (l.quantityBase <= 0) continue
      const known = money.find((m) => m.storeId === l.storeId)?.costBasisCents
      if (known === null || known === undefined) {
        byMode.set(v.trackingMode, (byMode.get(v.trackingMode) ?? 0) + l.quantityBase)
      }
    }
  }
  return [...byMode.entries()].map(([mode, base]) => ({ mode, base }))
})

/**
 * Identity is read from the VARIANT's resolved block, never the product's raw columns.
 *
 * A single-variant product resolves everything to the product level anyway, so this costs
 * nothing there — but on flower it is the difference between showing a strain's own nose and
 * showing the shelf's. The panel describes the product, so it takes the first variant that
 * actually carries a value.
 */
function firstIdentity<K extends 'strainType' | 'terpeneProfile' | 'nose' | 'description' | 'coaUrl'>(
  key: K,
): string | null {
  for (const v of detail.value?.variants ?? []) {
    const value = v.identity?.[key]
    if (value) return value
  }
  return null
}

const attributes = computed(() => {
  if (!detail.value) return []
  const out: Array<{ k: string, v: string }> = []
  const strain = firstIdentity('strainType')
  const terps = firstIdentity('terpeneProfile')
  const nose = firstIdentity('nose')
  if (strain) out.push({ k: 'Strain', v: strain })
  if (terps) out.push({ k: 'Terpenes', v: terps })
  if (nose) out.push({ k: 'Nose', v: nose })
  return out
})

const description = computed(() => firstIdentity('description'))
const coaUrl = computed(() => firstIdentity('coaUrl'))

/** Null when the link records no potency — say so rather than rendering an empty chip. */
function potencyLabel(link: CatalogProductDetail['cannabinoids'][number]): string | null {
  if (link.percentBps !== null) return `${(link.percentBps / 100).toFixed(2)}%`
  if (link.mgPerUnit !== null) return `${link.mgPerUnit}mg`
  return null
}

const initial = computed(() => (detail.value?.name ?? '?').charAt(0).toUpperCase())
</script>

<template>
  <Sheet :open="productId !== null" @update:open="(open: boolean) => !open && emit('close')">
    <SheetContent
      side="right"
      class="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-md"
    >
      <!-- Fixed header: identity compressed to a strip, so the body is all answer. -->
      <SheetHeader class="shrink-0 space-y-0 border-b p-4 pr-12">
        <div class="flex items-start gap-3">
          <div
            v-if="detail?.imageUrl && !imageFailed"
            class="size-11 shrink-0 overflow-hidden rounded-lg border bg-accent/30"
          >
            <img :src="detail.imageUrl" :alt="detail.name" class="size-full object-cover" @error="imageFailed = true">
          </div>
          <div
            v-else
            class="flex size-11 shrink-0 items-center justify-center rounded-lg border border-dashed bg-accent/20 text-sm font-bold text-muted-foreground"
            aria-hidden="true"
          >
            {{ initial }}
          </div>

          <div class="min-w-0">
            <SheetTitle class="flex items-center gap-2 text-base leading-tight">
              <span class="truncate">{{ detail?.name ?? 'Loading…' }}</span>
              <Badge v-if="detail?.active" class="shrink-0 border-transparent bg-primary/10 text-primary">Active</Badge>
              <Badge v-else-if="detail" variant="secondary" class="shrink-0">Inactive</Badge>
            </SheetTitle>
            <SheetDescription class="text-xs">
              <template v-if="detail">
                {{ detail.category.parent ? `${detail.category.parent.name} › ` : '' }}{{ detail.category.name }}
                <template v-if="detail.brand"> · {{ detail.brand.name }}</template>
                <template v-if="detail.primarySupplier"> · {{ detail.primarySupplier.name }}</template>
              </template>
              <template v-else>Product preview</template>
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div v-if="detail" class="min-h-0 flex-1 overflow-y-auto p-4">
        <div class="flex flex-col gap-5">
          <!-- ————— where the stock actually is ————— -->
          <section>
            <h3 class="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              On hand
              <span v-if="detail.variants.length > 1">· {{ detail.variants.length }} variants</span>
            </h3>

            <div class="flex flex-col gap-2">
              <div v-for="v in detail.variants" :key="v.id" class="overflow-hidden rounded-lg border">
                <div class="flex items-center justify-between gap-2 bg-accent/30 px-3 py-2">
                  <span class="min-w-0 truncate text-sm font-semibold">
                    {{ v.label ?? detail.name }}
                    <span v-if="!v.active" class="text-xs font-normal text-muted-foreground">(inactive)</span>
                  </span>
                  <span class="shrink-0 text-sm font-semibold tabular-nums">{{ variantPrice(v) }}</span>
                </div>

                <div
                  v-for="lvl in levelsFor(v)"
                  :key="lvl.storeId"
                  class="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs"
                >
                  <span class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span class="size-1.5 shrink-0 rounded-full" :class="statusClass[v.stock.status]" />
                    <span class="truncate">{{ lvl.name }}</span>
                  </span>
                  <span class="shrink-0 tabular-nums">{{ qty(lvl.quantityBase, v.trackingMode) }}</span>
                  <!-- Em dash, never $0.00: unknown cost is not free stock. -->
                  <span class="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                    {{ lvl.basisCents !== null ? formatCents(lvl.basisCents as Cents) : '—' }}
                  </span>
                </div>

                <p
                  v-if="levelsFor(v).length === 0"
                  class="border-t px-3 py-1.5 text-xs text-muted-foreground"
                >
                  Out of stock everywhere
                </p>
              </div>
            </div>
          </section>

          <!-- ————— what it sells for, in full ————— -->
          <section v-if="ladder">
            <h3 class="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Price ladder · {{ ladder.name }}
            </h3>
            <dl class="flex flex-col gap-1 text-sm">
              <div v-for="row in ladder.rows" :key="row.label" class="flex items-baseline gap-2">
                <dt class="text-muted-foreground">{{ row.label }}</dt>
                <span class="min-w-0 flex-1 translate-y-[-3px] border-b border-dotted border-border" />
                <dd class="font-semibold tabular-nums">{{ formatCents(row.total as Cents) }}</dd>
              </div>
            </dl>
          </section>

          <!-- ————— admin-only, and absent rather than zeroed when unknown ————— -->
          <section v-if="insights">
            <h3 class="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Value at cost
            </h3>
            <dl class="flex flex-col gap-1.5 text-sm">
              <div class="flex justify-between">
                <dt class="text-muted-foreground">On hand, costed</dt>
                <dd class="font-semibold tabular-nums">
                  {{ insights.valueAtCostCents !== null ? formatCents(insights.valueAtCostCents as Cents) : '—' }}
                </dd>
              </div>
              <div v-if="insights.marginBps !== null" class="flex justify-between">
                <dt class="text-muted-foreground">Blended margin</dt>
                <dd class="tabular-nums">{{ (insights.marginBps / 100).toFixed(1) }}%</dd>
              </div>
              <div v-for="u in uncosted" :key="u.mode" class="flex justify-between">
                <dt class="text-muted-foreground">Cost not recorded</dt>
                <!-- `quantityWithUnit`, not `qty`: a standalone count must say 9 of WHAT. -->
                <dd class="tabular-nums text-amber-500">{{ quantityWithUnit(u.base, u.mode) }}</dd>
              </div>
            </dl>
          </section>

          <section v-if="detail.cannabinoids.length">
            <h3 class="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Cannabinoids
            </h3>
            <div class="flex flex-col gap-1.5">
              <div
                v-for="link in detail.cannabinoids"
                :key="link.cannabinoid.id"
                class="flex items-center justify-between text-sm"
              >
                <span class="text-muted-foreground">{{ link.cannabinoid.name }}</span>
                <span
                  v-if="potencyLabel(link)"
                  class="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary"
                >{{ potencyLabel(link) }}</span>
                <span v-else class="text-xs italic text-muted-foreground">not recorded</span>
              </div>
            </div>
          </section>

          <section v-if="attributes.length" class="grid grid-cols-3 gap-2">
            <div v-for="attr in attributes" :key="attr.k" class="rounded-lg border bg-accent/20 p-2.5">
              <div class="text-[11px] text-muted-foreground">{{ attr.k }}</div>
              <div class="truncate text-sm font-medium" :title="attr.v">{{ attr.v }}</div>
            </div>
          </section>

          <!--
            Last and conditional, on purpose: 2 descriptions and 0 COAs across 286 active
            products, so reserving space for these is what made the old panel two-thirds empty.
          -->
          <section v-if="description">
            <h3 class="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Description
            </h3>
            <p class="text-sm text-muted-foreground">{{ description }}</p>
          </section>

          <a
            v-if="coaUrl"
            :href="coaUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-primary underline-offset-2 hover:underline"
          >View certificate of analysis</a>
        </div>
      </div>

      <div v-else-if="loading" class="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />Loading…
      </div>

      <!-- Pinned, so the action sits in one place whatever the product's length. -->
      <div v-if="detail" class="flex shrink-0 gap-2 border-t p-3">
        <Button class="flex-1" @click="navigateTo(`/catalog/products/${detail.id}`)">
          Open full page
        </Button>
      </div>
    </SheetContent>
  </Sheet>
</template>
