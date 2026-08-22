<script setup lang="ts">
import { Toaster } from '~/components/ui/sonner'
</script>

<template>
  <!--
    Full bleed, no chrome. A register is a fixed landscape screen in a shop — there is
    no navigation to offer and nothing above the fold to compete with.
  -->
  <div class="flex min-h-dvh flex-col bg-background text-foreground">
    <slot />

    <!--
      Toasts land TOP RIGHT (Kasan, 2026-08-22) and stay until dismissed. `offset` clears
      the 48px RegisterBar, whose right edge carries the store · register label — a toast
      that never leaves on its own must not sit on top of which till you are standing at.
      `duration: Infinity` is the persistence; `closeButton` is how it goes away.
    -->
    <Toaster
      position="top-right"
      :offset="{ top: '56px', right: '16px' }"
      close-button
      :duration="Infinity"
      :visible-toasts="4"
      expand
    />
  </div>
</template>
