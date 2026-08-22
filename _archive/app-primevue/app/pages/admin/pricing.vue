<script setup lang="ts">
import { TrackingMode, formatCents, formatQuantity, parseGramsToBase, unsafe } from '@huta/shared'
import type { PriceGroupRow, Quote } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Flower pricing — price groups and their weight tiers.
 *
 * Direction 3: the ladder on the left, a live register preview on the right. An admin types
 * a TOTAL at a weight ("$30 for an eighth") and the system derives the per-gram rate that
 * implies, so the number entered and the number charged are different kinds of thing. The
 * preview is the only element that closes that loop.
 *
 * The preview calls the same `/pricing/quote` endpoint the register will, and renders the
 * same `explain` trace — so it cannot drift from what the counter charges, because it is
 * the same call.
 */

const catalog = useCatalogStore()

const groups = ref<PriceGroupRow[]>([])
const selectedId = ref<string | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)
const savedAt = ref<number | null>(null)

async function load(keepSelection = true): Promise<void> {
  const data = await apiFetch<{ groups: PriceGroupRow[] }>('/pricing/groups')
  groups.value = data.groups
  if (!keepSelection || !groups.value.some((g) => g.id === selectedId.value)) {
    selectedId.value = groups.value[0]?.id ?? null
  }
}

await Promise.all([load(false), catalog.loadReference()])

const group = computed(() => groups.value.find((g) => g.id === selectedId.value) ?? null)

// --- editable state, mirrored from the selected group -----------------------------------

const baseDollars = ref('')
/** Tier rows as typed. `id` is null for a row that has not been saved yet. */
const tierDrafts = ref<Array<{ id: string | null; grams: string; dollars: string }>>([])

function syncDrafts(): void {
  const current = group.value
  if (!current) return
  baseDollars.value = (current.basePricePerGramCents / 100).toFixed(2)
  tierDrafts.value = current.tiers.map((tier) => ({
    id: tier.id,
    grams: (tier.minQuantityBase / 1000).toFixed(2),
    dollars: (tier.totalPriceCents / 100).toFixed(2),
  }))
}

watch(selectedId, syncDrafts, { immediate: true })
watch(groups, syncDrafts)

