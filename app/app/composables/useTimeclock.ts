import type { TimeEntryRow } from '@huta/shared/schemas'
import { ApiError, apiFetch } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * Whether the attached person is on the clock, and the two actions.
 *
 * ONE shared piece of state (`useState`, the `useTransfersActionCount` pattern) because two
 * surfaces read it — the home tile and the bar chip — and a disagreement between them would
 * be worse than either being absent. The sale screen's nudge reads it too.
 *
 * STAFF ONLY. An admin has no clock, so every consumer renders nothing for them; `entry`
 * simply stays null and `applies` is false. Worth knowing when testing signed in as an
 * admin, which is most of the time in development.
 */
export function useTimeclock() {
  const entry = useState<TimeEntryRow | null>('timeclock-entry', () => null)
  const busy = useState<boolean>('timeclock-busy', () => false)
  const error = useState<string | null>('timeclock-error', () => null)
  const auth = useAuthStore()

  /** Does a clock apply to whoever is signed in? False for admins and bare terminals. */
  const applies = computed(() => auth.principal?.kind === 'staff')
  const clockedIn = computed(() => entry.value !== null)

  /** Minutes elapsed, recomputed from a ticking clock so the label ages on screen. */
  const now = useState<number>('timeclock-now', () => Date.now())
  let ticker: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    ticker = setInterval(() => (now.value = Date.now()), 30_000)
  })
  onUnmounted(() => clearInterval(ticker))

  const elapsedMinutes = computed(() => {
    if (!entry.value) return 0
    return Math.max(0, Math.floor((now.value - new Date(entry.value.clockedInAt).getTime()) / 60_000))
  })

  /** "39m", "7h 45m" — the one place a duration is worded, so it cannot drift. */
  function formatMinutes(total: number): string {
    const h = Math.floor(total / 60)
    const m = total % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  async function refresh() {
    if (!applies.value) {
      entry.value = null
      return
    }
    try {
      const res = await apiFetch<{ entry: TimeEntryRow | null }>('/timeclock/current')
      entry.value = res.entry
    }
    catch {
      // A status indicator must never take a register page down with it.
      entry.value = null
    }
  }

  async function toggle() {
    if (!applies.value || busy.value) return
    busy.value = true
    error.value = null
    try {
      const path = clockedIn.value ? '/timeclock/clock-out' : '/timeclock/clock-in'
      const row = await apiFetch<TimeEntryRow>(path, { method: 'POST' })
      // Clock-out returns the closed entry; there is no longer an open one.
      entry.value = row.clockedOutAt === null ? row : null
      now.value = Date.now()
    }
    catch (err) {
      error.value = err instanceof ApiError ? err.message : 'Could not reach the server.'
      // Re-read rather than guess: a 409 usually means our idea of the state was stale.
      await refresh()
    }
    finally {
      busy.value = false
    }
  }

  return { entry, applies, clockedIn, elapsedMinutes, formatMinutes, busy, error, refresh, toggle }
}
