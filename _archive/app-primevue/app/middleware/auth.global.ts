import { useAuthStore } from '~/stores/auth'

/**
 * Route guard for two very different surfaces.
 *
 * The session is resolved HERE rather than in `app.vue`: global middleware runs before the
 * app component's setup on the initial navigation, so resolving there made a reload decide
 * the guard while `principal` was still null — bouncing a signed-in user to login on every
 * refresh despite a valid cookie.
 *
 * The routing decision keys on `terminalId`, not on role. That is what separates "at a
 * register" from "at a desk", and it means an admin who attaches at a terminal lands on
 * the register rather than the dashboard.
 */

/** Reachable with no session at all. An unpaired register presents no cookies. */
const PUBLIC_ROUTES = new Set(['/login', '/register/pair'])

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()

  if (!auth.resolved) await auth.fetchPrincipal()

  const path = to.path

  // --- signed out ---------------------------------------------------------------------
  if (!auth.isAuthenticated) {
    // An unpaired device and a signed-out admin look identical from here — neither has a
    // cookie. So both public routes stay reachable and whoever is setting up a register
    // navigates to /register/pair deliberately, once.
    if (PUBLIC_ROUTES.has(path)) return undefined
    // A register destination without a device session means unpaired — or a device token
    // the seed rotated out from under it. Either way the remedy is pairing, and the
    // back-office login is a dead end for whoever is standing at the counter.
    if (path.startsWith('/register')) return navigateTo('/register/pair')
    return navigateTo('/login')
  }

  // --- at a register ------------------------------------------------------------------
  if (auth.isAtTerminal) {
    // Paired, nobody attached: the only place to be is the sign-in screen.
    if (auth.isUnattendedTerminal) {
      return path === '/register/sign-in' ? undefined : navigateTo('/register/sign-in')
    }
    // Someone is attached. Keep them inside /register — the back office is not their
    // surface, even when the person happens to be an admin.
    if (path === '/register/sign-in' || !path.startsWith('/register')) {
      return navigateTo('/register')
    }
    return undefined
  }

  // --- back office --------------------------------------------------------------------
  // A desk session has no terminal, so the register screens would have no store scope.
  if (path === '/login' || path.startsWith('/register')) return navigateTo('/')

  return undefined
})