/** Dollars typed as a string, parsed by the digits — never `parseFloat * 100`. */
function dollarsToCents(input: string): number | null {
  const raw = input.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

function gramsToBase(input: string): number | null {
  const parsed = parseGramsToBase(input.trim())
  return parsed.ok ? parsed.value : null
}

/**
 * The per-gram rate a tier implies — shown so the derivation is visible.
 *
 * Display only. The system charges the total that was typed, and `rate × weight` will not
 * reproduce it: $55.00 at 7g derives $7.86/g, and 7 × $7.86 is $55.02.
 */
function derivedRate(grams: string, dollars: string): string {
  const base = gramsToBase(grams)
  const cents = dollarsToCents(dollars)
  if (base === null || cents === null || base <= 0) return '—'
  return `${formatCents(unsafe.cents(Math.round((cents * 1000) / base)))}/g`
}

/** How much cheaper per gram this tier is than the group's base rate. */
function versusBase(grams: string, dollars: string): string | null {
  const base = gramsToBase(grams)
  const cents = dollarsToCents(dollars)
  const baseRate = dollarsToCents(baseDollars.value)
  if (base === null || cents === null || baseRate === null || base <= 0 || baseRate <= 0) {
    return null
  }
  const rate = Math.round((cents * 1000) / base)
  const delta = Math.round(((rate - baseRate) / baseRate) * 100)
  return delta === 0 ? null : `${delta > 0 ? '+' : ''}${delta}%`
}

const dirty = computed(() => {
  const current = group.value
  if (!current) return false
  if (dollarsToCents(baseDollars.value) !== current.basePricePerGramCents) return true
  if (tierDrafts.value.length !== current.tiers.length) return true
  return tierDrafts.value.some((draft, i) => {
    const tier = current.tiers[i]
    if (!tier || draft.id !== tier.id) return true
    return (
      gramsToBase(draft.grams) !== tier.minQuantityBase ||
      dollarsToCents(draft.dollars) !== tier.totalPriceCents
    )
  })
})

const draftsValid = computed(
  () =>
    dollarsToCents(baseDollars.value) !== null &&
    tierDrafts.value.every(
      (d) => gramsToBase(d.grams) !== null && dollarsToCents(d.dollars) !== null,
    ),
)

/** A ladder whose rate does not fall as the weight rises is almost certainly a typo. */
const ladderWarning = computed(() => {
  const rates: Array<{ grams: string; rate: number }> = []
  const baseRate = dollarsToCents(baseDollars.value)
  if (baseRate === null) return null

  for (const draft of [...tierDrafts.value].sort(
    (a, b) => (gramsToBase(a.grams) ?? 0) - (gramsToBase(b.grams) ?? 0),
  )) {
    const base = gramsToBase(draft.grams)
    const cents = dollarsToCents(draft.dollars)
    if (base === null || cents === null || base <= 0) continue
    rates.push({ grams: draft.grams, rate: Math.round((cents * 1000) / base) })
  }

  let previous = baseRate
  for (const entry of rates) {
    if (entry.rate > previous) {
      return `${entry.grams}g works out dearer per gram than the weight below it — buying more would cost more per gram.`
    }
    previous = entry.rate
  }
  return null
})

function addTier(): void {
  tierDrafts.value = [...tierDrafts.value, { id: null, grams: '', dollars: '' }]
}

function removeTier(index: number): void {
  tierDrafts.value = tierDrafts.value.filter((_, i) => i !== index)
}

async function save(): Promise<void> {
  const current = group.value
  if (!current || !draftsValid.value) return

  saving.value = true
  error.value = null
  try {
    const baseCents = dollarsToCents(baseDollars.value)!
    if (baseCents !== current.basePricePerGramCents) {
      await apiFetch(`/pricing/groups/${current.id}`, {
        method: 'PATCH',
        body: { basePricePerGramCents: baseCents },
      })
    }

    // Removed rows first, so freeing a threshold does not collide with a row moving onto it.
    const keptIds = new Set(tierDrafts.value.map((d) => d.id).filter(Boolean))
    for (const tier of current.tiers) {
      if (!keptIds.has(tier.id)) {
        await apiFetch(`/pricing/groups/${current.id}/tiers/${tier.id}`, { method: 'DELETE' })
      }
    }

    for (const draft of tierDrafts.value) {
      const body = {
        minQuantityBase: gramsToBase(draft.grams)!,
        totalPriceCents: dollarsToCents(draft.dollars)!,
      }
      if (draft.id) {
        await apiFetch(`/pricing/groups/${current.id}/tiers/${draft.id}`, {
          method: 'PUT',
          body,
        })
      } else {
        await apiFetch(`/pricing/groups/${current.id}/tiers`, { method: 'POST', body })
      }
    }

    await load()
    savedAt.value = Date.now()
    await refreshPreview()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save those prices.'
  } finally {
    saving.value = false
  }
}

function revert(): void {
  syncDrafts()
  error.value = null
}

// --- register preview --------------------------------------------------------------------

const previewGrams = ref('5.00')
const previewStoreId = ref<string | null>(null)
const previewVariantId = ref<string | null>(null)
const preview = ref<Quote | null>(null)
const previewError = ref<string | null>(null)
const previewing = ref(false)

watch(
  group,
  (next) => {
    previewVariantId.value = next?.variants[0]?.id ?? null
    previewStoreId.value ??= catalog.stores[0]?.id ?? null
  },
  { immediate: true },
)

/** Common weights, so the usual answers need no typing. */
const RUNGS = [1000, 3500, 7000, 14_000, 28_000]
const rungPrices = ref<Record<number, number | null>>({})

async function refreshPreview(): Promise<void> {
  const variantId = previewVariantId.value
  const storeId = previewStoreId.value
  const base = gramsToBase(previewGrams.value)

  if (!variantId || !storeId) {
    preview.value = null
    return
  }

  previewing.value = true
  previewError.value = null
  try {
    // One call covering the typed weight AND every rung, so the ladder and the headline
    // figure can never disagree with each other.
    const lines = [...(base !== null && base > 0 ? [base] : []), ...RUNGS].map((quantityBase) => ({
      variantId,
      quantityBase,
    }))
    const result = await apiFetch<Quote>('/pricing/quote', {
      method: 'POST',
      body: { storeId, lines },
    })

    const offset = base !== null && base > 0 ? 1 : 0
    preview.value = offset === 1 ? result : null
    const net: Record<number, number | null> = {}
    const gross: Record<number, number | null> = {}
    RUNGS.forEach((weight, i) => {
      const line = result.lines[i + offset]
      net[weight] = line?.netCents ?? null
      gross[weight] = line?.grossCents ?? null
    })
    rungPrices.value = net
    rungGross.value = gross
  } catch (err) {
    previewError.value = err instanceof ApiError ? err.message : 'Could not price that.'
    preview.value = null
  } finally {
    previewing.value = false
  }
}

let previewTimer: ReturnType<typeof setTimeout> | undefined
watch(
  [previewGrams, previewVariantId, previewStoreId],
  () => {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => void refreshPreview(), 200)
  },
  { immediate: true },
)

