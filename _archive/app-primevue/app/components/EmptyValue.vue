<script setup lang="ts">
/**
 * A value the data genuinely does not have.
 *
 * Its own component because absence is the COMMON case here, not the edge: 39% of
 * products carry no cannabinoid, 81% of variants no cost, 14% no brand. Saying what is
 * missing beats an em dash that could equally mean zero, unknown or broken.
 */
defineProps<{ label?: string }>()
</script>

<template>
  <span class="empty">{{ label ?? '—' }}</span>
</template>

<style scoped>
.empty {
  color: var(--p-text-muted-color);
  font-style: italic;
  font-size: 0.8125rem;
}
</style>
