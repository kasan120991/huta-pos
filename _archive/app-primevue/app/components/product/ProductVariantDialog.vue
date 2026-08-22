<script setup lang="ts">
import { TrackingMode, formatCents, parseGramsToBase, unsafe } from '@huta/shared'
import type { CatalogVariant } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * The variant editor — one dialog, two modes.
 *
 * With a `variant` it edits; without one it creates. The pricing-mode rules the server
 * enforces are mirrored here as the SHAPE of the form — an EACH variant shows a dollar
 * price, a WEIGHT variant shows its price group read-only with a re-assign Select and a
 * link to the Pricing page — but the server's refusal message remains the authority.
 * `trackingMode` is only choosable at creation; changing it later would re-unit history.
 */
const props = defineProps<{
  productId: string
  productName: string
  variant?: CatalogVariant
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const catalog = useCatalogStore()

const isEdit = computed(() => props.variant !== undefined)

const trackingMode = ref<TrackingMode>(props.variant?.trackingMode ?? TrackingMode.EACH)
const isWeight = computed(() => trackingMode.value === TrackingMode.WEIGHT)

function baseToInput(base: number | null): string {
  if (base === null) return ''
  return isWeight.value ? (base / 1000).toFixed(2).replace(/\.?0+$/, '') : String(base)
}

const draft = ref({
  label: props.variant?.label ?? '',
  sku: props.variant?.sku ?? '',
  barcode: props.variant?.barcode ?? '',
  priceDollars:
    props.variant?.priceCents != null ? (props.variant.priceCents / 100).toFixed(2) : '',
  priceGroupId: props.variant?.priceGroup?.id ?? null,
  taxable: props.variant?.taxable ?? true,
  active: props.variant?.active ?? true,
  minSale: baseToInput(props.variant?.minSaleBase ?? null),
  maxSale: baseToInput(props.variant?.maxSaleBase ?? null),
})

const saving = ref(false)
const error = ref<string | null>(null)

watch([draft, trackingMode], () => (error.value = null), { deep: true })

// --- price groups (WEIGHT only) ------------------------------------------------------------

const groupOptions = ref<Array<{ label: string; value: string }>>([])

void apiFetch<{ groups: Array<{ id: string; name: string; basePricePerGramCents: number }> }>(
  '/pricing/groups',
)
  .then((data) => {
    groupOptions.value = data.groups.map((g) => ({
      label: `${g.name} · ${formatCents(unsafe.cents(g.basePricePerGramCents))}/g`,
      value: g.id,
    }))
  })
  .catch(() => {})

// --- parsing -------------------------------------------------------------------------------

/** Dollars typed as a string, parsed by the digits — never `parseFloat * 100`. */
function dollarsToCents(input: string): number | null | 'invalid' {
  const raw = input.trim().replace(/^\$/, '')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'invalid'
  const [whole, fraction = ''] = raw.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** Sale bound in base units: grams (two decimals) for WEIGHT, whole items for EACH. */
function boundToBase(input: string): number | null | 'invalid' {
  const raw = input.trim()
  if (raw === '') return null
  if (isWeight.value) {
    const parsed = parseGramsToBase(raw)
    return parsed.ok && parsed.value > 0 ? parsed.value : 'invalid'
  }
  if (!/^\d+$/.test(raw) || Number(raw) === 0) return 'invalid'
  return Number(raw)
}

const parsed = computed(() => {
  if (draft.value.sku.trim() === '') return { ok: false as const, reason: 'A variant needs a SKU.' }
  const price = dollarsToCents(draft.value.priceDollars)
  if (price === 'invalid') return { ok: false as const, reason: 'Price is dollars and cents, like 19.99.' }
  if (!isWeight.value && price === null) return { ok: false as const, reason: 'An EACH variant needs a price.' }
  if (isWeight.value && draft.value.priceGroupId === null) {
    return { ok: false as const, reason: 'A weight variant needs a price group.' }
  }
  const min = boundToBase(draft.value.minSale)
  const max = boundToBase(draft.value.maxSale)
  if (min === 'invalid' || max === 'invalid') {
    return {
      ok: false as const,
      reason: isWeight.value ? 'Sale bounds are grams, to two decimals.' : 'Sale bounds are whole units.',
    }
  }
  if (min !== null && max !== null && min > max) {
    return { ok: false as const, reason: 'Minimum sale quantity cannot exceed the maximum.' }
  }
  return { ok: true as const, price, min, max }
})

const canSave = computed(() => parsed.value.ok && !saving.value)

async function save(): Promise<void> {
  if (!parsed.value.ok) return
  const p = parsed.value
  const body: Record<string, unknown> = {
    label: draft.value.label.trim() || null,
    sku: draft.value.sku.trim(),
    barcode: draft.value.barcode.trim() || null,
    priceCents: isWeight.value ? null : p.price,
    priceGroupId: isWeight.value ? draft.value.priceGroupId : null,
    taxable: draft.value.taxable,
    active: draft.value.active,
    minSaleBase: p.min,
    maxSaleBase: p.max,
  }

  saving.value = true
  try {
    if (isEdit.value && props.variant) {
      await catalog.updateVariant(props.variant.id, body)
    } else {
      await catalog.createVariant(props.productId, { ...body, trackingMode: trackingMode.value })
    }
    emit('saved')
  } catch (err) {
    error.value =
      err instanceof ApiError
        ? err.message
        : `Could not ${isEdit.value ? 'save' : 'create'} the variant.`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    :draggable="false"
    :style="{ width: 'min(32rem, calc(100vw - 3rem))' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dhead">
        <h2>{{ isEdit ? 'Edit variant' : 'New variant' }}</h2>
        <p class="who">
          {{ productName }}<template v-if="variant"> · {{ variant.label ?? variant.sku }}</template>
        </p>
      </div>
    </template>

    <div class="body">
      <div v-if="!isEdit" class="field">
        <label>Sold as</label>
        <div class="seg" role="group" aria-label="Tracking mode">
          <button
            type="button"
            :class="{ on: !isWeight }"
            :aria-pressed="!isWeight"
            @click="trackingMode = TrackingMode.EACH"
          >
            Discrete units
          </button>
          <button
            type="button"
            :class="{ on: isWeight }"
            :aria-pressed="isWeight"
            @click="trackingMode = TrackingMode.WEIGHT"
          >
            By weight
          </button>
        </div>
        <small class="hint">Can't be changed later — it defines what every quantity means.</small>
      </div>

      <div class="grid">
        <div class="field">
          <label for="ve-label">Label</label>
          <InputText id="ve-label" v-model="draft.label" placeholder="1000mg, Blueberry…" autocomplete="off" />
        </div>

        <div class="field">
          <label for="ve-sku">SKU</label>
          <InputText id="ve-sku" v-model="draft.sku" autocomplete="off" />
        </div>

        <div class="field">
          <label for="ve-barcode">Barcode (UPC)</label>
          <InputText id="ve-barcode" v-model="draft.barcode" inputmode="numeric" autocomplete="off" />
        </div>

        <div v-if="!isWeight" class="field">
          <label for="ve-price">Price</label>
          <div class="money">
            <span class="sym" aria-hidden="true">$</span>
            <InputText id="ve-price" v-model="draft.priceDollars" class="amt" inputmode="decimal" autocomplete="off" />
          </div>
        </div>

        <div v-else class="field wide">
          <label for="ve-group">Price group</label>
          <Select
            id="ve-group"
            v-model="draft.priceGroupId"
            :options="groupOptions"
            option-label="label"
            option-value="value"
            size="small"
            placeholder="Pick a group"
          />
          <small class="hint">
            Weight variants price through their group — rates and tiers live on the
            <NuxtLink to="/admin/pricing" class="plink">Pricing page</NuxtLink>.
          </small>
        </div>

        <div class="field">
          <label for="ve-min">Min sale {{ isWeight ? '(g)' : '(units)' }}</label>
          <InputText id="ve-min" v-model="draft.minSale" inputmode="decimal" placeholder="—" autocomplete="off" />
        </div>

        <div class="field">
          <label for="ve-max">Max sale {{ isWeight ? '(g)' : '(units)' }}</label>
          <InputText id="ve-max" v-model="draft.maxSale" inputmode="decimal" placeholder="—" autocomplete="off" />
        </div>

        <div class="field onoff">
          <ToggleSwitch v-model="draft.taxable" input-id="ve-taxable" />
          <label for="ve-taxable" class="plain">Taxable</label>
        </div>

        <div class="field onoff">
          <ToggleSwitch v-model="draft.active" input-id="ve-active" />
          <label for="ve-active" class="plain">Active</label>
        </div>
      </div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Message v-else-if="!parsed.ok" severity="warn" :closable="false">
        {{ parsed.ok ? '' : parsed.reason }}
      </Message>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" variant="text" @click="emit('close')" />
      <Button
        :label="isEdit ? 'Save' : 'Create variant'"
        :disabled="!canSave"
        :loading="saving"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.dhead {
  display: grid;
  gap: 0.2rem;
}

h2 {
  margin: 0;
  font-size: 1.0625rem;
  letter-spacing: -0.01em;
}

.who {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.body {
  display: grid;
  gap: 0.9rem;
  padding-top: 0.25rem;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.field {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}

.field.wide {
  grid-column: 1 / -1;
}

label {
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

label.plain {
  text-transform: none;
  letter-spacing: normal;
  font-size: 0.8125rem;
  color: var(--p-text-color);
}

.hint {
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
  letter-spacing: normal;
  text-transform: none;
}

.plink {
  color: var(--p-primary-color);
}

.onoff {
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 0.6rem;
}

.seg {
  display: flex;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.35rem;
  overflow: hidden;
  width: fit-content;
}

.seg button {
  padding: 0.35rem 0.8rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  background: var(--p-content-background);
  border: 0;
  border-right: 1px solid var(--p-content-border-color);
  cursor: pointer;
}

.seg button:last-child {
  border-right: 0;
}

.seg button.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
  font-weight: 620;
}

.seg button:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -2px;
}

.money {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.sym {
  color: var(--p-text-muted-color);
}

.amt {
  width: 100%;
}
</style>
