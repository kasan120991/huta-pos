import { MovementType, Role, TrackingMode, TransferStatus } from '@huta/shared'
import type { Server } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import {
  ConflictError,
  ForbiddenError,
  InsufficientStockError,
  NotFoundError,
  ValidationError,
} from '../../src/errors/index.js'
import { applyMovement } from '../../src/inventory/inventory.service.js'
import { clearIo, setIo } from '../../src/realtime/emitter.js'
import {
  acceptTransfer,
  cancelTransfer,
  createTransfer,
  declineTransfer,
  directMove,
  getTransfer,
  listTransfers,
  receiveTransfer,
  shipTransfer,
  transferAvailability,
} from '../../src/transfers/transfer.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
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
 * Transfers — the three-legged flow (request → ship → receive) and the two invariants
 * everything hangs on:
 *
 *   1. In-transit stock belongs to NEITHER store. Between ship and receive, the source
 *      has been relieved and the destination has gained nothing.
 *   2. Cost is CONSERVED to the cent. The destination's basis gains exactly what the
 *      source's basis relieved — carried as a total (`costTotalCents`), never re-derived
 *      from a per-unit figure, because totals like 1001¢ over 3 units have none.
 */

let storeA: { id: string }
let storeB: { id: string }
let storeC: { id: string }
let admin: AdminPrincipal
let staffA: StaffPrincipal
let staffB: StaffPrincipal
let staffC: StaffPrincipal
let eachVariantId: string
let weightVariantId: string

function staffPrincipal(userId: string, storeId: string): StaffPrincipal {
  return { kind: 'staff', userId, role: Role.STAFF, storeId, terminalId: 't-1' }
}

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')
  storeC = await makeStore('Store C', 'store-c')

  const adminUser = await makeAdmin()
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: null }

  staffA = staffPrincipal((await makeStaff(storeA.id, '1111', 'a@test.local')).id, storeA.id)
  staffB = staffPrincipal((await makeStaff(storeB.id, '2222', 'b@test.local')).id, storeB.id)
  staffC = staffPrincipal((await makeStaff(storeC.id, '3333', 'c@test.local')).id, storeC.id)

  const edible = await makeCategory('Edible', 'edible')
  eachVariantId = (
    await makeProduct({ name: 'Gummies', categoryId: edible.id, priceCents: 4000 })
  ).variants[0]!.id

  const flowerCat = await makeCategory('Flower', 'flower')
  const group = await makePriceGroup('Flower', 'flower', 1000)
  weightVariantId = (
    await makeWeightProduct({ name: 'Blue Dream', categoryId: flowerCat.id, priceGroupId: group.id })
  ).variants[0]!.id
})

afterEach(() => clearIo())

/** A requests from B. B holds stock unless a test seeds otherwise. */
async function request(
  lines: ReadonlyArray<{ variantId: string; quantityBase: number }> = [
    { variantId: eachVariantId, quantityBase: 5 },
  ],
) {
  return createTransfer(staffA, { sourceStoreId: storeB.id, lines })
}

async function stockAt(storeId: string, variantId: string) {
  const level = await prisma.stockLevel.findUnique({
    where: { storeId_variantId: { storeId, variantId } },
    select: { quantityBase: true, costBasisCents: true },
  })
  return { quantityBase: level?.quantityBase ?? 0, costBasisCents: level?.costBasisCents ?? null }
}

// --- availability at the source ----------------------------------------------------------

/**
 * The figure the fulfilling cashier was missing. Without it, accepting more than the shelf
 * holds succeeds and the oversell only surfaces at SHIP — after the accept has committed.
 */
