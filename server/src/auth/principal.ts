import type { Role } from '@huta/shared'

/**
 * Who is making a request.
 *
 * Three shapes, because a POS genuinely has three:
 *
 *   - `terminal` — a register authenticated to its store with nobody attached. This is
 *     the state a machine sits in between shifts, and it is a real authenticated
 *     identity: it may read its own store's catalog, but it cannot ring a sale, because
 *     no sale may exist without a person to attribute it to.
 *   - `staff`    — a person attached at a terminal. Hard-scoped to one store.
 *   - `admin`    — a person in the back office, no home store. May optionally be attached
 *     at a terminal, which is how an admin covers the counter.
 *
 * `storeId` is `null` for admins by construction, mirroring the database CHECK
 * constraint. Never read a store from a request body — derive it from here.
 */

export interface AdminPrincipal {
  readonly kind: 'admin'
  readonly userId: string
  readonly role: typeof Role.ADMIN
  readonly storeId: null
  /** Set when an admin is working a register rather than the back office. */
  readonly terminalId: string | null
}

export interface StaffPrincipal {
  readonly kind: 'staff'
  readonly userId: string
  readonly role: typeof Role.STAFF
  readonly storeId: string
  readonly terminalId: string
}

export interface TerminalPrincipal {
  readonly kind: 'terminal'
  readonly userId: null
  readonly role: null
  readonly storeId: string
  readonly terminalId: string
}

export type Principal = AdminPrincipal | StaffPrincipal | TerminalPrincipal

export const isAdmin = (p: Principal): p is AdminPrincipal => p.kind === 'admin'
export const isStaff = (p: Principal): p is StaffPrincipal => p.kind === 'staff'
export const isPerson = (p: Principal): p is AdminPrincipal | StaffPrincipal =>
  p.kind !== 'terminal'

/** The acting user id, or null for a bare terminal. */
export const actingUserId = (p: Principal): string | null => p.userId
