import { computed, ref, watch } from 'vue'

/**
 * Back-office shell state: is the sidebar collapsed, and is the app in dark mode.
 *
 * Module-level refs rather than a Pinia store — this is chrome preference, not application
 * state. Nothing on the server knows or cares, and no page reads it except the shell itself.
 *
 * Both choices persist. A desk that wants the extra width keeps it between sessions, and a
 * shop that works under low light does not re-pick its theme every morning.
 *
 * Safe to touch `localStorage` directly: the app is `ssr: false`, so there is no server
 * context this can run in. The `typeof window` guards are belt and braces for the Nitro
 * prerender pass, which does briefly evaluate modules.
 */

const COLLAPSED_KEY = 'huta.shell.collapsed'
const THEME_KEY = 'huta.shell.theme'
const DARK_CLASS = 'app-dark'

/** Below this the sidebar stops being part of the layout and becomes a drawer. */
export const DRAWER_BREAKPOINT = 900

function read(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Private browsing and some kiosk configurations throw on access rather than returning
    // null. A shell that cannot remember a preference is fine; one that fails to render is not.
    return null
  }
}

function write(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* see read() */
  }
}

const collapsed = ref(read(COLLAPSED_KEY) === '1')

/**
 * Light unless someone chose otherwise.
 *
 * House rule: the theme is a class selector rather than `system` because "a POS runs under
 * fixed store lighting and staff should be able to pick". So we do not follow
 * `prefers-color-scheme` — an unset preference means light, and the choice is theirs.
 */
const dark = ref(read(THEME_KEY) === 'dark')

/** The mobile drawer. Deliberately NOT persisted — it always opens closed. */
const drawerOpen = ref(false)

watch(collapsed, (value) => write(COLLAPSED_KEY, value ? '1' : '0'))

watch(
  dark,
  (value) => {
    write(THEME_KEY, value ? 'dark' : 'light')
    if (typeof document === 'undefined') return
    // On <html>, not <body>. Every rule in the app is written as an ancestor selector
    // (`.app-dark body`, `.app-dark .bar`), so on <body> it would match nothing.
    document.documentElement.classList.toggle(DARK_CLASS, value)
  },
  { immediate: true },
)

export function useShell() {
  return {
    collapsed,
    dark,
    drawerOpen,
    isDark: computed(() => dark.value),
    toggleCollapsed: () => {
      collapsed.value = !collapsed.value
    },
    toggleTheme: () => {
      dark.value = !dark.value
    },
    openDrawer: () => {
      drawerOpen.value = true
    },
    closeDrawer: () => {
      drawerOpen.value = false
    },
  }
}
