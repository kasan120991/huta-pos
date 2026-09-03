import type { Socket } from 'socket.io-client'
import { type Ref, onMounted, onUnmounted, ref } from 'vue'

/**
 * Keep a screen's data current from realtime events.
 *
 * Kasan's call, 2026-09-03 (Option B): **quiet for figures, held for rows.** A figure or a
 * badge occupies a fixed position, so it restates itself silently and nothing moves under
 * the reader. A list that would INSERT or REORDER rows does not: it holds them behind a
 * count and drops them in when the user says so. So a page that has both — a KPI strip over
 * a ledger — calls this twice:
 *
 *     useLiveData(SALE_EVENTS, () => fetchTotals({ silent: true }))
 *     const live = useLiveData(SALE_EVENTS, () => fetchList({ silent: true }), { defer: true })
 *
 * The page is then never WRONG (its totals move) without ever being jumpy (its rows do not).
 *
 * Four behaviours are not optional, because each is a bug when missing and none is visible
 * until it fails:
 *
 * 1. **Refetch on reconnect.** A socket that drops and returns has missed every event in
 *    between, and nothing tells the page. Without this a laptop that slept shows yesterday's
 *    figures indefinitely — worse than never being live, because the screen looks live. The
 *    three transfer listeners that predate this composable all still have that bug.
 * 2. **Coalesce.** One four-line sale fires `sale.completed` plus up to four `stock.changed`.
 *    A refetch per event is four wasted round trips and four chances to paint a
 *    half-updated screen; a trailing debounce makes it one.
 * 3. **Sleep while hidden.** A background tab must not hit the API every time another till
 *    rings. Events are remembered, not applied, and settle once on return.
 * 4. **Never overlap.** An event landing mid-flight queues the next run rather than racing
 *    it — two concurrent loaders can resolve out of order and leave the older answer up.
 *
 * ⚠️ It deliberately does NOT fetch on mount. Pages already load in their own `onMounted`,
 * usually after resolving auth and in a specific order; a second fetch from here would
 * double every page load and race the first.
 *
 * ⚠️ The payload is never read. The house rule is that a socket event is a hint to
 * refetch, never the thing that makes a change real — so this takes event NAMES and a
 * loader, and offers no way to fold a payload into state. A dropped event costs a slower
 * refresh and nothing else.
 */
export interface LiveData {
  /**
   * How many events are waiting, in `defer` mode. Always 0 otherwise.
   *
   * This counts EVENTS, not rows — one sale is one event. It is what the notice renders, so
   * the copy stays deliberately neutral ("2 updates"): a refund and a void are changes to
   * rows that already exist, and calling either one "new" would be a lie.
   */
  readonly pending: Ref<number>
  /** Apply what is waiting: run the loader and clear the count. */
  readonly apply: () => Promise<void>
}

export function useLiveData(
  events: readonly string[],
  refetch: () => unknown,
  options: { readonly debounceMs?: number, readonly defer?: boolean } = {},
): LiveData {
  const { debounceMs = 250, defer = false } = options
  const { $socket } = useNuxtApp() as unknown as { $socket: Socket | null }

  const pending = ref(0)

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  /** An event arrived mid-flight, or while the tab was hidden. Settle at the next chance. */
  let queued = false
  let disposed = false

  async function run(): Promise<void> {
    if (disposed) return
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      await refetch()
    } catch {
      // A failed background refresh is not this composable's business to report. The page's
      // own loader owns its error surface, and a refetch nobody asked for must not replace
      // what is on screen with an error the user cannot act on.
    } finally {
      running = false
      if (queued && !disposed) {
        queued = false
        void run()
      }
    }
  }

  async function apply(): Promise<void> {
    pending.value = 0
    await run()
  }

  function schedule(): void {
    if (disposed) return

    // Held mode: count it and let the page offer the update. Nothing is fetched, so a busy
    // Saturday costs one number going up rather than a request per sale.
    if (defer) {
      pending.value += 1
      return
    }

    // Hidden tab: remember that something happened and settle when it comes back.
    if (typeof document !== 'undefined' && document.hidden) {
      queued = true
      return
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, debounceMs)
  }

  /**
   * Reconnect catch-up.
   *
   * ⚠️ In `defer` mode this still only OFFERS the update, and cannot say how much was
   * missed — so it registers as one waiting change rather than a true count. Refetching
   * outright would reorder the list under someone who has been reading it, which is the
   * whole thing Option B exists to prevent.
   */
  function onConnect(): void {
    if (defer) {
      if (pending.value === 0) pending.value = 1
      return
    }
    void run()
  }

  function onVisible(): void {
    if (document.hidden || !queued) return
    queued = false
    schedule()
  }

  onMounted(() => {
    for (const name of events) $socket?.on(name, schedule)
    $socket?.on('connect', onConnect)
    document.addEventListener('visibilitychange', onVisible)
  })

  onUnmounted(() => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    for (const name of events) $socket?.off(name, schedule)
    $socket?.off('connect', onConnect)
    document.removeEventListener('visibilitychange', onVisible)
  })

  return { pending, apply }
}

/** The events a completed sale, refund or void moves. Money figures and sale lists. */
export const SALE_EVENTS = ['sale.completed', 'sale.refunded'] as const

/** The event any stock movement produces — sales, deliveries, adjustments, transfers. */
export const STOCK_EVENTS = ['stock.changed'] as const

/** Screens that render both, e.g. a catalog that shows takings or a drawer that shows units. */
export const SALE_AND_STOCK_EVENTS = [...SALE_EVENTS, ...STOCK_EVENTS] as const
