import {
  MovementType,
  RECONCILE_REASON_CODE,
  TrackingMode,
  costOutCents,
  divRoundHalfUp,
  unitCostFromBasis,
} from '@huta/shared'
import type {
  ReconcileResult,
  ReconcileResultLine,
  ReconcileRow,
  WeightVarianceRow,
} from '@huta/shared/schemas'

import { canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/index.js'
import { applyMovement } from './inventory.service.js'

/**
 * Weight reconciliation.
 *
 * House rule: "Flower loses moisture, and selling a 448000mg pound in keyed gram increments
 * accumulates drift. This is normal, not a bug." So this is a routine counting session over
 * every weight-tracked variant at a store, not an exception path.
 *
 * Two rules that are not negotiable:
 *
 *   * A variant the admin did not count is ABSENT from the input, never sent as zero.
 *     Treating an uncounted shelf as zero would write off the entire pool, and the ledger
 *     is append-only so there is no undo.
 *   * A shortfall writes SHRINKAGE and a surplus writes ADJUSTMENT. `SHRINKAGE` is in
 *     `NEGATIVE_MOVEMENT_TYPES` and the DB direction CHECK enforces it — stock cannot shrink
 *     upward, and a positive SHRINKAGE would be rejected by the database anyway.
 */

/** What to count: every weight-tracked variant that the store actually holds. */
export async function reconcileSheet(
  principal: Principal,
  storeId: string,
): Promise<ReconcileRow[]> {
  if (!canSeeCost(principal)) {
    throw new ForbiddenError('Only an admin may reconcile weight.')
  }

  const levels = await prisma.stockLevel.findMany({
    where: {
      storeId,
      quantityBase: { gt: 0 },
      variant: { trackingMode: TrackingMode.WEIGHT, active: true },
    },
    select: {
      quantityBase: true,
      costBasisCents: true,
      variant: {
        select: {
          id: true,
          sku: true,
          label: true,
          trackingMode: true,
          product: { select: { name: true } },
        },
      },
    },
  })

  return levels
    .map((level) => ({
      variantId: level.variant.id,
      productName: level.variant.product.name,
      label: level.variant.label,
      sku: level.variant.sku,
      onRecordBase: level.quantityBase,
      avgUnitCostCents: unitCostFromBasis(
        TrackingMode.WEIGHT,
        level.costBasisCents,
        level.quantityBase,
      ),
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName))
}

export interface ReconcileInput {
  readonly storeId: string
  readonly userId: string
  readonly counts: ReadonlyArray<{ variantId: string; countedBase: number }>
  readonly reasonCode?: string | undefined
  readonly note?: string | undefined
}

/**
 * Post a counting session.
 *
 * ONE transaction covers every movement and the audit row, following the receiving service
 * rather than `adjustStock` — a half-posted count is worse than none, and an audit record
 * that outlives the movements it describes explains a stock level that never existed.
 */
export async function reconcileWeights(
  principal: Principal,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  if (!canSeeCost(principal)) {
    throw new ForbiddenError('Only an admin may reconcile weight.')
  }
  if (input.counts.length === 0) {
    throw new ConflictError('Nothing was counted.')
  }

  const seen = new Set<string>()
  for (const count of input.counts) {
    if (count.countedBase < 0) throw new ConflictError('A counted weight cannot be negative.')
    if (seen.has(count.variantId)) {
      throw new ConflictError('The same product was counted twice.')
    }
    seen.add(count.variantId)
  }

  const store = await prisma.store.findUnique({
    where: { id: input.storeId },
    select: { id: true, name: true },
  })
  if (!store) throw new NotFoundError('That store does not exist.')

  const levels = await prisma.stockLevel.findMany({
    where: { storeId: input.storeId, variantId: { in: [...seen] } },
    select: {
      variantId: true,
      quantityBase: true,
      costBasisCents: true,
      variant: {
        select: { id: true, trackingMode: true, product: { select: { name: true } } },
      },
    },
  })
  const byVariant = new Map(levels.map((l) => [l.variantId, l]))

  for (const count of input.counts) {
    const level = byVariant.get(count.variantId)
    if (!level) throw new NotFoundError('A counted product has no stock at that store.')
    if (level.variant.trackingMode !== TrackingMode.WEIGHT) {
      // Reconciliation is a weight concept. A discrete item that is miscounted goes through
      // the ordinary stock adjustment, which asks for a reason per item.
      throw new ConflictError('Only weight-tracked products can be reconciled.')
    }
  }

  const reasonCode = (input.reasonCode ?? RECONCILE_REASON_CODE).trim()
  if (reasonCode.length === 0) throw new ConflictError('A reconciliation needs a reason.')
  const note = input.note?.trim()

  const changed = input.counts
    .map((count) => {
      const level = byVariant.get(count.variantId)!
      return { count, level, deltaBase: count.countedBase - level.quantityBase }
    })
    // A count that matches is not a movement. `applyMovement` refuses a zero delta and the
    // DB CHECK refuses a zero quantity, so filtering here is what lets an admin submit a
    // whole shelf when only two strains moved.
    .filter((row) => row.deltaBase !== 0)

  if (changed.length === 0) {
    throw new ConflictError('Every count matches what is on record — nothing to reconcile.')
  }

  const lines: ReconcileResultLine[] = []

  await prisma.$transaction(async (tx) => {
    for (const row of changed) {
      const down = row.deltaBase < 0

      const result = await applyMovement(
        {
          storeId: input.storeId,
          variantId: row.count.variantId,
          // The sign rule, in one place. SHRINKAGE is negative-only by CHECK constraint.
          type: down ? MovementType.SHRINKAGE : MovementType.ADJUSTMENT,
          quantityBase: row.deltaBase,
          userId: input.userId,
          reasonCode,
          ...(note ? { note } : {}),
        },
        tx,
      )

      // What the write-off was worth, at the store's weighted-average cost BEFORE the
      // movement relieved it. `applyMovement` has already adjusted the basis proportionally;
      // this is the same figure reported back so the admin sees the money, not just the grams.
      const valueCents = down
        ? -costOutCents(row.level.costBasisCents, row.level.quantityBase, Math.abs(row.deltaBase))
        : null

      lines.push({
        variantId: row.count.variantId,
        productName: row.level.variant.product.name,
        deltaBase: row.deltaBase,
        movementType: down ? MovementType.SHRINKAGE : MovementType.ADJUSTMENT,
        valueCents,
      })

      void result
    }

    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'inventory.reconcileWeight',
        entityType: 'Store',
        entityId: input.storeId,
        before: {
          counted: changed.map((r) => ({
            variantId: r.count.variantId,
            onRecordBase: r.level.quantityBase,
          })),
        },
        after: {
          counted: changed.map((r) => ({
            variantId: r.count.variantId,
            countedBase: r.count.countedBase,
            deltaBase: r.deltaBase,
          })),
          reasonCode,
          ...(note ? { note } : {}),
        },
      },
    })
  })

  const totalValue = lines.reduce<number | null>((sum, line) => {
    if (line.valueCents === null) return sum
    return (sum ?? 0) + line.valueCents
  }, null)

  return {
    storeId: store.id,
    storeName: store.name,
    lines,
    totalDeltaBase: lines.reduce((sum, line) => sum + line.deltaBase, 0),
    totalValueCents: totalValue,
  }
}

