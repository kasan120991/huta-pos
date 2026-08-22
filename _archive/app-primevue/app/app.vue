<script setup lang="ts">
/**
 * The session is resolved in `middleware/auth.global.ts`, not here — global middleware
 * runs before this component's setup on the initial navigation, so resolving here made a
 * reload decide the route guard before `/me` had answered.
 */
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
