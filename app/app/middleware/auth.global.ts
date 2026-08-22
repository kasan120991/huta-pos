import { useAuthStore } from '~/stores/auth'

/**
 * The signed-out guard. The register surface (when it returns) stays outside it —
 * an unpaired device's remedy is /register/pair, never the back-office login.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith('/register')) return

  const auth = useAuthStore()
  // First navigation resolves the session from cookies — and plants the CSRF cookie
  // the login POST will echo.
  if (!auth.resolved) await auth.fetchPrincipal()

  if (!auth.isAuthenticated && to.path !== '/login') {
    return navigateTo('/login', { replace: true })
  }
  /**
   * A session AT a terminal belongs on the register surface — that includes an admin
   * covering the counter (the guard keys on terminalId, not role) and a bare paired
   * device. The back office is for people at desks.
   */
  if (auth.isAtTerminal) {
    return navigateTo('/register', { replace: true })
  }
  if (auth.isAuthenticated && to.path === '/login') {
    return navigateTo('/', { replace: true })
  }
})
