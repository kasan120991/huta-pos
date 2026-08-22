<script setup lang="ts">
import { computed } from 'vue'

/** A person on the register roster. Large tap target; no hover-only affordance. */
const props = defineProps<{
  firstName: string
  lastInitial: string
  disabled?: boolean
}>()

const initials = computed(
  () => `${props.firstName.charAt(0)}${props.lastInitial}`.toUpperCase(),
)
</script>

<template>
  <button type="button" class="tile" :disabled="disabled">
    <span class="initials" aria-hidden="true">{{ initials }}</span>
    <span class="name">{{ firstName }} {{ lastInitial }}.</span>
  </button>
</template>

<style scoped>
.tile {
  display: grid;
  gap: 0.75rem;
  justify-items: center;
  align-content: center;
  min-height: 9.5rem;
  padding: 1.5rem 1rem;
  font: inherit;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.875rem;
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.08s ease;
}

.tile:active:not(:disabled) {
  transform: scale(0.985);
  border-color: var(--p-primary-color);
}

.tile:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 3px;
}

.tile:disabled {
  opacity: 0.5;
  cursor: default;
}

.initials {
  width: 3.75rem;
  height: 3.75rem;
  border-radius: 50%;
  display: grid;
  place-content: center;
  font-size: 1.125rem;
  font-weight: 640;
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 16%, transparent);
}

.name {
  font-size: 1.0625rem;
  font-weight: 560;
}
</style>