const previewLine = computed(() => preview.value?.lines[0] ?? null)

/** Whether any promotion touched the quote — the rungs then differ from the tier prices. */
const promotionsActive = computed(
  () =>
    (previewLine.value?.appliedPromotions.length ?? 0) > 0 ||
    RUNGS.some((weight) => {
      const priced = rungPrices.value[weight]
      return priced !== null && priced !== undefined && priced !== rungGross.value[weight]
    }),
)

/** Pre-promotion totals for the rungs, so the hint can tell whether a promo moved one. */
const rungGross = ref<Record<number, number | null>>({})

/**
 * The saving at the break, spelled out.
 *
 * A tier break makes MORE weight cost LESS — 3.49g is $34.90 while 3.50g is $30.00. That is
 * what a bulk break is, but an admin should see it here rather than have staff discover it
 * at the counter.
 */
const breakNote = computed(() => {
  const first = [...tierDrafts.value]
    .map((d) => ({ base: gramsToBase(d.grams), cents: dollarsToCents(d.dollars) }))
    .filter((t): t is { base: number; cents: number } => t.base !== null && t.cents !== null)
    .sort((a, b) => a.base - b.base)[0]

  const baseRate = dollarsToCents(baseDollars.value)
  if (!first || baseRate === null || first.base <= 0) return null

  const justUnder = Math.round((baseRate * (first.base - 10)) / 1000)
  if (justUnder <= first.cents) return null

  return {
    under: formatQuantity(unsafe.baseQuantity(first.base - 10), TrackingMode.WEIGHT),
    underPrice: formatCents(unsafe.cents(justUnder)),
    at: formatQuantity(unsafe.baseQuantity(first.base), TrackingMode.WEIGHT),
    atPrice: formatCents(unsafe.cents(first.cents)),
  }
})

function variantName(v: { productName: string; label: string | null }): string {
  return v.label ? `${v.productName} · ${v.label}` : v.productName
}
</script>

