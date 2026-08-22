<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'

/**
 * The register's one strip of chrome: the mark on the left, WHERE this register is on
 * the right — how a mis-paired machine gets noticed at a glance rather than at opening.
 */
const auth = useAuthStore()
</script>

<template>
  <header class="flex h-12 shrink-0 items-center gap-3 px-5 text-sm text-muted-foreground">
    <span class="flex items-center gap-2 font-semibold tracking-tight text-foreground">
      <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11Z" stroke="currentColor" stroke-width="1.6" />
        <path d="M12 8v11" stroke="currentColor" stroke-width="1.6" />
      </svg>
      Huta
    </span>
    <span v-if="auth.registerLabel" class="ml-auto">{{ auth.registerLabel }}</span>
    <slot />
  </header>
</template>
