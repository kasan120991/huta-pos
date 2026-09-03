import { z } from 'zod'

import type { TimeEntryStatus } from '../enums.js'
import { zCuid, zPin } from './primitives.js'

/**
 * Auth request schemas.
 *
 * Both sides import these: the server validates with them, the login form validates
 * against the same rules before it ever hits the network. The house rules — if both sides need
 * a type, it goes in `shared/`.
 *
 * For request TYPES reach for `z.input<>`, not `z.infer<>`: transforms make the two
 * different, and the wire shape is the input.
 */

export const loginRequestSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})
export type LoginRequest = z.input<typeof loginRequestSchema>

export const staffAttachRequestSchema = z.object({
  userId: zCuid,
  pin: zPin,
})
export type StaffAttachRequest = z.input<typeof staffAttachRequestSchema>

export const pairTerminalRequestSchema = z.object({
  code: z.string().min(4).max(32),
})
export type PairTerminalRequest = z.input<typeof pairTerminalRequestSchema>

/**
 * A person who may attach at a register.
 *
 * First name and last initial ONLY — that is all the roster endpoint returns, and the
 * restraint is deliberate: this list is readable by an unattended terminal, so it must
 * not enumerate staff details to whoever walks up to it.
 */
export interface RosterEntry {
  readonly userId: string
  readonly firstName: string
  readonly lastInitial: string
}

/** What a successful pairing returns. Echoed back so the setter-up can confirm the match. */
export interface PairedTerminal {
  readonly deviceToken: string
  readonly terminal: { readonly id: string; readonly name: string }
  readonly store: { readonly id: string; readonly name: string }
}

export interface AttachedUser {
  readonly id: string
  readonly firstName: string
  readonly lastName: string
  readonly role: 'ADMIN' | 'STAFF'
}

/**
 * Who the signed-in person IS, as opposed to what they may do.
 *
 * Deliberately separate from `Principal`. A principal is an authorization object — ids and
 * nothing else — threaded through every service and constructed as a literal in two dozen
 * tests. Names are presentation, and putting them on the principal would both break all of
 * those and blur the line between "who is this" and "what may they do".
 *
 * Unlike `RosterEntry`, this is the caller's OWN record, so a full name is not an
 * enumeration risk. It still carries no password hash, PIN hash or `pinLookup` — nothing
 * derived from a credential ever leaves the server.
 */
export interface UserProfile {
  readonly id: string
  readonly firstName: string
  readonly lastName: string
  readonly email: string | null
  readonly role: 'ADMIN' | 'STAFF'
}

/**
 * WHERE the session is, by name — the third leg of `/auth/me`, beside `principal` (what
 * may this request do) and `user` (whose name goes in the corner). Null for a desk
 * session. Exists so a register can say "Main Store (Baytree) · Register 1" on its
 * sign-in screen every day, not only in the one-time pairing confirmation — a mis-paired
 * machine should be visible at a glance, not discovered at opening.
 */
export interface TerminalInfo {
  readonly id: string
  readonly name: string
  readonly store: { readonly id: string; readonly name: string }
}

/** A terminal as the Registers admin screen sees it. */
export interface TerminalAdminRow {
  readonly id: string
  readonly name: string
  readonly active: boolean
  /** Null until the device first authenticates — how "never paired" reads on screen. */
  readonly lastSeenAt: string | null
  readonly createdAt: string
  readonly store: { readonly id: string, readonly name: string }
}

/** What POST /auth/terminal/pairing-code returns. The code is shown ONCE, never stored. */
export interface PairingCodeIssued {
  readonly code: string
  readonly expiresAt: string
}

// --- the timeclock ------------------------------------------------------------------------

/**
 * One stretch of time a person was at work.
 *
 * `minutes` is null while the entry is OPEN — there is nothing to measure yet, and a zero
 * would read as "worked no time" rather than "still working".
 */
