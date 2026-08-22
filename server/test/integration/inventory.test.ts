import { MovementType, Role } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { adjustStock, applyMovement, levelsForVariant } from '../../src/inventory/inventory.service.js'
import {
  giveStock,
  makeAdmin,
  makeCategory,
  makeProduct,
  makeStore,
  resetDatabase,
} from '../setup/factories.js'

/**
 * The stock chokepoint, against a real database.
 *
 * These matter beyond this phase: receiving, transfers and sales all route through
 * `applyMovement`, so a bug here becomes a bug in three later features.
 */

let storeA: { id: string }
let storeB: { id: string }
let variantId: string
let adminId: string
let adminPrincipal: AdminPrincipal

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')
  const admin = await makeAdmin()
  adminId = admin.id
  adminPrincipal = {
    kind: 'admin',
    userId: admin.id,
    role: Role.ADMIN,
    storeId: null,
    terminalId: null,
  }
  const category = await makeCategory('Edible', 'edible')
  const product = await makeProduct({ name: 'Gummies', categoryId: category.id })
  variantId = product.variants[0]!.id
})

describe('applyMovement', () => {
  it('writes the stock level and the ledger row together', async () => {
    await giveStock(storeA.id, variantId, 10)

    const result = await applyMovement({
      storeId: storeA.id,
      variantId,
      type: MovementType.RECEIVE,
      quantityBase: 5,
      userId: adminId,
    })

    expect(result.balanceAfterBase).toBe(15)

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId } },
    })
    const movement = await prisma.inventoryMovement.findUnique({
      where: { id: result.movementId },
    })

    // The whole point of the ledger: the materialised quantity and the movement's
    // recorded balance must agree, or an audit cannot trust either.
    expect(level?.quantityBase).toBe(15)
    expect(movement?.balanceAfterBase).toBe(15)
    expect(movement?.quantityBase).toBe(5)
  })

  it('creates the stock row when a store has none', async () => {
    // Ashley's real shape: no StockLevel rows at all. A first movement must not fail.
    const result = await applyMovement({
      storeId: storeB.id,
      variantId,
      type: MovementType.RECEIVE,
      quantityBase: 7,
    })
    expect(result.previousBase).toBe(0)
    expect(result.balanceAfterBase).toBe(7)
  })

  it('refuses a movement that would drive stock negative', async () => {
    await giveStock(storeA.id, variantId, 3)

    await expect(
      applyMovement({
        storeId: storeA.id,
        variantId,
        type: MovementType.SALE,
        quantityBase: -5,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId } },
    })
    expect(level?.quantityBase).toBe(3)
  })

  it('refuses a zero movement', async () => {
    await expect(
      applyMovement({
        storeId: storeA.id,
        variantId,
        type: MovementType.ADJUSTMENT,
        quantityBase: 0,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('does not lose an update under concurrency', async () => {
    await giveStock(storeA.id, variantId, 100)

    // Ten simultaneous sales of one unit. Without the row lock these interleave and the
    // final quantity lands somewhere above 90 — the classic lost update.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        applyMovement({
          storeId: storeA.id,
          variantId,
          type: MovementType.SALE,
          quantityBase: -1,
        }),
      ),
    )

    const level = await prisma.stockLevel.findUnique({
      where: { storeId_variantId: { storeId: storeA.id, variantId } },
    })
    expect(level?.quantityBase).toBe(90)

    const movements = await prisma.inventoryMovement.count({
      where: { variantId, type: MovementType.SALE },
    })
    expect(movements).toBe(10)
  })
})

describe('adjustStock', () => {
  it('derives the delta from a counted total', async () => {
    await giveStock(storeA.id, variantId, 40)

    const result = await adjustStock({
      storeId: storeA.id,
      variantId,
      countedBase: 38,
      reasonCode: 'miscount',
      note: 'Monthly count',
      userId: adminId,
    })

    expect(result.deltaBase).toBe(-2)
    expect(result.balanceAfterBase).toBe(38)

    const movement = await prisma.inventoryMovement.findUnique({
      where: { id: result.movementId },
    })
    expect(movement?.type).toBe(MovementType.ADJUSTMENT)
    expect(movement?.note).toBe('Monthly count')
  })

  it('records who adjusted and what changed', async () => {
    await giveStock(storeA.id, variantId, 40)
    await adjustStock({
      storeId: storeA.id,
      variantId,
      countedBase: 38,
      reasonCode: 'damaged',
      note: 'Damaged in transit',
      userId: adminId,
    })

    const audit = await prisma.auditLog.findFirst({ where: { action: 'inventory.adjust' } })
    expect(audit?.userId).toBe(adminId)
    expect(audit?.before).toMatchObject({ quantityBase: 40 })
    expect(audit?.after).toMatchObject({ quantityBase: 38 })
  })

  it('refuses an empty reason', async () => {
    await giveStock(storeA.id, variantId, 40)
    await expect(
      adjustStock({
        storeId: storeA.id,
        variantId,
        countedBase: 38,
        reasonCode: '   ',
        userId: adminId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('stores the reason as a queryable code, not buried in free text', async () => {
    await giveStock(storeA.id, variantId, 40)
    await adjustStock({
      storeId: storeA.id,
      variantId,
      countedBase: 30,
      reasonCode: 'damaged',
      note: 'Crushed in the stockroom',
      userId: adminId,
    })

    // The whole reason chips exist: this has to be answerable as a query.
    const damaged = await prisma.inventoryMovement.aggregate({
      where: { reasonCode: 'damaged' },
      _sum: { quantityBase: true },
    })
    expect(damaged._sum.quantityBase).toBe(-10)
  })

  it('refuses a count that changes nothing', async () => {
    await giveStock(storeA.id, variantId, 40)
    await expect(
      adjustStock({
        storeId: storeA.id,
        variantId,
        countedBase: 40,
        reasonCode: 'miscount',
        userId: adminId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('levelsForVariant', () => {
  it('reports a store with no stock row as zero, not as missing', async () => {
    await giveStock(storeA.id, variantId, 12)

    const levels = await levelsForVariant(adminPrincipal, variantId)

    // Both stores present. An inner join would silently drop Store B, which is exactly
    // how Ashley would disappear from every breakdown in the UI.
    expect(levels).toHaveLength(2)
    expect(levels.find((l) => l.storeId === storeB.id)).toMatchObject({ quantityBase: 0 })
  })
})
