import {
  MovementType,
  TrackingMode,
  costOutCents,
  receiptLineValueCents,
  unitCostFromBasis,
} from '@huta/shared'
import type { MovementRow, StockLevelRow } from '@huta/shared/schemas'

import { canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, InsufficientStockError, NotFoundError } from '../errors/index.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * The single chokepoint for every stock change in the system.
 *
 * House rule: "Every change to on-hand quantity goes through a single service that writes
 * an `InventoryMovement` row inside the same Prisma transaction that mutates the stock
 * level. Never `UPDATE` a quantity directly from a route handler."
 *
 * Sales, receiving, transfers and adjustments all land here. The movement ledger is what
 * an audit reconstructs from, so a stock change without its movement row is worse than no
 * stock change at all.
 *
 * This service also maintains the WEIGHTED-AVERAGE COST BASIS, per store, in the same
 * locked section that moves the quantity. The two cannot be separated: an average cost is
 * a ratio against a quantity, so a basis updated outside the lock that moved the quantity
 * would be an average of two different moments.
 */

/**
 * A Prisma client that may or may not already be inside a transaction.
 *
 * `PrismaClient` and a transaction client differ only by the methods a transaction forbids
 * (`$transaction`, `$connect`, …), none of which this service calls.
 */
type Db = Prisma.TransactionClient

export interface MovementInput {
  readonly storeId: string
  readonly variantId: string
  readonly type: MovementType
  /** SIGNED delta in base units. Negative for SALE, TRANSFER_OUT, SHRINKAGE. */
  readonly quantityBase: number
  readonly userId?: string | undefined
  readonly note?: string | undefined
  /** Queryable category — see ADJUSTMENT_REASONS in @huta/shared. */
  readonly reasonCode?: string | undefined
  /**
   * What this stock cost — per item for EACH, per GRAM for WEIGHT. Set on RECEIVE.
   *
   * Omitting it on an inbound movement is a legitimate state, not an oversight: staff may
   * receive without cost and an admin enters it afterward. The basis is then left alone
   * rather than diluted, because valuing unknown stock at zero would drag every margin
   * number that variant touches toward 100%.
   */
  readonly unitCostCents?: number | undefined
  /**
   * EXACT total value entering the pool, in cents — the transfer path. Mutually
   * exclusive with `unitCostCents` and inbound-only.
   *
   * Transfers relieve the source's basis as a proportional share of a total, and the
   * destination must gain EXACTLY what the source lost. A per-unit figure cannot carry
   * that: 1001¢ over 3 units has no per-unit representation, and total→unit→total
   * invents or loses a penny. Zero is valid (an uncosted pool ships as unknown value,
   * but a costed pool can genuinely relieve 0¢ on a rounding edge).
   */
  readonly costTotalCents?: number | undefined
  /** Reserved for batch tracking. The columns exist on both tables; nothing sets it yet. */
  readonly batchId?: string | undefined
  /** Whichever record caused this movement. */
  readonly reference?:
    | { saleId: string }
    | { receiptId: string }
    | { transferRequestId: string }
    | { refundId: string }
    | undefined
}

export interface MovementResult {
  readonly movementId: string
  readonly balanceAfterBase: number
  readonly previousBase: number
  /** The store's cost basis after this movement. Null when the stock is uncosted. */
  readonly costBasisAfterCents: number | null
  /**
   * The basis BEFORE this movement — what an outbound movement relieved cost from.
   * Checkout snapshots `SaleLine.unitCostCents` from this (basis ÷ previous quantity);
   * null means the stock was uncosted, which stays null — never zero.
   */
  readonly previousCostBasisCents: number | null
}