export interface TimeEntryRow {
  readonly id: string
  readonly userId: string
  readonly userName: string
  readonly storeId: string
  readonly storeName: string
  readonly clockedInAt: string
  readonly clockedOutAt: string | null
  readonly status: TimeEntryStatus
  readonly minutes: number | null
  readonly note: string | null
  readonly closedByName: string | null
  /**
   * The committed pay run this entry falls inside, if any — a fortnight that has been paid is
   * closed to timesheet edits, and the screen should say so before somebody types rather than
   * after. Null means editable.
   */
  readonly paidRunId?: string | null
  /** `YYYY-MM-DD` of that run's period, so the dialog can name it. */
  readonly paidPeriodStartDate?: string | null
}

/**
 * ⚠️ `totalMinutes` and `estimatedMinutes` are SEPARATE and must stay that way on screen.
 *
 * An AUTO entry's end time is a guess the server made at the cutoff because nobody clocked
 * out. Adding the two together would put an invented number into someone's pay with nothing
 * saying so. Render them as two figures — "38h 20m, of which 12h estimated".
 */
export interface TimeEntryPage {
  readonly entries: readonly TimeEntryRow[]
  readonly totalMinutes: number
  readonly estimatedMinutes: number
  readonly openCount: number
}

// --- staff administration (the Staff back-office screen) ----------------------------------

/**
 * A staff member as the admin roster sees them.
 *
 * Note what is ABSENT and must stay absent: `pinHash`, `pinLookup` and `passwordHash`. The
 * server builds this from an explicit select for that reason — a bare `findUnique` on User
 * returns all three.
 */
export interface StaffAdminRow {
  readonly id: string
  readonly firstName: string
  readonly lastName: string
  readonly email: string | null
  readonly role: 'ADMIN' | 'STAFF'
  readonly active: boolean
  /** Null for an admin, who has no home store. */
  readonly store: { readonly id: string, readonly name: string } | null
  /** True while a system-generated temporary PIN is outstanding. */
  readonly mustChangePin: boolean
  /** Whether they can sign in at a register at all. */
  readonly hasPin: boolean
  /** Set only while a lockout is in force; the admin can clear it. */
  readonly lockedUntil: string | null
  readonly failedPinAttempts: number
  readonly lastLoginAt: string | null
  readonly createdAt: string
}

export const staffCreateSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200).optional(),
  /** Required: a STAFF row without a store violates `User_role_store_scope_check`. */
  storeId: z.string().min(1),
})
export type StaffCreateRequest = z.input<typeof staffCreateSchema>

/**
 * No `role` field, deliberately. Moving a person between ADMIN and STAFF has to satisfy
 * `User_admin_credentials_check` and `User_staff_credentials_check` in the same statement —
 * a password appearing or disappearing, a store unsetting or setting, a PIN required or
 * forbidden. That is a second feature, not a field on this one.
 */
export const staffPatchSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200).nullable(),
    storeId: z.string().min(1),
    active: z.boolean(),
  })
  .partial()
export type StaffPatch = z.input<typeof staffPatchSchema>

/** What a PIN reset returns. Shown ONCE — only the argon2 hash and lookup are stored. */
export interface TempPinIssued {
  readonly userId: string
  readonly pin: string
}

/**
 * The error envelope every failed request returns. Modelled here so the client renders
 * one known shape rather than guessing per endpoint.
 */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'PIN_CHANGE_REQUIRED',
  'STEP_UP_REQUIRED',
  'INSUFFICIENT_STOCK',
  'AGE_VERIFICATION_REQUIRED',
  'PAYMENT_FAILED',
  'INTERNAL',
] as const

/**
 * Why a PAYMENT_FAILED 409 happened — the register branches on this: `amount_mismatch`
 * means re-quote and stage a fresh intent; `refund_failed` means the record exists but
 * the card money did not move.
 */
export const PAYMENT_FAILURE_REASONS = [
  'not_succeeded',
  'amount_mismatch',
  'intent_already_used',
  'refund_failed',
] as const

export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number]

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly details?: {
      readonly retryAfterSeconds?: number
      readonly action?: string
      /** PAYMENT_FAILED only. */
      readonly reason?: PaymentFailureReason
      readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>
    }
  }
}
