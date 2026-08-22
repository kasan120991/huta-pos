<script setup lang="ts">
import { useShell } from '~/composables/useShell'

/**
 * The back-office shell.
 *
 * A full-height sidebar with the topbar to its right, so the topbar belongs to the page
 * rather than to the whole app. The shell owns the viewport; `<main>` scrolls on its own
 * while the sidebar and topbar stay put.
 *
 * That last part is why `--shell-topbar-h` is published here rather than hard-coded: the
 * catalog's filter rail and the pricing preview are `position: sticky` inside `<main>`, and
 * both need to know how much chrome sits above them. One variable beats the same magic
 * number drifting apart in two files.
 *
 * `--shell-side-w` exists for the same reason in reverse — nothing reads it today, but the
 * grid and the drawer breakpoint have to agree, and agreeing through a name is safer than
 * agreeing by coincidence.
 *
 * This layout is admin-only in practice: staff have no password and any session carrying a
 * `terminalId` is redirected into `/register` by the global route guard. No role conditionals
 * are needed here.
 */

const { collapsed } = useShell()
</script>

<template>
  <div class="shell" :class="{ railed: collapsed }">
    <!-- First in tab order, visible only when focused. -->
    <a class="skip" href="#main">Skip to content</a>

    <AppSidebar />
    <AppTopbar />

    <main id="main" class="content" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell {
  --shell-topbar-h: 3.25rem;
  --shell-side-w: 13rem;
  --shell-rail-w: 3.5rem;

  height: 100dvh;
  display: grid;
  /*
   * The first track is `auto` and the SIDEBAR owns its own width, rather than the grid
   * setting it and transitioning between two values.
   *
   * `transition: grid-template-columns` looks like the obvious way to animate a collapse and
   * does not work: with an `fr` track in the list the interpolation silently fails, and the
   * computed value stays at the pre-toggle width forever. The class flips, the sidebar does
   * not move, and nothing reports an error. Transitioning a plain `width` on the sidebar is
   * both reliable and cheaper to composite.
   */
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: var(--shell-topbar-h) minmax(0, 1fr);
  grid-template-areas:
    'side top'
    'side main';
}

.content {
  grid-area: main;
  overflow-y: auto;
  padding: clamp(1.25rem, 1rem + 2vw, 2.5rem);

  /*
   * The sizing context for every page's layout.
   *
   * Page grids query THIS, not the viewport. A sidebar shrinks the content box without
   * shrinking the window, so viewport queries fire late — at 1240px a page would still
   * believe it had room for two columns while it actually had about 1000px. Raising the
   * breakpoints instead would then be wrong the other way once the sidebar is a rail.
   */
  container-type: inline-size;
  container-name: content;
}

/* Focus target only — never show a ring around the whole page. */
.content:focus {
  outline: none;
}

.skip {
  position: absolute;
  z-index: 60;
  top: 0.5rem;
  left: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--p-primary-contrast-color, #fff);
  background: var(--p-primary-color);
  border-radius: 0.375rem;
  text-decoration: none;
  transform: translateY(-200%);
}

.skip:focus-visible {
  transform: none;
  outline: 2px solid var(--p-text-color);
  outline-offset: 2px;
}

/*
 * Below this the sidebar leaves the layout entirely and becomes an overlay drawer, so the
 * grid drops to a single column. Keep in step with DRAWER_BREAKPOINT in useShell.ts.
 */
@media (max-width: 900px) {
  .shell,
  .shell.railed {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'top'
      'main';
  }
}

</style>
