import { Role } from '@huta/shared'
import { describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal, TerminalPrincipal } from '../src/auth/principal.js'
import {
  CAPABILITIES,
  type Capability,
  can,
  canSeeCost,
  scopeStoreId,
} from '../src/auth/permissions.js'
import { ForbiddenError } from '../src/errors/index.js'

/**
 * The permission matrix is transcribed from the roles-and-permissions matrix.
 * These tests are transcribed from the SAME table, independently — so if the code and the
 * document drift apart, this fails rather than silently granting something.
 */

const STORE_A = 'store-a'
const STORE_B = 'store-b'

const admin: AdminPrincipal = {
  kind: 'admin',
  userId: 'u-admin',
  role: Role.ADMIN,
  storeId: null,
  terminalId: null,
}

const staff: StaffPrincipal = {
  kind: 'staff',
  userId: 'u-staff',
  role: Role.STAFF,
  storeId: STORE_A,
  terminalId: 't-1',
}

const terminal: TerminalPrincipal = {
  kind: 'terminal',
  userId: null,
  role: null,
  storeId: STORE_A,
  terminalId: 't-1',
}

describe('capability matrix — staff', () => {
  // Straight from the permission matrix. ✅ in the doc means true here.
  it.each<[Capability, boolean]>([
    ['sale.ring', true],
    ['inventory.view.own', true],
    ['inventory.view.other', true],
    ['inventory.receive', true],
    ['transfer.request', true],
    ['transfer.fulfill', true],
    ['transfer.confirmReceipt', true],
    ['shift.manage', true],
    ['customer.manage', true],
    ['supplier.view', true],
    // ❌ in the doc.
    ['inventory.adjust', false],
    ['inventory.transferBetweenStores', false],
    ['inventory.reconcileWeight', false],
    ['cost.view', false],
    ['catalog.manage', false],
    ['pricing.manage', false],
    ['purchaseOrder.manage', false],
    ['supplier.report', false],
    ['store.manage', false],
    ['user.manage', false],
    ['report.view', false],
  ])('staff %s === %s', (capability, expected) => {
    expect(can(staff, capability)).toBe(expected)
  })
})

describe('capability matrix — admin', () => {
  it('holds every capability', () => {
    for (const capability of CAPABILITIES) {
      expect(can(admin, capability)).toBe(true)
    }
  })
})

describe('capability matrix — bare terminal', () => {
  it('may read its own store but must not ring a sale', () => {
    expect(can(terminal, 'inventory.view.own')).toBe(true)
    // A sale must be attributable to a person, so an unattended register cannot take
    // money. This is the single most important cell in the terminal row.
    expect(can(terminal, 'sale.ring')).toBe(false)
  })

  it('holds nothing else', () => {
    const allowed = CAPABILITIES.filter((c) => can(terminal, c))
    expect(allowed).toEqual(['inventory.view.own'])
  })
})

describe('store scoping', () => {
  it('pins staff to their own store when none is requested', () => {
    expect(scopeStoreId(staff)).toBe(STORE_A)
  })

  it('allows staff to name their own store explicitly', () => {
    expect(scopeStoreId(staff, STORE_A)).toBe(STORE_A)
  })

  // The requirement the house rules calls out by name: a staff token must not reach another
  // store's data.
  it('refuses staff asking for another store', () => {
    expect(() => scopeStoreId(staff, STORE_B)).toThrow(ForbiddenError)
  })

  it('lets an admin name any store', () => {
    expect(scopeStoreId(admin, STORE_B)).toBe(STORE_B)
  })

  it('refuses an admin who names no store', () => {
    // Silently spanning every location is how a store-scoped report accidentally becomes
    // a company-wide one.
    expect(() => scopeStoreId(admin)).toThrow(ForbiddenError)
  })

  it('refuses a terminal reaching another store', () => {
    expect(() => scopeStoreId(terminal, STORE_B)).toThrow(ForbiddenError)
  })
})

describe('cost visibility', () => {
  it('is admin-only', () => {
    expect(canSeeCost(admin)).toBe(true)
    expect(canSeeCost(staff)).toBe(false)
    expect(canSeeCost(terminal)).toBe(false)
  })

  it('stays false for staff at their own store', () => {
    // Cost is not store-scoped — staff never see it anywhere, including their own store.
    expect(can(staff, 'cost.view', { storeId: STORE_A })).toBe(false)
  })
})

describe('cross-store inventory lookup', () => {
  it('is the one staff capability that crosses stores', () => {
    // House rule: staff get a read-only view of other stores' stock so they know what to
    // request. Everything else is pinned to their own store.
    expect(can(staff, 'inventory.view.other', { storeId: STORE_B })).toBe(true)
    expect(can(staff, 'inventory.view.own', { storeId: STORE_B })).toBe(false)
    expect(can(staff, 'sale.ring', { storeId: STORE_B })).toBe(false)
  })
})
