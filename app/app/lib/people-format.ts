import type { PayrollBlocker } from '@huta/shared/schemas'

/**
 * The shared vocabulary for talking about people — payroll blockers, days, periods.
 *
 * Extracted from `pages/admin/payroll/index.vue` on 2026-09-03 when the staff command
 * center became a second consumer. The same rule as `lib/sale-format.ts`: a sentence that
 * describes a blocker must read identically wherever it appears, and two hand-written
 * copies drift the first time one of them is edited.
 */

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

/**
 * ⚠️ A bare `YYYY-MM-DD` is parsed as UTC midnight by spec, so in any western zone it
 * formats as the PREVIOUS day. Parsing at noon puts it far enough from either boundary that
 * no offset can move it. The same trap `lib/business-day.ts` exists for on the server.
 */
export const payDay = (date: string): string => DAY.format(new Date(`${date}T12:00:00`))

/** "Aug 23 – Sep 5" — how a fortnight is named everywhere. */
export const periodLabel = (p: { periodStartDate: string, periodEndDate: string }): string =>
  `${payDay(p.periodStartDate)} – ${payDay(p.periodEndDate)}`

/** "8:04 AM" — a clock time from an ISO instant, in the reader's own zone. */
export const clockTime = (iso: string): string => CLOCK.format(new Date(iso))

export interface BlockerView {
  /** The short pill: what KIND of problem this is. */
  readonly label: string
  /** Tailwind classes for the pill. Red is "nothing can be paid", amber is "fix the record". */
  readonly tone: string
  /** The sentence AFTER the person's name, so a caller renders `<b>{name}</b> {sentence}`. */
  readonly sentence: string
  /** Where the fix lives. */
  readonly href: string
  /** The button's words. */
  readonly action: string
}

const LABEL: Record<string, { label: string, tone: string }> = {
  OPEN_ENTRY: { label: 'Still clocked in', tone: 'bg-amber-500/15 text-amber-500' },
  ESTIMATED_ENTRY: { label: 'Estimated', tone: 'bg-amber-500/15 text-amber-500' },
  NO_WAGE_RATE: { label: 'No wage', tone: 'bg-red-400/15 text-red-400' },
}

/**
 * One payroll blocker, ready to render.
 *
 * ⚠️ An unknown kind falls back to the raw string rather than disappearing — the same rule
 * the audit-label map follows, and for the same reason: a blocker nobody can see is a
 * fortnight nobody can pay, and appearing unlabelled beats vanishing.
 */
export function blockerView(b: PayrollBlocker): BlockerView {
  const known = LABEL[b.kind] ?? { label: b.kind, tone: 'bg-amber-500/15 text-amber-500' }

  if (b.kind === 'NO_WAGE_RATE') {
    return {
      ...known,
      sentence: `worked this fortnight, but no hourly rate is on file for the week of ${payDay(b.weekStartDate ?? '')}`,
      href: `/admin/staff?person=${b.userId}&tab=overview`,
      action: 'Set a wage →',
    }
  }

  const on = b.at ? WEEKDAY.format(new Date(b.at)) : 'that fortnight'
  return {
    ...known,
    sentence:
      b.kind === 'OPEN_ENTRY'
        ? `clocked in ${on} and is still on the clock`
        : `clocked in ${on} and never clocked out — the end time is a guess`,
    href: `/admin/staff?person=${b.userId}&tab=hours`,
    action: 'Fix the entry →',
  }
}
