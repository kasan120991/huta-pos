import type { Capability } from './permissions.js'
import type { Principal } from './principal.js'
import { assertCan } from './permissions.js'
import { prisma } from '../db/client.js'
import { NotFoundError } from '../errors/index.js'

export interface ScopeStore {
  readonly id: string
  readonly name: string
  readonly timezone: string
}

/**
 * Which stores a MONEY read may see.
 *
 * Extracted from `sales/history.service.ts` on 2026-08-22 when the shift list needed the
 * same rule. Two independently derived scope resolvers drift, and the one that drifts open
 * is this one — the same argument that moved the CORS allowlist into `config/origins.ts`.
 *
 * Same shape as the catalog's `resolveStoreIds` but gated on a DIFFERENT capability, and
 * that difference is the point: cross-store STOCK is a read the permission matrix grants everyone,
 * cross-store MONEY is not. `report.view` is absent from STAFF_CAPABILITIES, so it is
 * admin-only by construction.
 *
 * `scopeStoreId` is wrong here for the same reason it is wrong in the catalog — it makes a
 * store mandatory for an admin, so it cannot express "every store", which is the default
 * view of a back-office history.
 *
 * @param ownStore the capability that lets a store-scoped person see their OWN store.
 *   Sales history passes `sale.ring`; the drawer list passes `shift.manage`. Cross-store is
 *   always `report.view` and is deliberately NOT a parameter — one door, not two.
 */
export async function resolveMoneyStores(
  principal: Principal,
  requestedStoreId: string | undefined,
  ownStore: Capability,
): Promise<ScopeStore[]> {
  const stores = await prisma.store.findMany({
    where: { active: true },
    select: { id: true, name: true, timezone: true },
    orderBy: { name: 'asc' },
  })

  if (requestedStoreId === undefined) {
    // A store-scoped principal is PINNED to their own store rather than refused — a cashier
    // opening the register's history should see their store, not a 403.
    if (principal.storeId !== null) {
      const own = stores.find((s) => s.id === principal.storeId)
      if (!own) throw new NotFoundError('That store does not exist.')
      assertCan(principal, ownStore, { storeId: own.id })
      return [own]
    }
    assertCan(principal, 'report.view')
    return stores
  }

  const match = stores.find((s) => s.id === requestedStoreId)
  if (!match) throw new NotFoundError('That store does not exist.')
  if (principal.storeId === requestedStoreId) {
    assertCan(principal, ownStore, { storeId: match.id })
  }
  else {
    assertCan(principal, 'report.view')
  }
  return [match]
}
