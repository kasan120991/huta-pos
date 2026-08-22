<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, unsafe } from '@huta/shared'
import type { CatalogProductDetail, CatalogVariant, ProductInsights } from '@huta/shared/schemas'
import { computed } from 'vue'

/**
 * Overview: the facts rail and the variants & pricing table.
 *
 * Potency renders BOTH recorded forms — packaged goods carry mg per unit, flower carries a
 * percentage of weight, and the schema keeps both columns so neither has to be faked.
 */
const props = defineProps<{
  product: CatalogProductDetail
  insights: ProductInsights | null
  canEdit: boolean
}>()

const emit = defineEmits<{
  editProduct: []
  editPotency: []
  editVariant: [variant: CatalogVariant]
}>()

const showCost = computed(() => props.product.variants.some((v) => v.costCents !== undefined))

const marginByVariant = computed(() => {
  const map = new Map<string, number | null>()
  for (const row of props.insights?.variants ?? []) map.set(row.variantId, row.marginBps)
  return map
})

const potencyIsAmbiguous = computed(() => props.product.variants.length > 1)

const tieredVariants = computed(() =>
  props.product.variants.filter((v) => v.priceGroup && v.priceGroup.tiers.length > 0),
)

function priceLabel(variant: CatalogVariant): string {
  if (variant.trackingMode === TrackingMode.WEIGHT) {
    const rate = variant.priceGroup?.basePricePerGramCents
    return rate === undefined ? '—' : `${formatCents(unsafe.cents(rate))}/g`
  }
  return variant.priceCents === null ? '—' : formatCents(unsafe.cents(variant.priceCents))
}

function marginLabel(variantId: string): string | null {
  const bps = marginByVariant.value.get(variantId)
  if (bps === undefined) return null
  return bps === null ? '—' : `${(bps / 100).toFixed(1)}%`
}

function qty(base: number, mode: TrackingMode): string {
  return formatQuantity(unsafe.baseQuantity(base), mode)
}

