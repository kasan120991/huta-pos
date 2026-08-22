import { MovementType, Role, WEIGHT } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { applyMovement } from '../../src/inventory/inventory.service.js'
import {
  reconcileSheet,
  reconcileWeights,
  weightVarianceForVariant,
} from '../../src/inventory/reconcile.service.js'
import {
  giveStock,
  makeAdmin,
  makeCategory,
  makePriceGroup,
  makeProduct,
  makeStaff,
  makeStore,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Weight reconciliation.
 *
 * Flower loses moisture and keyed gram sales accumulate drift, so this is a routine counting
 * session rather than an exception path. The ledger is append-only, so a session that writes
 * the wrong thing cannot be undone — which is why the "blank means uncounted" rule and the
 * SHRINKAGE sign rule both get their own tests.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let adminId: string
let blueDreamId: string
let gelatoId: string
let eachVariantId: string

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')

  const adminUser = await makeAdmin()
  adminId = adminUser.id
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: null }

  const staffUser = await makeStaff(storeA.id, '4321')
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: 't-1',
  }

  const flower = await makeCategory('Flower', 'flower')
  const group = await makePriceGroup('Flower', 'flower', 1000)
  blueDreamId = (
    await makeWeightProduct({ name: 'Blue Dream', categoryId: flower.id, priceGroupId: group.id })
  ).variants[0]!.id
  gelatoId = (
    await makeWeightProduct({ name: 'Gelato', categoryId: flower.id, priceGroupId: group.id })
  ).variants[0]!.id

  const edible = await makeCategory('Edible', 'edible')
  eachVariantId = (
    await makeProduct({ name: 'Gummies', categoryId: edible.id, priceCents: 4000 })
  ).variants[0]!.id
})

/** Receive an ounce at a known cost so there is a basis to relieve. */
async function stockFlower(variantId: string, quantityBase: number, unitCostCents: number) {
  await applyMovement({
    storeId: storeA.id,
    variantId,
    type: MovementType.RECEIVE,
    quantityBase,
    unitCostCents,
    userId: adminId,
  })
}

async function levelOf(variantId: string, storeId = storeA.id) {
  return prisma.stockLevel.findUnique({
    where: { storeId_variantId: { storeId, variantId } },
    select: { quantityBase: true, costBasisCents: true },
  })
}

describe('the counting sheet', () => {
  it('lists weight-tracked stock the store actually holds', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await giveStock(storeA.id, eachVariantId, 20)

    const sheet = await reconcileSheet(admin, storeA.id)

    // Discrete items are not reconcilable — a miscounted gummy goes through the ordinary
    // stock adjustment, which asks for a reason per item.
    expect(sheet.map((r) => r.productName)).toEqual(['Blue Dream'])
    expect(sheet[0]).toMatchObject({ onRecordBase: WEIGHT.OUNCE, avgUnitCostCents: 500 })
  })

  it('omits a strain the store does not hold', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    expect(await reconcileSheet(admin, storeB.id)).toEqual([])
  })

  it('refuses a staff principal', async () => {
    await expect(reconcileSheet(staff, storeA.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('posting a session', () => {
  it('writes SHRINKAGE for a shortfall and relieves the basis at average cost', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500) // 28g at $5/g = $140.00

    const result = await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [{ variantId: blueDreamId, countedBase: 27_400 }],
    })

    expect(result.lines[0]).toMatchObject({
      deltaBase: -600,
      movementType: MovementType.SHRINKAGE,
      valueCents: -300, // 0.6g at $5/g
    })
    expect(result.totalDeltaBase).toBe(-600)

    const level = await levelOf(blueDreamId)
    expect(level).toMatchObject({ quantityBase: 27_400, costBasisCents: 13_700 })

    const movement = await prisma.inventoryMovement.findFirst({
      where: { variantId: blueDreamId, type: MovementType.SHRINKAGE },
      select: { quantityBase: true, reasonCode: true },
    })
    expect(movement).toMatchObject({ quantityBase: -600, reasonCode: 'moisture' })
  })

  it('writes ADJUSTMENT when MORE is found, because shrinkage cannot go up', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)

    const result = await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [{ variantId: blueDreamId, countedBase: 28_500 }],
    })

    // SHRINKAGE is in NEGATIVE_MOVEMENT_TYPES and the DB direction CHECK enforces it, so a
    // positive delta must be an ADJUSTMENT or the database would reject the row outright.
    expect(result.lines[0]).toMatchObject({
      deltaBase: 500,
      movementType: MovementType.ADJUSTMENT,
    })

    const level = await levelOf(blueDreamId)
    // Found weight carries no cost, so the basis holds and the average falls — the honest
    // reading of "we do not know what this half gram cost."
    expect(level).toMatchObject({ quantityBase: 28_500, costBasisCents: 14_000 })
  })

  it('skips a strain that was not counted rather than zeroing it', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await stockFlower(gelatoId, WEIGHT.HALF_OUNCE, 600)

    // Gelato is absent from the payload — the shelf was not counted, which is different from
    // being counted at zero. Zeroing it would write off the whole pool with no undo.
    const result = await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [{ variantId: blueDreamId, countedBase: 27_000 }],
    })

    expect(result.lines).toHaveLength(1)
    expect(await levelOf(gelatoId)).toMatchObject({ quantityBase: WEIGHT.HALF_OUNCE })
  })

  it('ignores a count that matches, so a whole shelf can be submitted at once', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await stockFlower(gelatoId, WEIGHT.HALF_OUNCE, 600)

    const result = await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [
        { variantId: blueDreamId, countedBase: 27_000 },
        { variantId: gelatoId, countedBase: WEIGHT.HALF_OUNCE }, // unchanged
      ],
    })

    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]?.variantId).toBe(blueDreamId)
  })

  it('posts several strains in one transaction', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await stockFlower(gelatoId, WEIGHT.HALF_OUNCE, 600)

    const result = await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [
        { variantId: blueDreamId, countedBase: 27_400 },
        { variantId: gelatoId, countedBase: 13_600 },
      ],
    })

    expect(result.lines).toHaveLength(2)
    expect(result.totalDeltaBase).toBe(-1000)
    expect(result.totalValueCents).toBe(-300 + -240)
  })

  it('rolls the WHOLE session back when one line fails', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await stockFlower(gelatoId, WEIGHT.HALF_OUNCE, 600)

    await expect(
      reconcileWeights(admin, {
        storeId: storeA.id,
        userId: adminId,
        counts: [
          { variantId: blueDreamId, countedBase: 27_400 },
          // No stock row at this store for a variant that was never received here.
          { variantId: 'cjld2cyuq0000t3rmniod1foy', countedBase: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // A half-posted count is worse than none: the shelf would disagree with the system in a
    // way nobody could reconstruct.
    expect(await levelOf(blueDreamId)).toMatchObject({ quantityBase: WEIGHT.OUNCE })
    expect(
      await prisma.inventoryMovement.count({ where: { type: MovementType.SHRINKAGE } }),
    ).toBe(0)
  })

  it('writes one audit row for the session, inside the transaction', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [{ variantId: blueDreamId, countedBase: 27_400 }],
      note: 'Quarterly count',
    })

    const log = await prisma.auditLog.findFirst({
      where: { action: 'inventory.reconcileWeight' },
    })
    expect(log).not.toBeNull()
    expect(log?.entityId).toBe(storeA.id)
  })
})

