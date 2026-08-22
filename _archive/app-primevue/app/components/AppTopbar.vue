<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { matchNav } from '~/config/nav'
import { useShell } from '~/composables/useShell'
import { useAuthStore } from '~/stores/auth'

/**
 * The topbar belongs to the page, not to the app.
 *
 * It carries where you are and who you are, and nothing else. Two things it deliberately
 * does NOT carry:
 *
 *   * A store switcher. Only the catalog reads `catalog.selectedStoreId`; every admin page
 *     has its own store select and ignores it. A switcher up here would imply a scope the
 *     rest of the app does not honour.
 *   * The page title. All eight pages already render an `<h1>` with a page-specific,
 *     pluralised count beside it. The breadcrumb names the section; the page names itself.
 */

const { collapsed, drawerOpen, dark, toggleCollapsed, openDrawer, toggleTheme } = useShell()

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const menuOpen = ref(false)
const menuRoot = ref<HTMLElement | null>(null)
const signingOut = ref(false)

const crumb = computed(() => matchNav(route.path))

/** Closes on navigation — a menu left hanging over a new page is a bug people report. */
watch(() => route.path, () => { menuOpen.value = false })

function onDocumentPointer(event: PointerEvent): void {
  if (!menuRoot.value?.contains(event.target as Node)) menuOpen.value = false
}

function onDocumentKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') menuOpen.value = false
}

watch(menuOpen, (open) => {
  if (typeof document === 'undefined') return
  if (open) {
    document.addEventListener('pointerdown', onDocumentPointer)
    document.addEventListener('keydown', onDocumentKey)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointer)
    document.removeEventListener('keydown', onDocumentKey)
  }
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('pointerdown', onDocumentPointer)
  document.removeEventListener('keydown', onDocumentKey)
})

async function signOut(): Promise<void> {
  signingOut.value = true
  try {
    await auth.logout()
    await router.push('/login')
  } finally {
    signingOut.value = false
  }
}

/**
 * One control, two jobs, because there are two states to be in.
 *
 * Wide: collapse the sidebar to a rail. Narrow: the sidebar is not in the layout at all, so
 * the same button opens the drawer.
 */
function onToggle(): void {
  if (window.matchMedia('(max-width: 900px)').matches) openDrawer()
  else toggleCollapsed()
}
</script>

<template>
  <header class="top">
    <button
      type="button"
      class="iconbtn"
      :aria-expanded="drawerOpen || !collapsed"
      aria-controls="app-sidebar"
      :aria-label="collapsed ? 'Expand navigation' : 'Collapse navigation'"
      @click="onToggle"
    >
      <i class="pi pi-bars" aria-hidden="true" />
    </button>

    <!--
      Section › page. Not a link trail — the section headings have no pages of their own, so
      linking them would promise a destination that does not exist.
    -->
    <nav v-if="crumb" class="crumbs" aria-label="Breadcrumb">
      <span v-if="crumb.group.label" class="sect">{{ crumb.group.label }}</span>
      <span v-if="crumb.group.label" class="sep" aria-hidden="true">›</span>
      <span class="cur" aria-current="page">{{ crumb.item.label }}</span>
    </nav>

    <div class="spacer" />

    <button
      type="button"
      class="iconbtn"
      :aria-pressed="dark"
      :aria-label="dark ? 'Switch to light theme' : 'Switch to dark theme'"
      @click="toggleTheme"
    >
      <i :class="dark ? 'pi pi-sun' : 'pi pi-moon'" aria-hidden="true" />
    </button>

    <div ref="menuRoot" class="account">
      <button
        type="button"
        class="acctbtn"
        :aria-expanded="menuOpen"
        aria-haspopup="menu"
        @click="menuOpen = !menuOpen"
      >
        <span class="avatar" aria-hidden="true">{{ auth.initials || '—' }}</span>
        <span class="who">{{ auth.displayName ?? 'Account' }}</span>
        <i class="pi pi-angle-down" aria-hidden="true" />
      </button>

      <div v-if="menuOpen" class="menu" role="menu">
        <div class="meta">
          <span class="mname">{{ auth.displayName ?? 'Signed in' }}</span>
          <span v-if="auth.user?.email" class="memail">{{ auth.user.email }}</span>
          <span class="mrole">{{ auth.principal?.role ?? '' }}</span>
        </div>
        <button
          type="button"
          class="mitem"
          role="menuitem"
          :disabled="signingOut"
          @click="signOut"
        >
          <i class="pi pi-sign-out" aria-hidden="true" />
          {{ signingOut ? 'Signing out…' : 'Sign out' }}
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.top {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: var(--shell-topbar-h);
  padding: 0 1rem;
  background: var(--p-surface-0);
  border-bottom: 1px solid var(--p-content-border-color);
}

.app-dark .top {
  background: var(--p-surface-900);
}

.iconbtn {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  flex: none;
  font: inherit;
  color: var(--p-text-muted-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  cursor: pointer;
}

.iconbtn:hover {
  background: var(--p-surface-100);
  color: var(--p-text-color);
}

.app-dark .iconbtn:hover {
  background: var(--p-surface-800);
}

.iconbtn:focus-visible,
.acctbtn:focus-visible,
.mitem:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8125rem;
  min-width: 0;
}

.sect,
.sep {
  color: var(--p-text-muted-color);
}

.cur {
  color: var(--p-text-color);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.account {
  position: relative;
}

.acctbtn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0.5rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--p-text-color);
  background: transparent;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
  cursor: pointer;
}

.acctbtn:hover {
  background: var(--p-surface-100);
}

.app-dark .acctbtn:hover {
  background: var(--p-surface-800);
}

.avatar {
  display: grid;
  place-items: center;
  width: 1.375rem;
  height: 1.375rem;
  flex: none;
  border-radius: 50%;
  font-size: 0.625rem;
  font-weight: 700;
  background: color-mix(in srgb, var(--p-primary-color) 16%, transparent);
  color: var(--p-primary-color);
}

.acctbtn i {
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
}

.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 0.35rem);
  z-index: 30;
  min-width: 13rem;
  display: grid;
  gap: 0.2rem;
  padding: 0.35rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  box-shadow: 0 10px 30px -12px rgba(16, 24, 16, 0.35);
}

.meta {
  display: grid;
  gap: 0.05rem;
  padding: 0.45rem 0.5rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  margin-bottom: 0.2rem;
}

.mname {
  font-size: 0.875rem;
  font-weight: 620;
}

.memail {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
}

.mrole {
  margin-top: 0.15rem;
  justify-self: start;
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.mitem {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  color: var(--p-text-color);
  background: transparent;
  border: none;
  border-radius: 0.3rem;
  cursor: pointer;
}

.mitem:hover:not(:disabled) {
  background: var(--p-surface-100);
}

.app-dark .mitem:hover:not(:disabled) {
  background: var(--p-surface-800);
}

.mitem i {
  color: var(--p-text-muted-color);
  font-size: 0.8125rem;
}

@media (max-width: 640px) {
  /* The avatar still identifies the account; the name is the first thing that can go. */
  .who {
    display: none;
  }
}
</style>