/**
 * Apply one movement, atomically.
 *
 * The row lock matters: two concurrent adjustments on the same variant must serialise, or
 * one silently overwrites the other and the ledger stops reconciling with the materialised
 * quantity. `SELECT … FOR UPDATE` inside the transaction is what makes the read-modify-
 * write safe; a plain `findUnique` then `update` would not be.
 *
 * Pass `tx` to enlist in a caller's transaction. A receipt writes its `Receipt` row, every
 * `ReceiptLine`, and one movement per line; without this parameter that would be N+1
 * separate transactions, and a failure on the last line would leave the earlier lines'
 * stock posted against a receipt that no longer exists. Omitting `tx` opens one, exactly
 * as before — the chokepoint is unchanged, it just no longer insists on being outermost.
 */
export async function applyMovement(
  input: MovementInput,
  tx?: Db,
): Promise<MovementResult> {
  if (input.quantityBase === 0) {
    // The DB CHECK would reject this anyway; failing here gives a usable message instead
    // of a constraint violation.
    throw new ConflictError('A stock movement cannot be zero.')
  }

  if (input.costTotalCents !== undefined) {
    if (input.unitCostCents !== undefined) {
      throw new ConflictError('A movement can carry a unit cost or a total cost, not both.')
    }
    if (input.quantityBase < 0) {
      throw new ConflictError(
        'A total cost only applies to inbound stock — outbound movements relieve the basis proportionally.',
      )
    }
    if (input.costTotalCents < 0) {
      throw new ConflictError('A total cost cannot be negative.')
    }
  }

  if (tx) return applyMovementIn(tx, input)
  return prisma.$transaction((inner) => applyMovementIn(inner, input))
}

async function applyMovementIn(tx: Db, input: MovementInput): Promise<MovementResult> {
  // Lock the row if it exists. Ashley has no StockLevel rows at all, so a first
  // movement at a store must create one rather than fail — hence upsert below.
  const locked = await tx.$queryRaw<Array<{ quantityBase: number; costBasisCents: number | null }>>`
      SELECT "quantityBase", "costBasisCents" FROM "StockLevel"
       WHERE "storeId" = ${input.storeId} AND "variantId" = ${input.variantId}
       FOR UPDATE
    `

  const previousBase = locked[0]?.quantityBase ?? 0
  const previousBasis = locked[0]?.costBasisCents ?? null
  const balanceAfterBase = previousBase + input.quantityBase

  if (balanceAfterBase < 0) {
    throw new InsufficientStockError(previousBase, Math.abs(input.quantityBase))
  }

  const costBasisAfterCents = await nextCostBasis(tx, input, {
    previousBase,
    previousBasis,
    balanceAfterBase,
  })

  await tx.stockLevel.upsert({
    where: { storeId_variantId: { storeId: input.storeId, variantId: input.variantId } },
    update: { quantityBase: balanceAfterBase, costBasisCents: costBasisAfterCents },
    create: {
      storeId: input.storeId,
      variantId: input.variantId,
      quantityBase: balanceAfterBase,
      costBasisCents: costBasisAfterCents,
    },
  })

  const movement = await tx.inventoryMovement.create({
    data: {
      storeId: input.storeId,
      variantId: input.variantId,
      type: input.type,
      quantityBase: input.quantityBase,
      balanceAfterBase,
      costBasisAfterCents,
      ...(input.unitCostCents === undefined ? {} : { unitCostCents: input.unitCostCents }),
      ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      ...(input.reference ?? {}),
    },
    select: { id: true },
  })

  return {
    movementId: movement.id,
    balanceAfterBase,
    previousBase,
    costBasisAfterCents,
    previousCostBasisCents: previousBasis,
  }
}

interface BasisContext {
  readonly previousBase: number
  readonly previousBasis: number | null
  readonly balanceAfterBase: number
}

/**
 * Where the weighted average is actually maintained.
 *
 * Four cases, and the interesting ones are the two that do nothing:
 *
 *   * Stock in WITH a cost — add what the delivery was worth. This is the only path that
 *     ever raises the basis.
 *   * Stock in WITHOUT a cost — leave the basis alone. The pool now holds units we cannot
 *     value; saying nothing is honest, while adding zero would claim they were free.
 *   * Stock out — remove the proportional share, which is what "weighted average" means on
 *     the way out. The whole pool leaving takes the whole basis so no residual survives a
 *     variant hitting zero.
 *   * Nothing known either way — stays null.
 */
