<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">Dashboard</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Welcome back, {{ auth.displayName }}.
      </p>
    </div>
    <div class="grid auto-rows-min gap-4 md:grid-cols-3">
      <div class="aspect-video rounded-xl bg-muted/50" />
      <div class="aspect-video rounded-xl bg-muted/50" />
      <div class="aspect-video rounded-xl bg-muted/50" />
    </div>
    <div class="min-h-64 flex-1 rounded-xl bg-muted/50" />
  </div>
</template>
