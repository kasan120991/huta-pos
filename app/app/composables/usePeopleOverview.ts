import type {
  PayRunRow,
  PayrollPreview,
  PeriodSummary,
  StaffAdminRow,
  TimeEntryPage,
  TimeEntryRow,
} from '@huta/shared/schemas'
import { computed, ref } from 'vue'

import { apiFetch } from '~/composables/useApi'
import { blockerView, type BlockerView } from '~/lib/people-format'

/**
 * Everything the staff command center's overview band needs, in one place.
 *
 * Kept out of `staff.vue` because that page is already 1600 lines and because the exception
 * list wants ONE definition — a lockout, a temporary PIN and a payroll blocker are all
 * "somebody has to do something", and deriving them in three places is how the three drift.
 *
 * ⚠️ It fetches NOTHING per person. `activityFor` is seven aggregate queries per head and
 * its own docblock forbids calling it from an index; every read below is business-wide and
 * fixed in number, whatever the headcount.
 */

/** Anything on this page that needs a human. */
export interface Exception {
  readonly id: string
  readonly label: string
  readonly tone: string
  readonly who: string
  readonly sentence: string
  readonly href: string
  readonly action: string
  /** Red means nothing can be paid or nobody can sign in; amber means a record needs fixing. */
  readonly severe: boolean
}

export interface OnTheClock {
  readonly entryId: string
  readonly userId: string
  readonly userName: string
  readonly storeName: string
  readonly since: string
  readonly minutes: number
}

export function usePeopleOverview() {
  const periods = ref<PeriodSummary[]>([])
  const preview = ref<PayrollPreview | null>(null)
  const runs = ref<PayRunRow[]>([])
  const entries = ref<TimeEntryRow[]>([])
  const loading = ref(false)

  /**
   * Load the whole band.
   *
   * `people` is passed in rather than fetched — `staff.vue` already holds the roster and a
   * second copy could disagree with the table rendered beneath these tiles.
   */
  async function load(): Promise<void> {
    loading.value = true
    try {
      const periodList = await apiFetch<{ periods: PeriodSummary[] }>('/payroll/periods')
      periods.value = periodList.periods

      // The open fortnight is the one accruing. `listPeriods` returns newest first.
      const open = periodList.periods.find((p) => p.inProgress) ?? periodList.periods[0] ?? null

      const [entryPage, previewed, runList] = await Promise.all([
        // ⚠️ No `userId` — this is the business-wide read, which is what makes "who is on
        // the clock" answerable without one call per person.
        open
          ? apiFetch<TimeEntryPage>('/timeclock/entries', {
              query: { from: open.periodStartDate, to: open.periodEndDate },
            })
          : Promise.resolve(null),
        // ⚠️ ONE preview, for the open period only. `previewRun` WRITES (it resolves
        // abandoned entries first), so calling it per period in a loop would be both slow
        // and repeatedly side-effecting.
        open
          ? apiFetch<PayrollPreview>('/payroll/preview', {
              query: { periodStart: open.periodStartDate },
            }).catch(() => null)
          : Promise.resolve(null),
        apiFetch<{ runs: PayRunRow[] }>('/payroll/runs').catch(() => ({ runs: [] })),
      ])

      entries.value = entryPage ? [...entryPage.entries] : []
      preview.value = previewed
      runs.value = [...runList.runs]
    } finally {
      loading.value = false
    }
  }

  /** Who is working this minute, longest first — the one who has been on longest matters most. */
  const onTheClock = computed<OnTheClock[]>(() =>
    entries.value
      .filter((e) => e.status === 'OPEN')
      .map((e) => ({
        entryId: e.id,
        userId: e.userId,
        userName: e.userName,
        storeName: e.storeName,
        since: e.clockedInAt,
        minutes: Math.max(0, Math.round((Date.now() - new Date(e.clockedInAt).getTime()) / 60_000)),
      }))
      .sort((a, b) => b.minutes - a.minutes),
  )

  /**
   * ⚠️ What is accruing does NOT include anyone currently on the clock.
   *
   * `previewRun` only pays `CLOCKED` and `CORRECTED` entries; an `OPEN` one is not payable
   * and surfaces as a blocker instead. So this figure and `onTheClock` are separate facts
   * and must never be added together or presented as one number.
   */
  const accruingCents = computed(() => preview.value?.grossCents ?? 0)
  const accruingMinutes = computed(() => preview.value?.totalMinutes ?? 0)

  /** Money committed on a run and not yet handed over. Reversed runs are already superseded. */
  const owedCents = computed(() =>
    runs.value
      .filter((r) => r.status !== 'REVERSED')
      .reduce((n, r) => n + r.outstandingCents, 0),
  )

  const openPeriod = computed(() => periods.value.find((p) => p.inProgress) ?? null)

  /**
   * Everything needing a human, most severe first.
   *
   * Three sources, one list: a lockout (nobody can sign in), a temporary PIN nobody has
   * used, and payroll's own blockers (nothing can be paid). They are one list because to
   * whoever is reading the page they are one question.
   */
  function exceptionsFor(people: readonly StaffAdminRow[]): Exception[] {
    const out: Exception[] = []

    for (const p of people) {
      if (!p.active) continue
      const who = `${p.firstName} ${p.lastName}`.trim()

      if (p.lockedUntil !== null && new Date(p.lockedUntil) > new Date()) {
        out.push({
          id: `lock-${p.id}`,
          label: 'Locked out',
          tone: 'bg-red-400/15 text-red-400',
          who,
          sentence: 'is locked out and cannot sign in at a till',
          href: `/admin/staff?person=${p.id}`,
          action: 'Clear the lockout →',
          severe: true,
        })
      } else if (p.failedPinAttempts >= 3) {
        // Not yet locked, but close enough that it is worth saying before it happens at a
        // till mid-shift rather than after.
        out.push({
          id: `pin-${p.id}`,
          label: 'PIN',
          tone: 'bg-amber-500/15 text-amber-500',
          who,
          sentence: `has ${p.failedPinAttempts} failed PIN attempts — ${5 - p.failedPinAttempts} more locks them out`,
          href: `/admin/staff?person=${p.id}`,
          action: 'Reset the PIN →',
          severe: false,
        })
      }

      if (p.mustChangePin) {
        out.push({
          id: `temp-${p.id}`,
          label: 'Temporary PIN',
          tone: 'bg-amber-500/15 text-amber-500',
          who,
          sentence: 'has a temporary PIN they have not replaced — it will not open a session',
          href: `/admin/staff?person=${p.id}`,
          action: 'Reset the PIN →',
          severe: false,
        })
      }
    }

    for (const b of preview.value?.blockers ?? []) {
      const v: BlockerView = blockerView(b)
      out.push({
        id: `blk-${b.userId}-${b.timeEntryId ?? b.weekStartDate ?? b.kind}`,
        label: v.label,
        tone: v.tone,
        who: b.userName,
        sentence: v.sentence,
        href: v.href,
        action: v.action,
        severe: b.kind === 'NO_WAGE_RATE',
      })
    }

    return out.sort((a, b) => Number(b.severe) - Number(a.severe))
  }

  return {
    loading,
    load,
    onTheClock,
    accruingCents,
    accruingMinutes,
    owedCents,
    openPeriod,
    preview,
    exceptionsFor,
  }
}