<template>
  <section class="pricing">
    <header class="head">
      <h1>Pricing</h1>
      <span class="count">
        {{ groups.length }} {{ groups.length === 1 ? 'price group' : 'price groups' }}
      </span>
    </header>

    <div v-if="groups.length > 1" class="tabs" role="tablist" aria-label="Price groups">
      <button
        v-for="g in groups"
        :key="g.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ on: g.id === selectedId }"
        :aria-selected="g.id === selectedId"
        @click="selectedId = g.id"
      >
        {{ g.name }}
        <span class="n">{{ g.variantCount }}</span>
      </button>
    </div>

    <div v-if="group" class="body">
      <div class="editor">
        <div class="gname">
          <span class="n">{{ group.name }}</span>
          <!-- The blast radius, before the edit rather than after it. -->
          <span class="badge">
            {{ group.variantCount }}
            {{ group.variantCount === 1 ? 'variant prices' : 'variants price' }} through this
          </span>
        </div>

        <div class="field">
          <label for="base">Base rate</label>
          <div class="row">
            <span class="money">
              <span class="sym">$</span>
              <InputText id="base" v-model="baseDollars" class="amt" inputmode="decimal" />
              <span class="unit">/g</span>
            </span>
            <span class="hint">Applies below the first tier.</span>
          </div>
        </div>

        <div class="field">
          <label>Weight tiers</label>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Threshold</th>
                  <th class="num">Total price</th>
                  <th class="num">Works out at</th>
                  <th class="num">vs base</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr v-for="(draft, i) in tierDrafts" :key="draft.id ?? `new-${i}`">
                  <td>
                    <span class="money">
                      <InputText
                        v-model="draft.grams"
                        class="amt sm"
                        inputmode="decimal"
                        :aria-label="`Tier ${i + 1} threshold in grams`"
                      />
                      <span class="unit">g</span>
                    </span>
                  </td>
                  <td class="num">
                    <span class="money">
                      <span class="sym">$</span>
                      <InputText
                        v-model="draft.dollars"
                        class="amt sm"
                        inputmode="decimal"
                        :aria-label="`Tier ${i + 1} total price`"
                      />
                    </span>
                  </td>
                  <!--
                    Shown so the derivation is visible. The system charges the TOTAL that was
                    typed; this rate will not multiply back to it, which is deliberate.
                  -->
                  <td class="num rate">{{ derivedRate(draft.grams, draft.dollars) }}</td>
                  <td class="num delta">{{ versusBase(draft.grams, draft.dollars) ?? '—' }}</td>
                  <td class="num">
                    <button
                      type="button"
                      class="link danger"
                      :aria-label="`Remove tier ${i + 1}`"
                      @click="removeTier(i)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                <tr v-if="tierDrafts.length === 0">
                  <td colspan="5" class="empty">
                    No tiers — every weight prices at the base rate.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="actions">
            <Button label="Add tier" severity="secondary" size="small" @click="addTier" />
            <div class="spacer" />
            <Button
              v-if="dirty"
              label="Revert"
              severity="secondary"
              variant="text"
              size="small"
              @click="revert"
            />
            <Button
              label="Save"
              size="small"
              :disabled="!dirty || !draftsValid || saving"
              :loading="saving"
              @click="save"
            />
          </div>

          <Message v-if="ladderWarning" severity="warn" :closable="false" class="msg">
            {{ ladderWarning }}
          </Message>
          <Message v-if="error" severity="error" :closable="false" class="msg">
            {{ error }}
          </Message>
        </div>

        <div class="field">
          <label>At a glance</label>
          <div class="ladder">
            <div v-for="weight in RUNGS" :key="weight" class="rung">
              <div class="w">
                {{ formatQuantity(unsafe.baseQuantity(weight), TrackingMode.WEIGHT) }}
              </div>
              <div class="p">
                {{ rungPrices[weight] === null || rungPrices[weight] === undefined
                  ? '—'
                  : formatCents(unsafe.cents(rungPrices[weight]!)) }}
              </div>
            </div>
          </div>
          <!--
            These are what the register CHARGES, promotions included — not the tier prices
            above. Worth saying, because with the best-outcome rule a different promotion can
            win at different weights, so the ladder does not read as one flat discount.
          -->
          <p v-if="promotionsActive" class="hint">
            What the register charges today at
            {{ catalog.stores.find((s) => s.id === previewStoreId)?.name ?? 'this store' }},
            promotions included — so a weight here can be cheaper than its tier price, and a
            different promotion may win at different weights.
          </p>
        </div>
      </div>

      <aside class="preview">
        <div class="pkey">Register preview</div>

        <div v-if="group.variants.length === 0" class="pbox muted">
          Nothing prices through this group yet, so there is nothing to preview. Assign a
          weight-tracked variant to it first.
        </div>

        <template v-else>
          <div class="psel">
            <label for="pvariant">Strain</label>
            <select id="pvariant" v-model="previewVariantId" class="sel">
              <option v-for="v in group.variants" :key="v.id" :value="v.id">
                {{ variantName(v) }}
              </option>
            </select>
          </div>

          <div v-if="catalog.stores.length > 1" class="psel">
            <label for="pstore">Store</label>
            <select id="pstore" v-model="previewStoreId" class="sel">
              <option v-for="s in catalog.stores" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>

          <div class="pbox">
            <div class="pk">Weigh</div>
            <span class="money big">
              <InputText v-model="previewGrams" class="amt" inputmode="decimal" aria-label="Preview weight in grams" />
              <span class="unit">g</span>
            </span>

            <div class="pk pay">Customer pays</div>
            <div class="total" :class="{ stale: previewing }">
              {{ previewLine ? formatCents(unsafe.cents(previewLine.netCents)) : '—' }}
            </div>

            <!--
              The same `explain` trace the register will show. Built here from the same call,
              so the preview cannot drift from what the counter charges.
            -->
            <ol v-if="previewLine" class="trace">
              <li v-for="(step, i) in previewLine.explain" :key="i">{{ step }}</li>
            </ol>

            <p v-if="previewError" class="perr">{{ previewError }}</p>
          </div>

          <div v-if="previewLine && previewLine.appliedPromotions.length > 0" class="pbox promo">
            <div class="pk">Promotion applied</div>
            <div v-for="p in previewLine.appliedPromotions" :key="p.promotionId" class="prow">
              {{ p.name }}
              <span class="amtoff">−{{ formatCents(unsafe.cents(p.discountCents)) }}</span>
            </div>
            <p class="pnote">
              This is what the register would charge today. The tier price itself is
              {{ formatCents(unsafe.cents(previewLine.grossCents)) }}.
            </p>
          </div>

          <div v-if="breakNote" class="pbox warn">
            <div class="pk">Watch out</div>
            <p class="pnote">
              {{ breakNote.under }} costs <strong>{{ breakNote.underPrice }}</strong> but
              {{ breakNote.at }} costs <strong>{{ breakNote.atPrice }}</strong>. Round a
              near-miss weight up to the break.
            </p>
          </div>
        </template>
      </aside>
    </div>

    <p v-else class="state">No price groups yet.</p>
  </section>
