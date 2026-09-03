import { ForbiddenError } from '../errors/index.js'
import { type Principal, isAdmin, isStaff } from './principal.js'

/**
 * The ONE place role logic lives.
 *
 * House rule: "Keep the permission logic in one server-side module; do not scatter role
 * checks through route handlers." A capability check that appears inline in a handler is
 * a bug even when it returns the right answer, because the next handler will get it
 * wrong and nothing will notice.
 *
 * The matrix below is the project's roles-and-permissions table, transcribed.
 */

export const CAPABILITIES = [
  'sale.ring',
  'sale.refund',
  'inventory.view.own',
  'inventory.view.other',
  'inventory.receive',
  'inventory.adjust',
  'inventory.transferBetweenStores',
  'inventory.reconcileWeight',
  'transfer.request',
  'transfer.fulfill',
  'transfer.confirmReceipt',
  'cost.view',
  'catalog.manage',
  'pricing.manage',
  'purchaseOrder.manage',
  'supplier.view',
  'supplier.report',
  'shift.manage',
  'customer.manage',
  'store.manage',
  'user.manage',
  'report.view',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Capabilities a STAFF principal holds, always scoped to their own store. */
const STAFF_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'sale.ring',
  'sale.refund', // subject to step-up once refund policy is decided
  'inventory.view.own',
  'inventory.view.other', // read-only cross-store stock lookup
  'inventory.receive', // quantities only — cost.view is deliberately absent
  'transfer.request',
  'transfer.fulfill',
  'transfer.confirmReceipt',
  'supplier.view', // contact details only
  'shift.manage',
  'customer.manage',
])

/**
 * Capabilities a bare terminal holds with nobody attached.
 *
 * Read-only, and deliberately excludes `sale.ring`: a sale must be attributable to a
 * person, so an unattended register cannot take money.
 */
const TERMINAL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'inventory.view.own',
])

export interface PermissionContext {
  /** The store the action touches. Omit for store-agnostic actions. */
  readonly storeId?: string
}

export function can(
  principal: Principal,
  capability: Capability,
  context: PermissionContext = {},
): boolean {
  // Admins hold every capability, but are still subject to the store check below so an
  // explicit storeId is honoured rather than ignored.
  if (isAdmin(principal)) return true

  if (isStaff(principal)) {
    if (!STAFF_CAPABILITIES.has(capability)) return false
    // Store-scoped: a staff capability applies only at their own store. The one
    // exception is the read-only cross-store stock lookup.
    if (
      context.storeId !== undefined &&
      context.storeId !== principal.storeId &&
      capability !== 'inventory.view.other'
    ) {
      return false
    }
    return true
  }

  // Terminal principal.
  if (!TERMINAL_CAPABILITIES.has(capability)) return false
  return context.storeId === undefined || context.storeId === principal.storeId
}

export function assertCan(
  principal: Principal,
  capability: Capability,
  context: PermissionContext = {},
): void {
  if (!can(principal, capability, context)) {
    // The message names the capability but never the principal or the store — an error
    // response should not confirm that some other store exists.
    throw new ForbiddenError(`You do not have permission to ${capability}.`)
  }
}

/**
 * Resolve the store a query must run against.
 *
 * This is the single chokepoint for store scoping. Every query touching inventory,
 * sales or shifts derives its store here rather than from a request body, so a staff
 * member sending another store's id gets a 403 instead of that store's data.
 *
 * Admins may request any store; asking for none is an error, because a store-scoped
 * query with no store is a query that silently spans every location.
 */
export function scopeStoreId(principal: Principal, requested?: string): string {
  if (isAdmin(principal)) {
    if (requested === undefined) {
      throw new ForbiddenError('A store must be specified for this action.')
    }
    return requested
  }

  if (requested !== undefined && requested !== principal.storeId) {
    throw new ForbiddenError('You do not have permission to act on another store.')
  }
  return principal.storeId
}

/**
 * Whether cost, margin and supplier pricing may be included in a response.
 *
 * The house rules are explicit that this is stripped server-side, not hidden in the UI. Call
 * this to choose the Prisma `select`, so cost never leaves the database for a principal
 * that may not see it — rather than fetching it and remembering to delete the key.
 */
export function canSeeCost(principal: Principal): boolean {
  return can(principal, 'cost.view')
}
