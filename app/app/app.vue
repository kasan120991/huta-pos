<script setup lang="ts">
/**
 * Theme is a class on <html> — see useTheme. Dark by default; the topbar toggle
 * flips it and persists the choice.
 */
const { theme } = useTheme()

useHead({
  htmlAttrs: { class: computed(() => (theme.value === 'dark' ? 'dark' : '')) },
  title: 'Huta POS',
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