</template>

<style scoped>
.pricing {
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

.tabs {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  font: inherit;
  font-size: 0.875rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
  cursor: pointer;
}

.tab.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
  font-weight: 620;
}

.tab .n {
  font-size: 0.6875rem;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.tab:focus-visible,
.link:focus-visible,
.sel:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 17rem;
  gap: 1rem;
  align-items: start;
}

@container content (max-width: 1000px) {
  .body {
    grid-template-columns: 1fr;
  }
}

.editor {
  display: grid;
  gap: 1.1rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.gname {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.gname .n {
  font-size: 1.0625rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.badge {
  font-size: 0.6875rem;
  font-weight: 620;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.field {
  display: grid;
  gap: 0.4rem;
}

label {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.money {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
}

.sym,
.unit {
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

:deep(.amt) {
  width: 6rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.875rem;
  text-align: right;
  padding: 0.3rem 0.45rem;
}

:deep(.amt.sm) {
  width: 5rem;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.tablewrap {
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
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
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}

td {
  padding: 0.35rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: 0.8125rem;
}

tbody tr:last-child td {
  border-bottom: 0;
}

th.num,
td.num {
  text-align: right;
}

td.rate {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

td.delta {
  font-variant-numeric: tabular-nums;
  color: var(--p-primary-color);
}

td.empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 1.25rem;
}

.link {
  font: inherit;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  background: none;
  border: 0;
  cursor: pointer;
  padding: 0.1rem 0.2rem;
  border-radius: 0.2rem;
}

.link.danger:hover {
  color: var(--p-red-600);
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spacer {
  flex: 1;
}

.msg {
  margin: 0;
}

.ladder {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.rung {
  flex: 1 1 5rem;
  text-align: center;
  padding: 0.4rem 0.3rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.3rem;
}

/* Deliberately NOT uppercased: formatQuantity returns "3.50g" and the unit is a lowercase
   gram. Uppercasing the label turns it into "3.50G", which is a different unit. */
.rung .w {
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  letter-spacing: 0.02em;
}

.rung .p {
  font-size: 0.9375rem;
  font-weight: 640;
  font-variant-numeric: tabular-nums;
}

/* --- preview --- */

.preview {
  display: grid;
  gap: 0.6rem;
  padding: 0.85rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  position: sticky;
  top: 1rem;
}

@container content (max-width: 1000px) {
  .preview {
    position: static;
  }
}

.pkey {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.psel {
  display: grid;
  gap: 0.2rem;
}

.sel {
  font: inherit;
  font-size: 0.8125rem;
  padding: 0.25rem 0.35rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.3rem;
  width: 100%;
}

.pbox {
  padding: 0.65rem 0.75rem;
  background: var(--p-surface-50);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
}

.app-dark .pbox {
  background: var(--p-surface-900);
}

.pbox.muted {
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.pk {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.pk.pay {
  margin-top: 0.55rem;
}

.money.big :deep(.amt) {
  width: 5.5rem;
  font-size: 1rem;
}

.total {
  font-size: 1.625rem;
  font-weight: 660;
  letter-spacing: -0.015em;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

/* Dim rather than blank while re-quoting, so the panel never collapses mid-keystroke. */
.total.stale {
  opacity: 0.45;
}

.trace {
  margin: 0.45rem 0 0;
  padding-left: 1rem;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.6;
}

.perr {
  margin: 0.4rem 0 0;
  font-size: 0.75rem;
  color: var(--p-red-600);
}

.pbox.promo {
  border-color: var(--p-primary-color);
}

.prow {
  display: flex;
  gap: 0.5rem;
  font-size: 0.8125rem;
  margin-top: 0.2rem;
}

.amtoff {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--p-primary-color);
  font-weight: 620;
}

.pnote {
  margin: 0.35rem 0 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  line-height: 1.5;
}

.pbox.warn {
  border-color: var(--p-amber-500);
}

.pbox.warn .pk {
  color: var(--p-amber-600);
}

.app-dark .pbox.warn .pk {
  color: var(--p-amber-400);
}

.state {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
</style>