describe('refusals', () => {
  it('refuses a staff principal', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await expect(
      reconcileWeights(staff, {
        storeId: storeA.id,
        userId: adminId,
        counts: [{ variantId: blueDreamId, countedBase: 27_000 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses a discrete item', async () => {
    await giveStock(storeA.id, eachVariantId, 20)
    await expect(
      reconcileWeights(admin, {
        storeId: storeA.id,
        userId: adminId,
        counts: [{ variantId: eachVariantId, countedBase: 18 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a negative weight and a duplicated strain', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)

    await expect(
      reconcileWeights(admin, {
        storeId: storeA.id,
        userId: adminId,
        counts: [{ variantId: blueDreamId, countedBase: -1 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await expect(
      reconcileWeights(admin, {
        storeId: storeA.id,
        userId: adminId,
        counts: [
          { variantId: blueDreamId, countedBase: 27_000 },
          { variantId: blueDreamId, countedBase: 26_000 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a session where nothing changed', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    await expect(
      reconcileWeights(admin, {
        storeId: storeA.id,
        userId: adminId,
        counts: [{ variantId: blueDreamId, countedBase: WEIGHT.OUNCE }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('cumulative weight variance', () => {
  it('reports loss as a rate against weight received', async () => {
    await stockFlower(blueDreamId, WEIGHT.POUND, 400) // 448g in
    await reconcileWeights(admin, {
      storeId: storeA.id,
      userId: adminId,
      counts: [{ variantId: blueDreamId, countedBase: WEIGHT.POUND - 4480 }], // 4.48g lost
    })

    const variance = await weightVarianceForVariant(admin, blueDreamId)
    const at = variance.find((v) => v.storeId === storeA.id)

    // A raw gram figure is not a signal — an ounce lost on a pound is very different from an
    // ounce lost on a gram. 4.48g of 448g is exactly 1%.
    expect(at).toMatchObject({ receivedBase: WEIGHT.POUND, lostBase: 4480, lossRateBps: 100 })
  })

  it('reports a store with no movement as null rather than zero', async () => {
    await stockFlower(blueDreamId, WEIGHT.OUNCE, 500)
    const variance = await weightVarianceForVariant(admin, blueDreamId)

    // Nothing received at Store B, so there is no denominator — "no data" is not "0% loss".
    expect(variance.find((v) => v.storeId === storeB.id)).toMatchObject({ lossRateBps: null })
  })

  it('refuses a staff principal', async () => {
    await expect(weightVarianceForVariant(staff, blueDreamId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
