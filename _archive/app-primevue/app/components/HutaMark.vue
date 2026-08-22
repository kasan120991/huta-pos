<script setup lang="ts">
/**
 * The wordmark.
 *
 * A single leaf with a centre vein rather than two overlapping halves — at 18px the
 * two-shape version collapsed into something that read as a checkmark. One closed form
 * with a stroke through it survives being small, which is the only size it is ever used
 * at. Drawn rather than sourced so it inherits `currentColor` and works on the green
 * panel and the neutral surface alike.
 *
 * Deliberately abstract, not a seven-point cannabis leaf: this is retail software, and
 * the literal version would date it instantly.
 */
withDefaults(defineProps<{ size?: number; word?: boolean }>(), { size: 18, word: true })
</script>

<template>
  <span class="mark">
    <svg
      class="leaf"
      :width="size"
      :height="size"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2.5c4.4 4.3 6.5 7.8 6.5 11.4a6.5 6.5 0 0 1-13 0C5.5 10.3 7.6 6.8 12 2.5Z"
        fill="currentColor"
        opacity=".92"
      />
      <path
        d="M12 20.5V7.5"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        opacity=".45"
        style="mix-blend-mode: multiply"
      />
    </svg>
    <!--
      A prop rather than a `:deep(.word)` override from the caller: the collapsed sidebar
      needs the leaf alone, and reaching into a component's internals to get it is exactly
      what the house rules forbid.
    -->
    <span v-if="word" class="word">HUTA</span>
  </span>
</template>

<style scoped>
.mark {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 620;
  letter-spacing: 0.14em;
  font-size: 0.8125rem;
}

.leaf {
  flex: none;
}
</style>
