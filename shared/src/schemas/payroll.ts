import type { PayoutMethod, PayRunStatus } from '../enums.js'

/**
 * The payroll wire contract.
 *
 * ⚠️ GROSS PAY ONLY. Every money figure here is what was EARNED, before any deduction —
 * nothing in this system withholds tax, computes net pay, or files anything. A screen must
 * never label one of these "take-home", and the figure is handed to a payroll provider or an
 * accountant to withhold from.
 *
 * Hourly, non-exempt staff only. There is no salary concept and no exempt flag.
 */

/** One hourly rate, effective from a Sunday. */
export interface WageRateRow {
  readonly id: string
  readonly userId: string
  readonly ratePerHourCents: number
  /**
   * Always a Sunday. A rate supplied for any other day is snapped BACK to the Sunday of that
   * week, so a workweek always carries exactly one rate.
   */
  readonly effectiveFromDate: string
  readonly setByName: string
  readonly note: string | null
  readonly createdAt: string
  /** The row in force right now — what a screen shows as "the" wage. */
  readonly current: boolean
}

/** Why a fortnight cannot be paid yet. Never a reason to hide the figures — only to gate them. */
export interface PayrollBlocker {
  readonly kind: 'OPEN_ENTRY' | 'ESTIMATED_ENTRY' | 'NO_WAGE_RATE'
  readonly userId: string
  readonly userName: string
  /** Present for the two entry kinds, so a screen can link straight to the fix. */
  readonly timeEntryId?: string
  readonly at?: string
  readonly weekStartDate?: string
}

/**
 * One workweek of one person's pay.
 *
 * The level at which overtime is decided — the FLSA threshold is per WORKWEEK, never per pay
 * period — and the level at which the rate is constant.
 */
export interface PayWeekRow {
  readonly weekStartDate: string
  readonly minutesWorked: number
  readonly regularMinutes: number
  readonly overtimeMinutes: number
  /** Snapshotted. Resolution is never re-run against a table that has since grown rows. */
  readonly ratePerHourCents: number
  readonly regularCents: number
  readonly overtimeCents: number
  readonly grossCents: number
}

export interface PayrollLine {
  readonly userId: string
  readonly userName: string
  readonly totalMinutes: number
  readonly regularMinutes: number
  readonly overtimeMinutes: number
  readonly regularCents: number
  readonly overtimeCents: number
  readonly grossCents: number
  readonly weeks: readonly PayWeekRow[]
}

/** A fortnight computed but not written. No row exists behind this. */
export interface PayrollPreview {
  readonly periodStartDate: string
  /** The Saturday the fortnight closes on — the last DAY, not the next period's start. */
  readonly periodEndDate: string
  readonly timezone: string
  readonly payable: boolean
  readonly blockers: readonly PayrollBlocker[]
  /** Informational only, never blocking — e.g. an entry that ran past the end of its week. */
  readonly notes: readonly string[]
  readonly lines: readonly PayrollLine[]
  readonly totalMinutes: number
  readonly overtimeMinutes: number
  readonly regularCents: number
  readonly overtimeCents: number
  readonly grossCents: number
  readonly committedRunId: string | null
}

export interface PeriodSummary {
  readonly periodStartDate: string
  readonly periodEndDate: string
  readonly inProgress: boolean
  readonly runId: string | null
  readonly grossCents: number | null
}

export interface PayRunRow {
  readonly id: string
  readonly periodStartDate: string
  readonly periodEndDate: string
  readonly status: PayRunStatus | string
  readonly timezone: string
  readonly totalMinutes: number
  readonly overtimeMinutes: number
  readonly regularCents: number
  readonly overtimeCents: number
  readonly grossCents: number
  readonly committedByName: string
  readonly committedAt: string
  readonly reversedByName: string | null
  readonly reversedAt: string | null
  readonly reversalNote: string | null
  readonly note: string | null
  readonly lineCount: number
}

export interface PayoutRow {
  readonly id: string
  readonly method: PayoutMethod | string
  readonly amountCents: number
  readonly reference: string | null
  readonly note: string | null
  readonly paidAt: string
  readonly paidByName: string
  readonly reversedAt: string | null
  readonly reversalNote: string | null
}

export interface PayRunLineRow extends PayrollLine {
  readonly id: string
  /** Sum of payouts that have not been reversed. */
  readonly paidCents: number
  readonly outstandingCents: number
  readonly payouts: readonly PayoutRow[]
}

export interface PayRunDetail extends PayRunRow {
  readonly lines: readonly PayRunLineRow[]
}

/** One person's pay across every run — what the staff page's Pay tab renders. */
export interface PersonPayLine {
  readonly payLineId: string
  readonly payRunId: string
  readonly periodStartDate: string
  readonly periodEndDate: string
  readonly runStatus: PayRunStatus | string
  readonly totalMinutes: number
  readonly overtimeMinutes: number
  readonly grossCents: number
  readonly paidCents: number
  readonly outstandingCents: number
  /** The distinct methods money actually went out by, for a one-glance badge. */
  readonly methods: readonly string[]
}

export interface PersonPaySummary {
  readonly lines: readonly PersonPayLine[]
  /** Across COMMITTED runs only — a reversed run is not money anybody earned. */
  readonly grossCents: number
  readonly paidCents: number
  readonly outstandingCents: number
}
