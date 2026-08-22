<script setup lang="ts">
import { computed } from 'vue'

/**
 * On-screen numeric keypad.
 *
 * The register is a touchscreen, but a keyboard may still be attached and barcode
 * scanners type — so this writes into the same model the masked field reads, and never
 * becomes the only way to enter a PIN.
 */

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** zPin allows 4–6 digits, so this is not hard-coded to 4 anywhere. */
    maxLength?: number
    disabled?: boolean
  }>(),
  { maxLength: 4, disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  complete: [value: string]
  cancel: []
}>()

const dots = computed(() =>
  Array.from({ length: props.maxLength }, (_, i) => i < props.modelValue.length),
)

function press(digit: string): void {
  if (props.disabled || props.modelValue.length >= props.maxLength) return
  const next = props.modelValue + digit
  emit('update:modelValue', next)
  // Auto-submit on the last digit: nobody wants to reach for a separate button with a
  // customer waiting.
  if (next.length === props.maxLength) emit('complete', next)
}

function backspace(): void {
  if (props.disabled) return
  emit('update:modelValue', props.modelValue.slice(0, -1))
}

function clear(): void {
  if (props.disabled) return
  emit('update:modelValue', '')
}
</script>

<template>
  <div class="pad">
    <div class="dots" role="status" :aria-label="`${modelValue.length} of ${maxLength} digits entered`">
      <span v-for="(filled, i) in dots" :key="i" :class="{ on: filled }" />
    </div>

    <div class="keys">
      <button
        v-for="digit in ['1', '2', '3', '4', '5', '6', '7', '8', '9']"
        :key="digit"
        type="button"
        class="key"
        :disabled="disabled"
        @click="press(digit)"
      >
        {{ digit }}
      </button>

      <button type="button" class="key ghost" :disabled="disabled" @click="clear">Clear</button>
      <button type="button" class="key" :disabled="disabled" @click="press('0')">0</button>
      <button
        type="button"
        class="key ghost"
        :disabled="disabled"
        aria-label="Delete last digit"
        @click="backspace"
      >
        ⌫
      </button>
    </div>

    <Button label="Cancel" severity="secondary" variant="text" fluid @click="emit('cancel')" />
  </div>
</template>

<style scoped>
.pad {
  display: grid;
  gap: 1.25rem;
  justify-items: center;
  width: 100%;
}

.dots {
  display: flex;
  gap: 0.75rem;
}

.dots span {
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 50%;
  border: 2px solid var(--p-surface-300);
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.app-dark .dots span {
  border-color: var(--p-surface-600);
}

.dots span.on {
  background: var(--p-primary-color);
  border-color: var(--p-primary-color);
}

.keys {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  width: 100%;
}

/*
 * 5.5rem (88px) minimum, roughly square once the grid gives each key its width. Twice the
 * ~44px touch-target floor, because this is tapped with a thumb at speed by someone
 * looking at the customer rather than the screen.
 */
.key {
  min-height: 5.5rem;
  font: inherit;
  font-size: 1.75rem;
  font-weight: 520;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.75rem;
  cursor: pointer;
  /* No hover-only affordance — on a touchscreen hover never happens. */
  transition: background-color 0.1s ease;
}

.key:active:not(:disabled) {
  background: var(--p-surface-200);
}

.app-dark .key:active:not(:disabled) {
  background: var(--p-surface-700);
}

.key:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.key:disabled {
  opacity: 0.45;
  cursor: default;
}

.key.ghost {
  font-size: 1rem;
  background: transparent;
  border-color: transparent;
  color: var(--p-text-muted-color);
}
</style>