/**
 * Cumulative weight variance for one variant, per store.
 *
 * A raw gram figure is not a signal — an ounce lost on a pound received is very different
 * from an ounce lost on a gram. The rate against weight received is what makes one strain
 * comparable to another, which is the whole point: "a strain bleeding far more weight than
 * its peers is worth a look."
 */
export async function weightVarianceForVariant(
  principal: Principal,
  variantId: string,
  sinceDays = 90,
): Promise<WeightVarianceRow[]> {
  if (!canSeeCost(principal)) {
    throw new ForbiddenError('Only an admin may see weight variance.')
  }

  const since = new Date(Date.now() - sinceDays * 86_400_000)

  const [stores, movements] = await Promise.all([
    prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryMovement.findMany({
      where: {
        variantId,
        createdAt: { gte: since },
        type: { in: [MovementType.RECEIVE, MovementType.SHRINKAGE] },
      },
      select: { storeId: true, type: true, quantityBase: true },
    }),
  ])

  const totals = new Map<string, { received: number; lost: number }>()
  for (const movement of movements) {
    const entry = totals.get(movement.storeId) ?? { received: 0, lost: 0 }
    if (movement.type === MovementType.RECEIVE) entry.received += movement.quantityBase
    // SHRINKAGE is stored negative; report it as a positive loss.
    else entry.lost += Math.abs(movement.quantityBase)
    totals.set(movement.storeId, entry)
  }

  return stores.map((store) => {
    const entry = totals.get(store.id) ?? { received: 0, lost: 0 }
    return {
      storeId: store.id,
      storeName: store.name,
      receivedBase: entry.received,
      lostBase: entry.lost,
      lossRateBps:
        entry.received > 0 ? divRoundHalfUp(entry.lost * 10_000, entry.received) : null,
    }
  })
}