async function nextCostBasis(
  tx: Db,
  input: MovementInput,
  ctx: BasisContext,
): Promise<number | null> {
  const inbound = input.quantityBase > 0

  // The exact-total path (transfers): mode-agnostic by design — the figure is already a
  // total, so no per-unit × quantity extension (and no trackingMode read) applies.
  if (inbound && input.costTotalCents !== undefined) {
    return (ctx.previousBasis ?? 0) + input.costTotalCents
  }

  if (inbound && input.unitCostCents === undefined) return ctx.previousBasis

  if (!inbound) {
    if (ctx.previousBasis === null) return null
    const out = costOutCents(ctx.previousBasis, ctx.previousBase, Math.abs(input.quantityBase))
    return ctx.previousBasis - out
  }

  // The tracking mode decides whether the unit cost is per item or per gram, and reading
  // it here rather than trusting the caller is what keeps a 1000x error out of the basis.
  const variant = await tx.productVariant.findUnique({
    where: { id: input.variantId },
    select: { trackingMode: true },
  })
  if (!variant) throw new NotFoundError('That product variant does not exist.')

  const added = receiptLineValueCents(
    variant.trackingMode as TrackingMode,
    input.quantityBase,
    input.unitCostCents as number,
  )

  return (ctx.previousBasis ?? 0) + added
}

export interface AdjustInput {
  readonly storeId: string
  readonly variantId: string
  /** What was actually counted on the shelf, in base units. */
  readonly countedBase: number
  /** The category: damaged, miscount, expired, theft, other. Stored for reporting. */
  readonly reasonCode: string
  /** Optional free-text detail alongside the category. */
  readonly note?: string | undefined
  readonly userId: string
}

export interface AdjustResult extends MovementResult {
  readonly deltaBase: number
}

/**
 * Correct a stock level to a counted total.
 *
 * Takes what was counted, not the difference — that is how a stocktake actually happens,
 * and nobody should be doing subtraction in their head while holding a clipboard. The
 * delta is derived here and it is the delta that reaches the ledger.
 */
export async function adjustStock(input: AdjustInput): Promise<AdjustResult> {
  if (input.countedBase < 0) {
    throw new ConflictError('A counted quantity cannot be negative.')
  }
  const reasonCode = input.reasonCode.trim()
  if (reasonCode.length === 0) {
    // An unexplained adjustment is indistinguishable from theft six months later. The
    // ledger is the only record, so the reason is not optional.
    throw new ConflictError('An adjustment needs a reason.')
  }
  const note = input.note?.trim()

  const variant = await prisma.productVariant.findUnique({
    where: { id: input.variantId },
    select: { id: true },
  })
  if (!variant) throw new NotFoundError('That product variant does not exist.')

  const existing = await prisma.stockLevel.findUnique({
    where: { storeId_variantId: { storeId: input.storeId, variantId: input.variantId } },
    select: { quantityBase: true },
  })
  const currentBase = existing?.quantityBase ?? 0
  const deltaBase = input.countedBase - currentBase

  if (deltaBase === 0) {
    // Refused rather than silently written: a zero movement violates the DB CHECK, and
    // "nothing changed" is a better answer than a constraint error.
    throw new ConflictError('That count matches the current quantity — nothing to adjust.')
  }

  const result = await applyMovement({
    storeId: input.storeId,
    variantId: input.variantId,
    type: MovementType.ADJUSTMENT,
    quantityBase: deltaBase,
    userId: input.userId,
    reasonCode,
    ...(note ? { note } : {}),
  })

  // The movement is the operational record; this is the "who did what" record. Both,
  // because the ledger explains the stock and the audit log explains the person.
  await prisma.auditLog.create({
    data: {
      userId: input.userId,
      action: 'inventory.adjust',
      entityType: 'StockLevel',
      entityId: `${input.storeId}:${input.variantId}`,
      before: { quantityBase: currentBase },
      after: { quantityBase: result.balanceAfterBase, reasonCode, ...(note ? { note } : {}) },
    },
  })

  return { ...result, deltaBase }
}

