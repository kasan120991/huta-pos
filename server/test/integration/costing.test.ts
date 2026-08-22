import { MovementType, Role, TrackingMode, WEIGHT } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { adjustStock, applyMovement, levelsForVariant } from '../../src/inventory/inventory.service.js'
import {
  giveStock,
  makeAdmin,
  makeCategory,
  makePriceGroup,
  makeProduct,
  makeStore,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Weighted-average cost basis, per store.
 *
 * This is the arithmetic every supplier margin number in Phase 12 rests on, and it is the
 * kind of arithmetic that goes quietly wrong: a 1000x unit error still looks like a number,
 * and a basis that drifts by a cent per sale looks like nothing at all until a year of them
 * accumulates.
 */

let storeA: { id: string }
let storeB: { id: string }
let adminId: string
let admin: AdminPrincipal
let eachVariantId: string
let weightVariantId: string

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')

  const adminUser = await makeAdmin()
  adminId = adminUser.id
  admin = {
    kind: 'admin',
    userId: adminUser.id,
    role: Role.ADMIN,
    storeId: null,
    terminalId: null,
  }

  const edible = await makeCategory('Edible', 'edible')
  const product = await makeProduct({ name: 'Gummies', categoryId: edible.id, priceCents: 4000 })
  eachVariantId = product.variants[0]!.id

  const flower = await makeCategory('Flower', 'flower')
  const group = await makePriceGroup('Flower', 'flower', 1000)
  const strain = await makeWeightProduct({
    name: 'Blue Dream',
    categoryId: flower.id,
    priceGroupId: group.id,
  })
  weightVariantId = strain.variants[0]!.id
})

async function basisOf(storeId: string, variantId: string): Promise<number | null> {
  const level = await prisma.stockLevel.findUnique({
    where: { storeId_variantId: { storeId, variantId } },
    select: { costBasisCents: true },
  })
  return level?.costBasisCents ?? null
}

describe('receiving builds a cost basis', () => {
  it('sets the basis from the first costed receive — EACH', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 12,
      unitCostCents: 250,
      userId: adminId,
    })

    expect(await basisOf(storeA.id, eachVariantId)).toBe(3000)
  })

  it('converts cents-per-gram against a milligram quantity — WEIGHT', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: weightVariantId,
      type: MovementType.RECEIVE,
      quantityBase: WEIGHT.OUNCE,
      unitCostCents: 400,
      userId: adminId,
    })

    // 28g at $4/g is $112.00, not $112,000. The 1000x error is the whole reason the
    // conversion lives in one place.
    expect(await basisOf(storeA.id, weightVariantId)).toBe(11_200)
  })

  it('blends two receives at different costs', async () => {
    for (const unitCostCents of [400, 600]) {
      await applyMovement({
        storeId: storeA.id,
        variantId: weightVariantId,
        type: MovementType.RECEIVE,
        quantityBase: WEIGHT.OUNCE,
        unitCostCents,
        userId: adminId,
      })
    }

    // 28g at $4 plus 28g at $6 is 56g valued at $5/g — the point of the whole exercise.
    expect(await basisOf(storeA.id, weightVariantId)).toBe(11_200 + 16_800)

    const levels = await levelsForVariant(admin, weightVariantId)
    const at = levels.find((l) => l.storeId === storeA.id)
    expect(at?.avgUnitCostCents).toBe(500)
  })

  it('leaves the basis alone when stock arrives with no cost', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 12,
      unitCostCents: 250,
      userId: adminId,
    })

    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 100,
      userId: adminId,
    })

    // Not diluted to 3000/112. Valuing unknown stock at zero would drag the average toward
    // free and quietly inflate every margin that variant reports.
    expect(await basisOf(storeA.id, eachVariantId)).toBe(3000)
  })

  it('records the basis on the ledger row, not just the stock level', async () => {
    const result = await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 12,
      unitCostCents: 250,
      userId: adminId,
    })

    expect(result.costBasisAfterCents).toBe(3000)

    const movement = await prisma.inventoryMovement.findUnique({
      where: { id: result.movementId },
      select: { unitCostCents: true, costBasisAfterCents: true },
    })
    // The cost counterpart of balanceAfterBase: without it, "why did the average move"
    // needs a full replay of the ledger.
    expect(movement).toMatchObject({ unitCostCents: 250, costBasisAfterCents: 3000 })
  })
})

describe('per-store isolation', () => {
  it('keeps each store on its own average', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: weightVariantId,
      type: MovementType.RECEIVE,
      quantityBase: WEIGHT.OUNCE,
      unitCostCents: 400,
      userId: adminId,
    })
    await applyMovement({
      storeId: storeB.id,
      variantId: weightVariantId,
      type: MovementType.RECEIVE,
      quantityBase: WEIGHT.OUNCE,
      unitCostCents: 600,
      userId: adminId,
    })

    const levels = await levelsForVariant(admin, weightVariantId)
    const a = levels.find((l) => l.storeId === storeA.id)
    const b = levels.find((l) => l.storeId === storeB.id)

    // The entire reason costing is scoped per store: neither drifted toward the other.
    expect(a?.avgUnitCostCents).toBe(400)
    expect(b?.avgUnitCostCents).toBe(600)
  })
})