describe('availability at the source', () => {
  it('reports on hand at the SOURCE store, per line, in request order', async () => {
    await giveStock(storeB.id, eachVariantId, 12)
    await giveStock(storeB.id, weightVariantId, 40_000)
    // The requesting store's own stock must not leak in — it is the wrong shelf entirely.
    await giveStock(storeA.id, eachVariantId, 999)

    const created = await request([
      { variantId: eachVariantId, quantityBase: 5 },
      { variantId: weightVariantId, quantityBase: 14_000 },
    ])

    const rows = await transferAvailability(staffB, created.id)
    expect(rows).toEqual([
      { variantId: eachVariantId, quantityBase: 12 },
      { variantId: weightVariantId, quantityBase: 40_000 },
    ])
  })

  it('reads a variant with no StockLevel row at the source as 0, never as absent', async () => {
    const created = await request([{ variantId: eachVariantId, quantityBase: 5 }])
    const rows = await transferAvailability(staffB, created.id)
    // "None there" is an answer the sheet has to render; a missing line would render nothing.
    expect(rows).toEqual([{ variantId: eachVariantId, quantityBase: 0 }])
  })

  it('is readable by BOTH stores involved — the requester sees what they asked against', async () => {
    await giveStock(storeB.id, eachVariantId, 7)
    const created = await request()
    await expect(transferAvailability(staffA, created.id)).resolves.toEqual([
      { variantId: eachVariantId, quantityBase: 7 },
    ])
  })

  it('404s for a store that is not involved — never 403, which would confirm it exists', async () => {
    const created = await request()
    await expect(transferAvailability(staffC, created.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('carries no cost-shaped key for either role', async () => {
    await giveStock(storeB.id, eachVariantId, 12, 4800)
    const created = await request()

    // Both directions, because "no cost key" proves nothing if the shape carries none for
    // anyone — an admin here must ALSO get none, since an on-hand count is not a valuation.
    expect(findCostKeys(await transferAvailability(staffB, created.id))).toEqual([])
    expect(findCostKeys(await transferAvailability(admin, created.id))).toEqual([])
  })
})

// --- lifecycle ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('creates a PENDING request with untouched approval and receipt columns', async () => {
    const row = await request([
      { variantId: eachVariantId, quantityBase: 5 },
      { variantId: weightVariantId, quantityBase: 3500 },
    ])
    expect(row.status).toBe(TransferStatus.PENDING)
    expect(row.requestingStoreId).toBe(storeA.id)
    expect(row.sourceStoreId).toBe(storeB.id)
    expect(row.lines).toHaveLength(2)
    expect(row.lines.every((l) => l.approvedBase === null && l.receivedBase === null)).toBe(true)
  })

  it('refuses a request whose source is the requesting store itself', async () => {
    await expect(
      createTransfer(staffA, {
        sourceStoreId: storeA.id,
        lines: [{ variantId: eachVariantId, quantityBase: 1 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a request listing the same variant twice', async () => {
    await expect(
      request([
        { variantId: eachVariantId, quantityBase: 1 },
        { variantId: eachVariantId, quantityBase: 2 },
      ]),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accept defaults every untouched line to its requested quantity', async () => {
    const created = await request()
    const row = await acceptTransfer(staffB, created.id, {})
    expect(row.status).toBe(TransferStatus.ACCEPTED)
    expect(row.lines[0]!.approvedBase).toBe(5)
    expect(row.acceptedByName).toBe('Test Staff')
  })

  it('accept honours per-line trims and zeroes', async () => {
    const created = await request([
      { variantId: eachVariantId, quantityBase: 5 },
      { variantId: weightVariantId, quantityBase: 3500 },
    ])
    const [first, second] = created.lines
    const row = await acceptTransfer(staffB, created.id, {
      lines: [
        { lineId: first!.id, approvedBase: 3 },
        { lineId: second!.id, approvedBase: 0 },
      ],
    })
    expect(row.lines.map((l) => l.approvedBase)).toEqual([3, 0])
  })

  it('accept refuses approving more than was requested', async () => {
    const created = await request()
    await expect(
      acceptTransfer(staffB, created.id, {
        lines: [{ lineId: created.lines[0]!.id, approvedBase: 6 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accept refuses an all-zero approval — that is a decline', async () => {
    const created = await request()
    await expect(
      acceptTransfer(staffB, created.id, {
        lines: [{ lineId: created.lines[0]!.id, approvedBase: 0 }],
      }),
    ).rejects.toThrow(/decline/i)
  })

  it('accept refuses a transfer that is not PENDING', async () => {
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await expect(acceptTransfer(staffB, created.id, {})).rejects.toBeInstanceOf(ConflictError)
  })

  it('decline records the reason and only works on PENDING', async () => {
    const created = await request()
    const row = await declineTransfer(staffB, created.id, 'Not enough on the shelf.')
    expect(row.status).toBe(TransferStatus.DECLINED)
    expect(row.reason).toBe('Not enough on the shelf.')
    await expect(declineTransfer(staffB, created.id, 'again')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('cancel works on PENDING and ACCEPTED, not after ship', async () => {
    const pending = await request()
    expect((await cancelTransfer(staffA, pending.id, {})).status).toBe(TransferStatus.CANCELLED)

    await giveStock(storeB.id, eachVariantId, 10)
    const accepted = await request()
    await acceptTransfer(staffB, accepted.id, {})
    expect((await cancelTransfer(staffA, accepted.id, { reason: 'Found some here.' })).reason).toBe(
      'Found some here.',
    )

    const shipped = await request()
    await acceptTransfer(staffB, shipped.id, {})
    await shipTransfer(staffB, shipped.id)
    await expect(cancelTransfer(staffA, shipped.id, {})).rejects.toBeInstanceOf(ConflictError)
  })

  it('ship refuses a transfer that is not ACCEPTED', async () => {
    const created = await request()
    await expect(shipTransfer(staffB, created.id)).rejects.toBeInstanceOf(ConflictError)
  })

  it('receive refuses a transfer that is not IN_TRANSIT', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await expect(receiveTransfer(staffA, created.id, {})).rejects.toBeInstanceOf(ConflictError)
  })

  it('two concurrent ships resolve to exactly one set of movements', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})

    const results = await Promise.allSettled([
      shipTransfer(staffB, created.id),
      shipTransfer(staffB, created.id),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)

    const movements = await prisma.inventoryMovement.count({
      where: { transferRequestId: created.id, type: MovementType.TRANSFER_OUT },
    })
    expect(movements).toBe(1)
    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(5)
  })
})

// --- three-legged accounting ---------------------------------------------------------------

describe('stock accounting', () => {
  it('EACH: in-transit stock belongs to neither store, then lands on receive', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)

    // Between the legs: B relieved, A untouched.
    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(5)
    expect((await stockAt(storeA.id, eachVariantId)).quantityBase).toBe(0)

    const row = await receiveTransfer(staffA, created.id, {})
    expect(row.status).toBe(TransferStatus.RECEIVED)
    expect((await stockAt(storeA.id, eachVariantId)).quantityBase).toBe(5)
    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(5)

    const movements = await prisma.inventoryMovement.findMany({
      where: { transferRequestId: created.id },
      orderBy: { createdAt: 'asc' },
      select: { type: true, quantityBase: true, storeId: true },
    })
    expect(movements).toEqual([
      { type: MovementType.TRANSFER_OUT, quantityBase: -5, storeId: storeB.id },
      { type: MovementType.TRANSFER_IN, quantityBase: 5, storeId: storeA.id },
    ])
  })

  it('WEIGHT: a partial gram (3500mg) transfers with no unit special-casing', async () => {
    await giveStock(storeB.id, weightVariantId, 28_000)
    const created = await request([{ variantId: weightVariantId, quantityBase: 3500 }])
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)
    await receiveTransfer(staffA, created.id, {})

    expect((await stockAt(storeB.id, weightVariantId)).quantityBase).toBe(24_500)
    expect((await stockAt(storeA.id, weightVariantId)).quantityBase).toBe(3500)
  })

  it('ship applies only approved-positive lines; zeroed lines move nothing', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    await giveStock(storeB.id, weightVariantId, 28_000)
    const created = await request([
      { variantId: eachVariantId, quantityBase: 5 },
      { variantId: weightVariantId, quantityBase: 3500 },
    ])
    const weightLine = created.lines.find((l) => l.variantId === weightVariantId)!
    await acceptTransfer(staffB, created.id, {
      lines: [{ lineId: weightLine.id, approvedBase: 0 }],
    })
    await shipTransfer(staffB, created.id)

    expect((await stockAt(storeB.id, weightVariantId)).quantityBase).toBe(28_000)
    expect(
      await prisma.inventoryMovement.count({ where: { transferRequestId: created.id } }),
    ).toBe(1)
  })

  it('an oversell at ship rolls the whole ship back — no half-shipped transfer', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    await giveStock(storeB.id, weightVariantId, 1000) // less than requested
    const created = await request([
      { variantId: eachVariantId, quantityBase: 5 },
      { variantId: weightVariantId, quantityBase: 3500 },
    ])
    await acceptTransfer(staffB, created.id, {})

    await expect(shipTransfer(staffB, created.id)).rejects.toBeInstanceOf(InsufficientStockError)

    const after = await getTransfer(admin, created.id)
    expect(after.status).toBe(TransferStatus.ACCEPTED)
    expect(after.lines.every((l) => l.shippedCostCents === null)).toBe(true)
    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(10)
    expect(
      await prisma.inventoryMovement.count({ where: { transferRequestId: created.id } }),
    ).toBe(0)
  })

  it('receive refuses counting more than was shipped', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)

    await expect(
      receiveTransfer(staffA, created.id, {
        lines: [{ lineId: created.lines[0]!.id, receivedBase: 6 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('a shortfall at receive writes NO movement anywhere — the loss lives on the line', async () => {
    await giveStock(storeB.id, eachVariantId, 10, 1000)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)

    const row = await receiveTransfer(staffA, created.id, {
      lines: [{ lineId: created.lines[0]!.id, receivedBase: 3 }],
    })
    expect(row.lines[0]!.receivedBase).toBe(3)
    expect((await stockAt(storeA.id, eachVariantId)).quantityBase).toBe(3)

    // One OUT for 5, one IN for 3. The missing 2 have no movement in either ledger.
    const movements = await prisma.inventoryMovement.findMany({
      where: { transferRequestId: created.id },
      select: { type: true, quantityBase: true },
    })
    expect(movements).toHaveLength(2)
    expect(movements.map((m) => m.quantityBase).sort()).toEqual([-5, 3])
  })
})

// --- cost conservation ---------------------------------------------------------------------

describe('cost conservation', () => {
  it('a full round trip conserves the combined basis to the cent', async () => {
    await giveStock(storeB.id, eachVariantId, 10, 1000)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)

    // costOut(1000, 10, 5) = 500 relieved; in transit it sits on the line, not a store.
    expect((await stockAt(storeB.id, eachVariantId)).costBasisCents).toBe(500)
    const shipped = await getTransfer(admin, created.id)
    expect(shipped.lines[0]!.shippedCostCents).toBe(500)

    await receiveTransfer(staffA, created.id, {})
    expect((await stockAt(storeA.id, eachVariantId)).costBasisCents).toBe(500)
    expect((await stockAt(storeB.id, eachVariantId)).costBasisCents).toBe(500)
  })

  it('an indivisible total (1001¢ over 3 units) conserves across two ships', async () => {
    // No per-unit figure exists for 1001/3 — the total-carriage path is the whole point.
    await giveStock(storeB.id, eachVariantId, 3, 1001)

    const first = await request([{ variantId: eachVariantId, quantityBase: 1 }])
    await acceptTransfer(staffB, first.id, {})
    await shipTransfer(staffB, first.id)
    await receiveTransfer(staffA, first.id, {})

    const second = await request([{ variantId: eachVariantId, quantityBase: 2 }])
    await acceptTransfer(staffB, second.id, {})
    await shipTransfer(staffB, second.id)
    await receiveTransfer(staffA, second.id, {})

    const a = await stockAt(storeA.id, eachVariantId)
    const b = await stockAt(storeB.id, eachVariantId)
    expect(a.quantityBase).toBe(3)
    expect(b.quantityBase).toBe(0)
    expect(b.costBasisCents).toBe(0)
    expect(a.costBasisCents).toBe(1001) // every cent arrived, none invented
  })

  it('an uncosted pool ships as null and never becomes zero on arrival', async () => {
    await giveStock(storeB.id, eachVariantId, 10) // no basis
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)

    const shipped = await getTransfer(admin, created.id)
    expect(shipped.lines[0]!.shippedCostCents).toBeNull()

    await receiveTransfer(staffA, created.id, {})
    expect((await stockAt(storeA.id, eachVariantId)).costBasisCents).toBeNull()
  })

  it('arrival into an already-costed pool blends by addition, like any receipt', async () => {
    await giveStock(storeA.id, eachVariantId, 10, 2000)
    await giveStock(storeB.id, eachVariantId, 10, 1000)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)
    await receiveTransfer(staffA, created.id, {})

    const a = await stockAt(storeA.id, eachVariantId)
    expect(a.quantityBase).toBe(15)
    expect(a.costBasisCents).toBe(2500) // 2000 + the 500 relieved from B
  })

  it('a short receipt gains the proportional share; the shortfall value lands nowhere', async () => {
    await giveStock(storeB.id, eachVariantId, 5, 1001)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id) // relieves the whole 1001 (pool empties)

    await receiveTransfer(staffA, created.id, {
      lines: [{ lineId: created.lines[0]!.id, receivedBase: 3 }],
    })

    // share = round(1001 × 3 / 5) = 601. The other 400 stays visible on the line only.
    expect((await stockAt(storeA.id, eachVariantId)).costBasisCents).toBe(601)
    expect((await stockAt(storeB.id, eachVariantId)).costBasisCents).toBe(0)
    const line = (await getTransfer(admin, created.id)).lines[0]!
    expect(line.shippedCostCents).toBe(1001)
  })

  it('a full receipt carries the snapshot verbatim — no division touches the common case', async () => {
    await giveStock(storeB.id, eachVariantId, 7, 999)
    const created = await request([{ variantId: eachVariantId, quantityBase: 7 }])
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)
    await receiveTransfer(staffA, created.id, {})

    expect((await stockAt(storeA.id, eachVariantId)).costBasisCents).toBe(999)
  })
})

// --- the costTotalCents contract on applyMovement --------------------------------------------

describe('applyMovement costTotalCents', () => {
  it('refuses a movement carrying both a unit cost and a total cost', async () => {
    await expect(
      applyMovement({
        storeId: storeA.id,
        variantId: eachVariantId,
        type: MovementType.RECEIVE,
        quantityBase: 5,
        unitCostCents: 100,
        costTotalCents: 500,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses a total cost on an outbound movement', async () => {
    await giveStock(storeA.id, eachVariantId, 10)
    await expect(
      applyMovement({
        storeId: storeA.id,
        variantId: eachVariantId,
        type: MovementType.SALE,
        quantityBase: -1,
        costTotalCents: 100,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses a negative total cost', async () => {
    await expect(
      applyMovement({
        storeId: storeA.id,
        variantId: eachVariantId,
        type: MovementType.RECEIVE,
        quantityBase: 5,
        costTotalCents: -1,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('a zero total cost is valid and adds nothing to the basis', async () => {
    await giveStock(storeA.id, eachVariantId, 10, 1000)
    const result = await applyMovement({
      storeId: storeA.id,
      variantId: eachVariantId,
      type: MovementType.TRANSFER_IN,
      quantityBase: 5,
      costTotalCents: 0,
    })
    expect(result.costBasisAfterCents).toBe(1000)
  })
})

// --- permissions -----------------------------------------------------------------------------

describe('permissions', () => {
  it('the requesting side cannot accept, decline or ship — those are the source’s legs', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await expect(acceptTransfer(staffA, created.id, {})).rejects.toBeInstanceOf(ForbiddenError)
    await expect(declineTransfer(staffA, created.id, 'no')).rejects.toBeInstanceOf(ForbiddenError)
    await acceptTransfer(staffB, created.id, {})
    await expect(shipTransfer(staffA, created.id)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('the source side cannot receive or cancel — those are the requester’s legs', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await expect(cancelTransfer(staffB, created.id, {})).rejects.toBeInstanceOf(ForbiddenError)
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)
    await expect(receiveTransfer(staffB, created.id, {})).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('an admin can act on every leg', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await createTransfer(admin, {
      sourceStoreId: storeB.id,
      requestingStoreId: storeA.id,
      lines: [{ variantId: eachVariantId, quantityBase: 5 }],
    })
    await acceptTransfer(admin, created.id, {})
    await shipTransfer(admin, created.id)
    const row = await receiveTransfer(admin, created.id, {})
    expect(row.status).toBe(TransferStatus.RECEIVED)
  })

  it('staff cannot request FOR another store', async () => {
    await expect(
      createTransfer(staffA, {
        sourceStoreId: storeC.id,
        requestingStoreId: storeB.id,
        lines: [{ variantId: eachVariantId, quantityBase: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('an uninvolved staff member gets 404, never confirmation the transfer exists', async () => {
    const created = await request()
    await expect(getTransfer(staffC, created.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('the list is involvement-scoped for staff and unscoped for admins', async () => {
    await request()
    expect(await listTransfers(staffA)).toHaveLength(1)
    expect(await listTransfers(staffB)).toHaveLength(1)
    expect(await listTransfers(staffC)).toHaveLength(0)
    expect(await listTransfers(admin)).toHaveLength(1)
    await expect(listTransfers(staffA, { storeId: storeB.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('a status filter narrows the list', async () => {
    const first = await request()
    await declineTransfer(staffB, first.id, 'no')
    await request([{ variantId: eachVariantId, quantityBase: 2 }])

    const pending = await listTransfers(admin, { status: TransferStatus.PENDING })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.status).toBe(TransferStatus.PENDING)
  })

  it('direct move is admin-only', async () => {
    await expect(
      directMove(staffA, {
        fromStoreId: storeB.id,
        toStoreId: storeA.id,
        lines: [{ variantId: eachVariantId, quantityBase: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- cost visibility -------------------------------------------------------------------------

describe('cost visibility', () => {
  it('a staff payload carries zero cost-shaped keys while the same transfer shows the admin its value', async () => {
    await giveStock(storeB.id, eachVariantId, 10, 1000)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})
    await shipTransfer(staffB, created.id)

    const staffView = await getTransfer(staffA, created.id)
    expect(findCostKeys(staffView)).toEqual([])
    const staffList = await listTransfers(staffB)
    expect(findCostKeys(staffList)).toEqual([])

    // The other direction — without this the staff assertion could pass vacuously.
    const adminView = await getTransfer(admin, created.id)
    expect(adminView.lines[0]!.shippedCostCents).toBe(500)
  })
})

// --- admin direct move -----------------------------------------------------------------------

describe('direct move', () => {
  it('moves stock in one transaction and records a request born RECEIVED', async () => {
    await giveStock(storeB.id, eachVariantId, 10, 1000)
    const row = await directMove(admin, {
      fromStoreId: storeB.id,
      toStoreId: storeA.id,
      note: 'Rebalancing for the weekend.',
      lines: [{ variantId: eachVariantId, quantityBase: 4 }],
    })

    expect(row.status).toBe(TransferStatus.RECEIVED)
    expect(row.requestedByName).toBe('Test Admin')
    expect(row.acceptedByName).toBe('Test Admin')
    expect(row.shippedByName).toBe('Test Admin')
    expect(row.receivedByName).toBe('Test Admin')
    expect(row.lines[0]).toMatchObject({
      requestedBase: 4,
      approvedBase: 4,
      receivedBase: 4,
      shippedCostCents: 400,
    })

    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(6)
    expect((await stockAt(storeA.id, eachVariantId)).quantityBase).toBe(4)
    expect((await stockAt(storeB.id, eachVariantId)).costBasisCents).toBe(600)
    expect((await stockAt(storeA.id, eachVariantId)).costBasisCents).toBe(400)

    const movements = await prisma.inventoryMovement.count({
      where: { transferRequestId: row.id },
    })
    expect(movements).toBe(2)
  })

  it('an oversell rolls the whole move back, request row included', async () => {
    await giveStock(storeB.id, eachVariantId, 3)
    await expect(
      directMove(admin, {
        fromStoreId: storeB.id,
        toStoreId: storeA.id,
        lines: [{ variantId: eachVariantId, quantityBase: 5 }],
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError)

    expect(await prisma.transferRequest.count()).toBe(0)
    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(3)
  })

  it('concurrent opposite-direction moves both complete — the canonical pre-lock prevents deadlock', async () => {
    await giveStock(storeA.id, eachVariantId, 10)
    await giveStock(storeB.id, eachVariantId, 10)

    const results = await Promise.allSettled([
      directMove(admin, {
        fromStoreId: storeA.id,
        toStoreId: storeB.id,
        lines: [{ variantId: eachVariantId, quantityBase: 2 }],
      }),
      directMove(admin, {
        fromStoreId: storeB.id,
        toStoreId: storeA.id,
        lines: [{ variantId: eachVariantId, quantityBase: 3 }],
      }),
    ])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    expect((await stockAt(storeA.id, eachVariantId)).quantityBase).toBe(11)
    expect((await stockAt(storeB.id, eachVariantId)).quantityBase).toBe(9)
  })
})

// --- realtime --------------------------------------------------------------------------------

describe('realtime', () => {
  let emitted: Array<{ room: string; name: string; payload: Record<string, unknown> }>

  beforeEach(() => {
    emitted = []
    const fake = {
      to: (room: string) => ({
        emit: (name: string, payload: Record<string, unknown>) => {
          emitted.push({ room, name, payload })
        },
      }),
    }
    setIo(fake as unknown as Server)
  })

  it('every transition announces transfer.changed to both store rooms and admin', async () => {
    const created = await request()
    const rooms = emitted
      .filter((e) => e.name === 'transfer.changed')
      .map((e) => e.room)
      .sort()
    expect(rooms).toEqual(['admin', `store:${storeA.id}`, `store:${storeB.id}`].sort())
    expect(emitted[0]!.payload).toMatchObject({
      transferId: created.id,
      status: TransferStatus.PENDING,
      requestingStoreId: storeA.id,
      sourceStoreId: storeB.id,
    })
  })

  it('ship and receive fan out stock.changed at the store whose stock moved', async () => {
    await giveStock(storeB.id, eachVariantId, 10)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})

    emitted = []
    await shipTransfer(staffB, created.id)
    const shipStock = emitted.filter((e) => e.name === 'stock.changed')
    expect(shipStock.some((e) => e.room === `store:${storeB.id}`)).toBe(true)
    expect(shipStock.every((e) => e.payload['storeId'] === storeB.id)).toBe(true)

    emitted = []
    await receiveTransfer(staffA, created.id, {})
    const receiveStock = emitted.filter((e) => e.name === 'stock.changed')
    expect(receiveStock.some((e) => e.room === `store:${storeA.id}`)).toBe(true)
    expect(receiveStock.every((e) => e.payload['storeId'] === storeA.id)).toBe(true)
  })

  it('a failed ship emits nothing — events follow commits, never attempts', async () => {
    await giveStock(storeB.id, eachVariantId, 2)
    const created = await request()
    await acceptTransfer(staffB, created.id, {})

    emitted = []
    await expect(shipTransfer(staffB, created.id)).rejects.toBeInstanceOf(InsufficientStockError)
    expect(emitted).toEqual([])
  })
})
