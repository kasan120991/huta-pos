import type { ScopeStore } from '../auth/store-scope.js'

/**
 * Business days, cut in the STORE's timezone.
 *
 * `Store.timezone`'s schema comment demands exactly that — "never the server's timezone" —
 * and it is not theoretical: sale #0006 was rung at 21:16 Eastern, which UTC calls the next
 * day, so a naive `new Date('2026-08-18T00:00:00')` puts it on the wrong day and the Aug-18
 * filter misses it.
 *
 * Extracted from `sales/history.service.ts` on 2026-08-22, when the drawer list turned out
 * to have grown its OWN range arithmetic — `new Date(\`${from}T00:00:00\`)`, which parses in
 * the SERVER's zone and was therefore already wrong. Same argument as `config/origins.ts`
 * and `auth/store-scope.ts`: two independently derived copies of a rule drift, and here one
 * had drifted before anyone read it twice. One module, both callers.
 */

/**
 * The zone a set of stores is reported in.
 *
 * Every store in this business is `America/New_York`, so an all-stores query has one answer.
 * If that ever stops being true the honest options are to refuse the range or to report
 * per-store; picking the first store's zone and calling it the answer would silently
 * misdate the others. This returns the first zone and NAMES that limitation rather than
 * hiding it behind a condition — an earlier version read `stores.every(…) ? first : first`,
 * whose two branches are identical and which therefore only looked like a decision.
 */
export function scopeTimezone(stores: readonly ScopeStore[]): string {
  return stores[0]?.timezone ?? 'UTC'
}

/** Whether every store in scope agrees, so a caller can tell when the above is a guess. */
export function timezonesAgree(stores: readonly ScopeStore[]): boolean {
  const first = stores[0]?.timezone
  return first === undefined || stores.every((s) => s.timezone === first)
}

/** The offset of `timeZone` from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // `hour` comes back as 24 at midnight under hour12:false in some ICU builds.
  const hour = get('hour') % 24
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return asIfUtc - at.getTime()
}

/**
 * The instant midnight local to `timeZone` on `YYYY-MM-DD`.
 *
 * Two passes, not one: the offset is looked up AT the guessed instant, and on a DST
 * transition day the guess can sit on the wrong side of the change. Re-reading the offset
 * after correcting settles it.
 */
export function zonedStartOfDay(date: string, timeZone: string, addDays = 0): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const naive = Date.UTC(year, month - 1, day + addDays, 0, 0, 0)
  let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  instant = new Date(naive - zoneOffsetMs(instant, timeZone))
  return instant
}

/** `YYYY-MM-DD` local to `timeZone`. en-CA formats exactly that way. */
export function dayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/**
 * The hour of the business day, 0–23, local to `timeZone`.
 *
 * Lives here rather than beside its one caller for the same reason everything else in this
 * file does: `at.getHours()` reads the SERVER's zone, which is the exact bug this module was
 * extracted to stop. A sale rung at 21:16 Eastern is hour 21 of that store's day, never
 * hour 1 of the next one.
 */
export function hourKey(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
  }).format(at)
  // `hour12: false` yields 24 at midnight in some ICU builds — the same wrinkle
  // `zoneOffsetMs` guards against above.
  return Number(hour) % 24
}

/**
 * A half-open instant range for a span of business days, or undefined when unfiltered.
 *
 * HALF-OPEN, deliberately: `[from 00:00, to+1 day 00:00)`. `to` names a whole business day,
 * so a `lte` against the midnight instant would drop everything after 00:00 on that day —
 * i.e. almost all of it. This is the classic off-by-a-day and it is invisible until someone
 * reconciles a total.
 */
export function dayRange(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): { gte?: Date, lt?: Date } | undefined {
  if (from === undefined && to === undefined) return undefined
  return {
    ...(from !== undefined ? { gte: zonedStartOfDay(from, timeZone) } : {}),
    ...(to !== undefined ? { lt: zonedStartOfDay(to, timeZone, 1) } : {}),
  }
}