describe('stock leaving reduces the basis', () => {
  it('takes a proportional share', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: weightVariantId,
      type: MovementType.RECEIVE,
      quantityBase: WEIGHT.OUNCE,
      unitCostCents: 400,
      userId: adminId,
    })

    await applyMovement({
      storeId: storeA.id,
      variantId: weightVariantId,
      type: MovementType.SALE,
      quantityBase: -WEIGHT.HALF_OUNCE,
      userId: adminId,
    })

    // Half the weight gone takes half the value; the rate the remainder carries is unchanged.
    expect(await basisOf(storeA.id, weightVariantId)).toBe(5600)

    const levels = await levelsForVariant(admin, weightVariantId)
    expect(levels.find((l) => l.storeId === storeA.id)?.avgUnitCostCents).toBe(400)
  })

  it('resets the basis to zero when the last unit leaves', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 7,
      unitCostCents: 333,
      userId: adminId,
    })

    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.SALE,
      quantityBase: -7,
      userId: adminId,
    })

    // No stranded residual. A leftover cent against zero units reads as an infinite unit
    // cost the next time one is received.
    expect(await basisOf(storeA.id, eachVariantId)).toBe(0)
  })

  it('survives being sold down one unit at a time without drifting', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 30,
      unitCostCents: 337,
      userId: adminId,
    })

    for (let i = 0; i < 30; i += 1) {
      await applyMovement({
        storeId: storeA.id,
        variantId: eachVariantId,
        type: MovementType.SALE,
        quantityBase: -1,
        userId: adminId,
      })
    }

    expect(await basisOf(storeA.id, eachVariantId)).toBe(0)
  })

  it('reduces the basis on a shrinkage adjustment', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 10,
      unitCostCents: 500,
      userId: adminId,
    })

    // Adjustments existed before costing did. If they did not maintain the basis, the
    // first stocktake after this phase would silently corrupt every margin figure.
    await adjustStock({
      storeId: storeA.id,
      variantId: eachVariantId,
      countedBase: 6,
      reasonCode: 'damaged',
      userId: adminId,
    })

    expect(await basisOf(storeA.id, eachVariantId)).toBe(3000)
  })

  it('raises the basis when an adjustment finds MORE than expected', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 10,
      unitCostCents: 500,
      userId: adminId,
    })

    await adjustStock({
      storeId: storeA.id,
      variantId: eachVariantId,
      countedBase: 12,
      reasonCode: 'miscount',
      userId: adminId,
    })

    // A found-stock adjustment carries no cost, so the basis holds while the quantity
    // rises — the average falls, which is the honest reading of "we do not know what these
    // two cost."
    expect(await basisOf(storeA.id, eachVariantId)).toBe(5000)
  })
})

describe('uncosted stock', () => {
  it('reports a null average rather than zero', async () => {
    await giveStock(storeA.id, eachVariantId, 25)

    const levels = await levelsForVariant(admin, eachVariantId)
    const at = levels.find((l) => l.storeId === storeA.id)

    // Null and 0 are different claims: "we do not know" versus "it was free". Only one of
    // them is ever true, and the wrong one shows up as a 100% margin.
    expect(at?.avgUnitCostCents).toBeNull()
    expect(at?.quantityBase).toBe(25)
  })

  it('starts costing from the first costed receive without valuing the old pile', async () => {
    await giveStock(storeA.id, eachVariantId, 25)

    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 10,
      unitCostCents: 500,
      userId: adminId,
    })

    // The 25 uncosted units stay uncosted; only the 10 we paid for are valued. The average
    // that falls out is therefore below the true one, which is the conservative direction.
    expect(await basisOf(storeA.id, eachVariantId)).toBe(5000)
  })
})

describe('cost visibility on stock reads', () => {
  it('omits cost entirely for a principal without cost.view', async () => {
    await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.RECEIVE,
      quantityBase: 12,
      unitCostCents: 250,
      userId: adminId,
    })

    const staff = {
      kind: 'staff' as const,
      userId: 'u-staff',
      role: Role.STAFF,
      storeId: storeA.id,
      terminalId: 't-1',
    }

    const staffLevels = await levelsForVariant(staff, eachVariantId)
    for (const level of staffLevels) {
      expect(level).not.toHaveProperty('avgUnitCostCents')
      expect(level).not.toHaveProperty('costBasisCents')
    }

    // And the same call as admin DOES carry it, so the assertion above is not vacuous.
    const adminLevels = await levelsForVariant(admin, eachVariantId)
    expect(adminLevels.find((l) => l.storeId === storeA.id)?.avgUnitCostCents).toBe(250)
  })
})