/**
 * Stock for one variant across every store.
 *
 * Built from the full store list and LEFT-joined onto stock, so a store with no row reads
 * as 0 rather than vanishing. Ashley currently has no StockLevel rows at all, and an
 * inner join would silently drop it from every breakdown.
 *
 * The per-store average cost rides along for a principal that may see cost, because "what
 * did each store pay for this" is the whole point of costing per store — a single blended
 * number would answer a question nobody asked.
 */
export async function levelsForVariant(
  principal: Principal,
  variantId: string,
): Promise<StockLevelRow[]> {
  const showCost = canSeeCost(principal)

  const [stores, levels, variant] = await Promise.all([
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.stockLevel.findMany({
      where: { variantId },
      select: {
        storeId: true,
        quantityBase: true,
        reorderPointBase: true,
        // Decided at the select, never deleted on the way out — same rule as the catalog's
        // variant cost, and for the same reason.
        ...(showCost ? { costBasisCents: true } : {}),
      },
    }),
    prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { trackingMode: true },
    }),
  ])

  const byStore = new Map(levels.map((l) => [l.storeId, l]))

  return stores.map((store) => {
    const level = byStore.get(store.id)
    const quantityBase = level?.quantityBase ?? 0
    const basis = showCost ? (level?.costBasisCents ?? null) : null

    return {
      storeId: store.id,
      storeName: store.name,
      quantityBase,
      reorderPointBase: level?.reorderPointBase ?? null,
      ...(showCost
        ? {
            costBasisCents: basis,
            avgUnitCostCents: variant
              ? unitCostFromBasis(variant.trackingMode as TrackingMode, basis, quantityBase)
              : null,
          }
        : {}),
    }
  })
}

/**
 * The movement ledger for one variant — what an investigation reads.
 *
 * Cost rides along only for a principal that may see it. This is the ledger that makes
 * "why did the average cost move in March" answerable, which is the entire justification
 * for `costBasisAfterCents` existing.
 */
export async function movementsForVariant(
  principal: Principal,
  variantId: string,
  storeId?: string,
  limit = 100,
): Promise<MovementRow[]> {
  const showCost = canSeeCost(principal)

  const rows = await prisma.inventoryMovement.findMany({
    where: { variantId, ...(storeId ? { storeId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      quantityBase: true,
      balanceAfterBase: true,
      // Why, not just what. Without it a SHRINKAGE row cannot be told apart from theft, and
      // separating moisture loss from theft is the entire point of the reason code.
      reasonCode: true,
      note: true,
      createdAt: true,
      ...(showCost ? { unitCostCents: true, costBasisAfterCents: true } : {}),
      store: { select: { id: true, name: true } },
      user: { select: { firstName: true, lastName: true } },
    },
  })

  // Flatten to the wire shape. The nested store/user objects never leave this function —
  // `MovementRow` is flat, and this mapping is where the two are reconciled.
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    quantityBase: row.quantityBase,
    balanceAfterBase: row.balanceAfterBase,
    reasonCode: row.reasonCode,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    storeId: row.store.id,
    storeName: row.store.name,
    userName: row.user ? `${row.user.firstName} ${row.user.lastName}` : null,
    ...(showCost
      ? {
          unitCostCents: (row as { unitCostCents?: number | null }).unitCostCents ?? null,
          costBasisAfterCents:
            (row as { costBasisAfterCents?: number | null }).costBasisAfterCents ?? null,
        }
      : {}),
  }))
}