function percentLabel(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`
}
</script>

<template>
  <div class="overview">
    <div class="facts">
      <div class="group">
        <div class="ghead">
          <span class="k">Details</span>
          <button v-if="canEdit" type="button" class="edit" @click="emit('editProduct')">
            Edit
          </button>
        </div>
        <dl class="kv">
          <dt>Category</dt>
          <dd>
            <span v-if="product.category.parent" class="parent">
              {{ product.category.parent.name }} ›
            </span>
            {{ product.category.name }}
          </dd>

          <dt>Supplier</dt>
          <dd>
            <span v-if="product.primarySupplier">{{ product.primarySupplier.name }}</span>
            <EmptyValue v-else label="none recorded" />
          </dd>

          <dt>COA</dt>
          <dd>
            <a v-if="product.coaUrl" :href="product.coaUrl" target="_blank" rel="noopener">
              View certificate
            </a>
            <EmptyValue v-else label="not on file" />
          </dd>

          <template v-if="product.terpeneProfile">
            <dt>Terpenes</dt>
            <dd>{{ product.terpeneProfile }}</dd>
          </template>

          <template v-if="product.nose">
            <dt>Nose</dt>
            <dd>{{ product.nose }}</dd>
          </template>
        </dl>
      </div>

      <div class="group">
        <div class="ghead">
          <span class="k">Cannabinoids</span>
          <button v-if="canEdit" type="button" class="edit" @click="emit('editPotency')">
            Edit
          </button>
        </div>
        <template v-if="product.cannabinoids.length > 0">
          <div class="chips">
            <span v-for="link in product.cannabinoids" :key="link.cannabinoid.id" class="chip">
              {{ link.cannabinoid.name }}
              <span v-if="link.mgPerUnit !== null" class="dose">{{ link.mgPerUnit }}mg</span>
              <span v-if="link.percentBps !== null" class="dose">
                {{ percentLabel(link.percentBps) }}
              </span>
            </span>
          </div>
          <div v-if="potencyIsAmbiguous" class="qualify">
            Recorded at product level — see each variant for its own strength.
          </div>
        </template>
        <EmptyValue v-else label="none recorded" />
      </div>

      <div v-if="product.description" class="group">
        <div class="k">Description</div>
        <p class="desc">{{ product.description }}</p>
      </div>
    </div>

    <div class="main">
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th class="rail-col" />
              <th>Variant</th>
              <th>Barcode</th>
              <th class="num">Price</th>
              <th v-if="showCost" class="num">Last cost</th>
              <th v-if="insights" class="num">Margin</th>
              <th class="num">On hand</th>
              <th>Status</th>
              <th v-if="canEdit" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="variant in product.variants" :key="variant.id" :class="{ off: !variant.active }">
              <td class="rail-col"><i :class="variant.stock.status.toLowerCase()" /></td>
              <td>
                <div class="vname">
                  {{ variant.label ?? 'Standard' }}
                  <span v-if="variant.trackingMode === TrackingMode.WEIGHT" class="mode">
                    by weight
                  </span>
                  <span v-if="!variant.taxable" class="mode">tax exempt</span>
                </div>
                <div class="sku">{{ variant.sku }}</div>
              </td>
              <td>
                <span v-if="variant.barcode" class="sku">{{ variant.barcode }}</span>
                <EmptyValue v-else label="—" />
              </td>
              <td class="num">{{ priceLabel(variant) }}</td>
              <td v-if="showCost" class="num">
                <template v-if="variant.costCents != null">
                  {{ formatCents(unsafe.cents(variant.costCents)) }}
                </template>
                <EmptyValue v-else label="—" />
              </td>
              <td v-if="insights" class="num">
                {{ marginLabel(variant.id) ?? '—' }}
              </td>
              <td class="num">{{ qty(variant.stock.quantityBase, variant.trackingMode) }}</td>
              <td class="status">
                <Tag v-if="!variant.active" severity="warn" value="Inactive" />
                <StockPill v-else :status="variant.stock.status" />
              </td>
              <td v-if="canEdit" class="num">
                <button type="button" class="edit" @click="emit('editVariant', variant)">
                  Edit
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-for="variant in tieredVariants" :key="`tiers-${variant.id}`" class="tiers">
        <span class="tlabel">{{ variant.priceGroup?.name }} tiers</span>
        <span
          v-for="tier in variant.priceGroup?.tiers ?? []"
          :key="tier.minQuantityBase"
          class="tier"
        >
          {{ qty(tier.minQuantityBase, TrackingMode.WEIGHT) }}
          →
          {{ formatCents(unsafe.cents(tier.totalPriceCents)) }}
        </span>
        <NuxtLink to="/admin/pricing" class="plink">Pricing page</NuxtLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview {
  display: grid;
  grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@container content (max-width: 900px) {
  .overview {
    grid-template-columns: 1fr;
  }
}

.facts {
  display: grid;
  gap: 1rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.group {
  display: grid;
  gap: 0.4rem;
}

.ghead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.edit {
  padding: 0;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 620;
  color: var(--p-primary-color);
  background: none;
  border: 0;
  cursor: pointer;
}

.edit:hover {
  text-decoration: underline;
}

.edit:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.k {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.4rem 1rem;
  margin: 0;
  font-size: 0.8125rem;
}

.kv dt {
  color: var(--p-text-muted-color);
}

.kv dd {
  margin: 0;
  min-width: 0;
}

.kv a {
  color: var(--p-primary-color);
}

.parent {
  color: var(--p-text-muted-color);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: 560;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.dose {
  font-weight: 400;
  opacity: 0.8;
}

.qualify {
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  line-height: 1.4;
}

.desc {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  line-height: 1.55;
}

.main {
  display: grid;
  gap: 0.6rem;
  min-width: 0;
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
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: 0.8125rem;
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tr.off td {
  color: var(--p-text-muted-color);
}

th.num,
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

th.rail-col,
td.rail-col {
  width: 3px;
  padding: 0;
}

td.rail-col i {
  display: block;
  width: 3px;
  height: 100%;
  min-height: 2.4rem;
  background: transparent;
}

td.rail-col i.out {
  background: var(--p-red-500);
}

td.rail-col i.low {
  background: var(--p-amber-500);
}

.vname {
  font-weight: 600;
}

.mode {
  margin-left: 0.3rem;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--p-text-muted-color);
}

.sku {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

td.status {
  white-space: nowrap;
}

.tiers {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.tlabel {
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.6875rem;
}

.tier {
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.25rem;
}

.plink {
  font-size: 0.72rem;
  color: var(--p-primary-color);
  text-decoration: none;
}

.plink:hover {
  text-decoration: underline;
}
</style>
