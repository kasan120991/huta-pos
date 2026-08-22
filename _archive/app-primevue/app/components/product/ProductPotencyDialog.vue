<script setup lang="ts">
import type { CatalogProductDetail } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * The potency editor — the product's cannabinoid links, replaced as a set.
 *
 * Both potency columns are honest nullables: packaged goods carry mg per unit, flower a
 * percentage of weight, and "contains X, potency unrecorded" is legal. The percent is
 * typed as a human number ("24.5") and converted to basis points by DIGITS — a float ×100
 * turns 24.57 into 2456.9999999999995.
 */
const props = defineProps<{ product: CatalogProductDetail }>()

const emit = defineEmits<{ close: []; saved: [] }>()

const catalog = useCatalogStore()

interface Row {
  cannabinoidId: string | null
  mg: string
  percent: string
}

const rows = ref<Row[]>(
  props.product.cannabinoids.map((link) => ({
    cannabinoidId: link.cannabinoid.id,
    mg: link.mgPerUnit === null ? '' : String(link.mgPerUnit),
    percent: link.percentBps === null ? '' : (link.percentBps / 100).toFixed(2).replace(/\.?0+$/, ''),
  })),
)

const saving = ref(false)
const error = ref<string | null>(null)

watch(rows, () => (error.value = null), { deep: true })

const cannabinoidOptions = computed(() =>
  (catalog.reference?.cannabinoids ?? []).map((c) => ({ label: c.name, value: c.id })),
)

function addRow(): void {
  rows.value.push({ cannabinoidId: null, mg: '', percent: '' })
}

function removeRow(index: number): void {
  rows.value.splice(index, 1)
}

/** "24.5" → 2450 bps, by the digits. Null for blank; NaN-shaped input reports invalid. */
function percentToBps(input: string): number | null | 'invalid' {
  const raw = input.trim().replace(/%$/, '')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'invalid'
  const [whole, fraction = ''] = raw.split('.')
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return bps > 10000 ? 'invalid' : bps
}

function mgToInt(input: string): number | null | 'invalid' {
  const raw = input.trim()
  if (raw === '') return null
  if (!/^\d+$/.test(raw)) return 'invalid'
  return Number(raw)
}

const parsed = computed(() => {
  const links: Array<{ cannabinoidId: string; mgPerUnit: number | null; percentBps: number | null }> = []
  const seen = new Set<string>()
  for (const row of rows.value) {
    if (row.cannabinoidId === null) return { ok: false as const, reason: 'Pick a cannabinoid for every row.' }
    if (seen.has(row.cannabinoidId)) return { ok: false as const, reason: 'Each cannabinoid can only appear once.' }
    seen.add(row.cannabinoidId)
    const mg = mgToInt(row.mg)
    if (mg === 'invalid') return { ok: false as const, reason: 'mg is whole numbers only.' }
    const bps = percentToBps(row.percent)
    if (bps === 'invalid') return { ok: false as const, reason: 'Percent is 0–100, to two decimals.' }
    links.push({ cannabinoidId: row.cannabinoidId, mgPerUnit: mg, percentBps: bps })
  }
  return { ok: true as const, links }
})

const canSave = computed(() => parsed.value.ok && !saving.value)

async function save(): Promise<void> {
  if (!parsed.value.ok) return
  saving.value = true
  try {
    await catalog.setCannabinoids(props.product.id, parsed.value.links)
    emit('saved')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save the cannabinoids.'
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
        <h2>Edit cannabinoids</h2>
        <p class="who">{{ product.name }}</p>
      </div>
    </template>

    <div class="body">
      <div v-if="rows.length > 0" class="rows">
        <div class="rowhead">
          <span class="k">Cannabinoid</span>
          <span class="k">mg / unit</span>
          <span class="k">% of weight</span>
          <span />
        </div>
        <div v-for="(row, index) in rows" :key="index" class="row">
          <Select
            v-model="row.cannabinoidId"
            :options="cannabinoidOptions"
            option-label="label"
            option-value="value"
            size="small"
            placeholder="Pick one"
            :aria-label="`Cannabinoid ${index + 1}`"
          />
          <InputText
            v-model="row.mg"
            size="small"
            inputmode="numeric"
            placeholder="—"
            :aria-label="`mg per unit ${index + 1}`"
          />
          <InputText
            v-model="row.percent"
            size="small"
            inputmode="decimal"
            placeholder="—"
            :aria-label="`Percent of weight ${index + 1}`"
          />
          <button
            type="button"
            class="remove"
            :aria-label="`Remove row ${index + 1}`"
            @click="removeRow(index)"
          >
            ×
          </button>
        </div>
      </div>
      <p v-else class="none">No cannabinoids linked. This product will not appear under any cannabinoid filter.</p>

      <button type="button" class="mini" @click="addRow">Add cannabinoid</button>

      <p class="hint">
        Packaged goods record mg per unit; flower records a percentage of weight. Leaving
        both blank records "contains it, potency unknown" — which is honest, not an error.
      </p>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Message
        v-else-if="!parsed.ok && rows.length > 0"
        severity="warn"
        :closable="false"
      >
        {{ parsed.ok ? '' : parsed.reason }}
      </Message>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" variant="text" @click="emit('close')" />
      <Button label="Save" :disabled="!canSave" :loading="saving" @click="save" />
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

.rows {
  display: grid;
  gap: 0.4rem;
}

.rowhead,
.row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 0.4rem;
  align-items: center;
}

.k {
  font-size: 0.625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.remove {
  width: 1.6rem;
  height: 1.6rem;
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  color: var(--p-text-muted-color);
  background: none;
  border: 1px solid transparent;
  border-radius: 0.3rem;
  cursor: pointer;
}

.remove:hover {
  color: var(--p-red-500);
  border-color: var(--p-content-border-color);
}

.remove:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.mini {
  justify-self: start;
  padding: 0;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 620;
  color: var(--p-primary-color);
  background: none;
  border: 0;
  cursor: pointer;
}

.mini:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.none {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.hint {
  margin: 0;
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
  line-height: 1.5;
}
</style>
