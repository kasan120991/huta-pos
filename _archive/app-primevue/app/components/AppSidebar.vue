<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { NAV, matchNav } from '~/config/nav'
import { useShell } from '~/composables/useShell'

/**
 * The back-office navigation.
 *
 * Two modes in one component: part of the layout on a wide screen (expanded, or a collapsed
 * icon rail), and an overlay drawer below the breakpoint. They share markup because they are
 * the same list — only the framing differs.
 *
 * COLLAPSED HIDES LABELS VISUALLY, NEVER REMOVES THEM. `v-if`-ing the text out would strip
 * the accessible name and leave a screen reader announcing "link" seven times. The label
 * stays in the DOM under `.vh` and comes back as a tooltip on hover or focus.
 */

const { collapsed, drawerOpen, toggleCollapsed, closeDrawer } = useShell()

const route = useRoute()
const nav = ref<HTMLElement | null>(null)

const activeItem = computed(() => matchNav(route.path)?.item ?? null)

function isActive(to: string): boolean {
  return activeItem.value?.to === to
}

/**
 * Choosing a destination closes the drawer.
 *
 * On a narrow screen you are otherwise left looking at the menu you just used, with the page
 * you asked for hidden behind it.
 */
watch(
  () => route.path,
  () => closeDrawer(),
)

// --- drawer focus management --------------------------------------------------------------

let returnFocusTo: HTMLElement | null = null

function focusableInDrawer(): HTMLElement[] {
  if (!nav.value) return []
  return [...nav.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
}

/** Keep Tab inside the drawer while it is open. */
function onKeydown(event: KeyboardEvent): void {
  if (!drawerOpen.value) return

  if (event.key === 'Escape') {
    event.preventDefault()
    closeDrawer()
    return
  }

  if (event.key !== 'Tab') return

  const items = focusableInDrawer()
  if (items.length === 0) return

  const first = items[0]!
  const last = items[items.length - 1]!
  const active = document.activeElement as HTMLElement | null

  if (event.shiftKey && (active === first || !nav.value?.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(drawerOpen, async (open) => {
  if (typeof document === 'undefined') return

  if (open) {
    returnFocusTo = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onKeydown)
    // The page behind must not scroll under the drawer.
    document.body.style.overflow = 'hidden'
    await nextTick()
    focusableInDrawer()[0]?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    document.body.style.overflow = ''
    // Focus goes back where it came from, not to the top of the document.
    returnFocusTo?.focus()
    returnFocusTo = null
  }
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <!-- The scrim only exists while the drawer is open, so it cannot swallow clicks otherwise. -->
  <div v-if="drawerOpen" class="scrim" @click="closeDrawer" />

  <nav
    id="app-sidebar"
    ref="nav"
    class="side"
    :class="{ rail: collapsed, drawer: drawerOpen }"
    aria-label="Main"
  >
    <div class="brandrow">
      <NuxtLink to="/" class="brandlink" :aria-label="'Huta — dashboard'">
        <HutaMark :word="!collapsed" />
      </NuxtLink>
    </div>

    <div class="groups">
      <template v-for="(group, gi) in NAV" :key="group.label ?? `g${gi}`">
        <!--
          The heading is decorative when collapsed — a two-letter stub of "PURCHASING" reads
          as noise — but it stays in the accessible tree so the grouping survives.
        -->
        <p v-if="group.label" class="grp" :class="{ vh: collapsed }">{{ group.label }}</p>

        <NuxtLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="item"
          :class="{ on: isActive(item.to) }"
          :aria-current="isActive(item.to) ? 'page' : undefined"
          :title="collapsed ? item.label : undefined"
        >
          <i :class="item.icon" aria-hidden="true" />
          <span :class="{ vh: collapsed }">{{ item.label }}</span>
        </NuxtLink>
      </template>
    </div>

    <div class="foot">
      <!-- Hidden on narrow screens: in drawer mode there is nothing to collapse to. -->
      <button
        type="button"
        class="item collapse"
        :aria-expanded="!collapsed"
        aria-controls="app-sidebar"
        :title="collapsed ? 'Expand sidebar' : undefined"
        @click="toggleCollapsed"
      >
        <i :class="collapsed ? 'pi pi-angle-double-right' : 'pi pi-angle-double-left'" aria-hidden="true" />
        <span :class="{ vh: collapsed }">Collapse</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.6rem 0.5rem;
  background: var(--p-surface-0);
  border-right: 1px solid var(--p-content-border-color);
  overflow-y: auto;
  overflow-x: hidden;

  /*
   * The sidebar sets its OWN width and the grid's `auto` track follows. See the layout for
   * why this is not `transition: grid-template-columns` — that silently fails to interpolate
   * when the track list contains an `fr`.
   */
  width: var(--shell-side-w);
  transition: width 140ms ease;
}

.side.rail {
  width: var(--shell-rail-w);
}

.app-dark .side {
  background: var(--p-surface-900);
}

.brandrow {
  display: flex;
  align-items: center;
  padding: 0.25rem 0.4rem 0.75rem;
}

.side.rail .brandrow {
  justify-content: center;
  padding-inline: 0;
}

.brandlink {
  display: inline-flex;
  color: var(--p-text-color);
  text-decoration: none;
  border-radius: 0.375rem;
}

.brandlink :deep(.leaf) {
  color: var(--p-primary-color);
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.grp {
  margin: 0.75rem 0 0.2rem;
  padding: 0 0.45rem;
  font-size: 0.625rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--p-text-muted-color);
}

.item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.4rem 0.45rem;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  color: var(--p-text-muted-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}

.item i {
  width: 1rem;
  flex: none;
  font-size: 0.9375rem;
  text-align: center;
}

.item:hover {
  background: var(--p-surface-100);
  color: var(--p-text-color);
}

.app-dark .item:hover {
  background: var(--p-surface-800);
}

.item.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
  font-weight: 560;
}

.item:focus-visible,
.brandlink:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.side.rail .item {
  justify-content: center;
  gap: 0;
  padding-inline: 0.45rem;
}

.foot {
  margin-top: auto;
  padding-top: 0.5rem;
}

/*
 * Visually hidden, still announced. The label must survive collapsing — removing it would
 * leave a screen reader with seven links called "link".
 */
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(10, 14, 10, 0.45);
}

.side.drawer {
  position: fixed;
  z-index: 50;
  inset-block: 0;
  inset-inline-start: 0;
  width: 15rem;
  box-shadow: 0 0 40px -8px rgba(0, 0, 0, 0.35);
}

/*
 * Below the breakpoint the sidebar is NOT part of the layout — it only exists as the drawer.
 *
 * Hiding it is not optional. The shell drops the `side` grid area at this width, but dropping
 * a named area does not remove the element that claims it: the browser auto-places the
 * orphan into an implicit column, which put the whole sidebar down the right-hand edge with
 * the page squashed beside it. Keep this in step with the shell's own 900px query.
 */
@media (max-width: 900px) {
  .side:not(.drawer) {
    display: none;
  }
}
</style>
