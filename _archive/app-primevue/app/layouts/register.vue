<template>
  <div class="register-shell">
    <slot />
  </div>
</template>

<style scoped>
/*
 * Full bleed, no chrome. A register is a fixed landscape screen in a shop — there is no
 * navigation to offer and nothing above the fold to compete with.
 */
.register-shell {
  min-height: 100dvh;
  display: grid;
  background: var(--p-surface-100);
}

.app-dark .register-shell {
  background: var(--p-surface-950);
}
</style>
