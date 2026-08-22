<script setup lang="ts">
import {
  ADJUSTMENT_REASONS,
  TrackingMode,
  formatQuantity,
  parseGramsToBase,
  unsafe,
} from '@huta/shared'
import { computed, ref, watch } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * Correct a stock count.
 *
 * Takes what was COUNTED, not the difference — that is how a stocktake actually happens,
 * and nobody should be doing subtraction in their head while holding a clipboard. The
 * delta is derived and shown live, so a mistyped "380" for "38" is visible before it is
 * committed.
 */

const props = defineProps<{
  variantId: string
  variantLabel: string
  sku: string
  productName: string
  storeId: string
  storeName: string
  currentBase: number
  trackingMode: TrackingMode
}>()

const emit = defineEmits<{ close: []; adjusted: [] }>()

const catalog = useCatalogStore()

const isWeight = computed(() => props.trackingMode === TrackingMode.WEIGHT)

const counted = ref(
  isWeight.value ? (props.currentBase / 1000).toFixed(2) : String(props.currentBase),
)
const reasonCode = ref<string | null>(null)
const note = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

/** The typed count in base units, or null when it isn't a valid number yet. */
const countedBase = computed<number | null>(() => {
  const raw = counted.value.trim()
  if (raw === '') return null

  if (isWeight.value) {
    // Grams to two decimals, parsed from the string — the same rule the register uses,
    // and never `parseFloat * 1000`, which turns 3.53 into 3530.0000000000005.
    const parsed = parseGramsToBase(raw)
    return parsed.ok ? parsed.value : null
  }
  if (!/^\d+$/.test(raw)) return null
  return Number(raw)
})

const delta = computed(() =>
  countedBase.value === null ? null : countedBase.value - props.currentBase,
)

const deltaLabel = computed(() => {
  if (delta.value === null || delta.value === 0) return null
  const magnitude = formatQuantity(unsafe.baseQuantity(Math.abs(delta.value)), props.trackingMode)
  return delta.value < 0
    ? `${magnitude} fewer than recorded`
    : `${magnitude} more than recorded`
})

const currentLabel = computed(() =>
  formatQuantity(unsafe.baseQuantity(props.currentBase), props.trackingMode),
)

const countedLabel = computed(() =>
  countedBase.value === null
    ? ''
    : formatQuantity(unsafe.baseQuantity(countedBase.value), props.trackingMode),
)

const canSubmit = computed(
  () =>
    countedBase.value !== null &&
    delta.value !== null &&
    delta.value !== 0 &&
    reasonCode.value !== null &&
    !submitting.value,
)

watch([counted, reasonCode, note], () => {
  error.value = null
})

async function submit(): Promise<void> {
  if (!canSubmit.value || countedBase.value === null || reasonCode.value === null) return

  submitting.value = true
  try {
    await catalog.adjust({
      storeId: props.storeId,
      variantId: props.variantId,
      countedBase: countedBase.value,
      reasonCode: reasonCode.value,
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
    })
    emit('adjusted')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save that adjustment.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <!--
    PrimeVue Dialog rather than the previous hand-rolled backdrop: the focus trap, Escape
    handling and focus return on close come built in, which the hand-rolled version never
    had. The component's props/emits API is unchanged — the parent still mounts with v-if
    and listens for close/adjusted.
  -->
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    :draggable="false"
    class="adjust-dialog"
    :style="{ width: 'min(30rem, calc(100vw - 3rem))' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dhead">
        <h2>Adjust stock</h2>
        <p class="who">
          {{ productName }} · {{ variantLabel }} ·
          <span class="sku">{{ sku }}</span> · {{ storeName }}
        </p>
      </div>
    </template>

    <div class="body">
        <div class="row">
          <span>Currently on hand</span>
          <span class="n">{{ currentLabel }}</span>
        </div>

        <div class="field">
          <label for="counted">
            {{ isWeight ? 'Weighed on the scale' : 'Counted on the shelf' }}
          </label>
          <InputText
            id="counted"
            v-model="counted"
            class="big"
            :inputmode="isWeight ? 'decimal' : 'numeric'"
            autocomplete="off"
          />
          <small v-if="isWeight" class="hint">Grams, to two decimal places.</small>
          <small v-else-if="countedBase === null && counted.trim() !== ''" class="hint bad">
            Whole units only.
          </small>
        </div>

        <div v-if="deltaLabel" class="delta" :class="delta! < 0 ? 'down' : 'up'">
          <span aria-hidden="true">{{ delta! < 0 ? '↓' : '↑' }}</span>
          {{ deltaLabel }}
        </div>
        <div v-else-if="delta === 0" class="delta same">
          That matches the current quantity — nothing to adjust.
        </div>

        <div class="field">
          <label>Reason <span aria-hidden="true">*</span></label>
          <div class="chips">
            <button
              v-for="reason in ADJUSTMENT_REASONS"
              :key="reason.code"
              type="button"
              class="chip"
              :class="{ on: reasonCode === reason.code }"
              @click="reasonCode = reason.code"
            >
              {{ reason.label }}
            </button>
          </div>
          <Textarea
            v-model="note"
            class="note"
            rows="2"
            :placeholder="reasonCode === 'other' ? 'What happened?' : 'Add detail (optional)'"
          />
        </div>

        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" variant="text" @click="emit('close')" />
      <Button
        :label="countedLabel ? `Adjust to ${countedLabel}` : 'Adjust'"
        :disabled="!canSubmit"
        :loading="submitting"
        @click="submit"
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

.sku {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem;
}

.body {
  display: grid;
  gap: 1rem;
  padding-top: 0.25rem;
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.6rem 0.75rem;
  background: var(--p-surface-100);
  border-radius: 0.375rem;
  font-size: 0.875rem;
}

.app-dark .row {
  background: var(--p-surface-800);
}

.row .n {
  font-size: 1.125rem;
  font-weight: 600;
}

.field {
  display: grid;
  gap: 0.3rem;
}

label {
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

:deep(.big) {
  font-size: 1.75rem;
  font-weight: 600;
  text-align: center;
  letter-spacing: -0.01em;
  padding: 0.65rem;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.hint.bad {
  color: var(--p-red-500);
}

.delta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem;
  border-radius: 0.375rem;
  font-size: 0.9375rem;
  font-weight: 560;
}

.delta.down {
  background: var(--p-red-50);
  color: var(--p-red-700);
}

.delta.up {
  background: var(--p-green-50);
  color: var(--p-green-700);
}

.delta.same {
  background: var(--p-surface-100);
  color: var(--p-text-muted-color);
  font-weight: 400;
  font-size: 0.8125rem;
}

.app-dark .delta.down {
  background: color-mix(in srgb, var(--p-red-500) 18%, transparent);
  color: var(--p-red-300);
}

.app-dark .delta.up {
  background: color-mix(in srgb, var(--p-green-500) 18%, transparent);
  color: var(--p-green-300);
}

.app-dark .delta.same {
  background: var(--p-surface-800);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.chip {
  padding: 0.3rem 0.65rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  cursor: pointer;
}

.chip.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
  font-weight: 560;
}

.chip:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.note {
  margin-top: 0.5rem;
  width: 100%;
  font-size: 0.875rem;
}
</style>
