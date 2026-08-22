<script setup lang="ts">
import { Delete } from '@lucide/vue'

/**
 * On-screen numeric keypad for the PIN overlay.
 *
 * Touch-first, but NEVER the only way in: the sign-in page feeds the same model from a
 * window-level keydown listener, so an attached keyboard or numpad works without this
 * component ever holding focus. Auto-submits on the final digit — nobody reaches for a
 * separate button with a customer waiting.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    maxLength?: number
    disabled?: boolean
  }>(),
  { maxLength: 4, disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  complete: [value: string]
}>()

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

function press(digit: string) {
  if (props.disabled || props.modelValue.length >= props.maxLength) return
  const next = props.modelValue + digit
  emit('update:modelValue', next)
  if (next.length === props.maxLength) emit('complete', next)
}

function backspace() {
  if (props.disabled) return
  emit('update:modelValue', props.modelValue.slice(0, -1))
}

function clear() {
  if (props.disabled) return
  emit('update:modelValue', '')
}

defineExpose({ press, backspace, clear })
</script>

<template>
  <div class="flex flex-col items-center gap-5">
    <div
      class="flex gap-3"
      role="status"
      :aria-label="`${modelValue.length} of ${maxLength} digits entered`"
    >
      <span
        v-for="i in maxLength"
        :key="i"
        class="size-3.5 rounded-full border-2 transition-colors"
        :class="i <= modelValue.length ? 'border-primary bg-primary' : 'border-input'"
      />
    </div>

    <div class="grid grid-cols-3 gap-2.5">
      <button
        v-for="digit in DIGITS"
        :key="digit"
        type="button"
        class="h-14 w-[4.5rem] rounded-xl bg-accent text-xl font-semibold transition-colors hover:bg-accent/70 active:bg-primary/20 disabled:opacity-50"
        :disabled="disabled"
        @click="press(digit)"
      >
        {{ digit }}
      </button>
      <button
        type="button"
        class="flex h-14 w-[4.5rem] items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
        :disabled="disabled"
        aria-label="Delete last digit"
        @click="backspace"
      >
        <Delete class="size-5" />
      </button>
      <button
        type="button"
        class="h-14 w-[4.5rem] rounded-xl bg-accent text-xl font-semibold transition-colors hover:bg-accent/70 active:bg-primary/20 disabled:opacity-50"
        :disabled="disabled"
        @click="press('0')"
      >
        0
      </button>
      <button
        type="button"
        class="h-14 w-[4.5rem] rounded-xl text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
        :disabled="disabled"
        @click="clear"
      >
        Clear
      </button>
    </div>
  </div>
</template>
