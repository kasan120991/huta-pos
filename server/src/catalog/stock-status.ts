import type { StockStatus, TrackingMode } from '@huta/shared'
import type { ProductStock, VariantStock } from '@huta/shared/schemas'

/**
 * Where stock sits against its reorder point.
 *
 * Resolved on the server for two reasons, both of which the old `StockCell` got wrong by
 * doing it in the browser:
 *
 *  1. The threshold falls back through the category, which the client does not have.
 *  2. A bare quantity carries no unit. `3` is three items or three MILLIGRAMS depending on
 *     the variant's tracking mode, so the old hardcoded `total <= 3` marked a gram of
 *     flower as healthy and only turned amber at 3mg — dust.
 */

export interface StoreScopedLevel {
  readonly storeId: string
  readonly quantityBase: number
  readonly reorderPointBase: number | null
}

export interface VariantStockInput {
  readonly trackingMode: TrackingMode
  readonly stockLevels: readonly StoreScopedLevel[]
  /** Fallback from the product's category. Null when the category sets none. */
  readonly categoryDefaultReorderBase: number | null
}

/**
 * Reduce one variant's stock rows over the stores in scope.
 *
 * `storeIds` is the authority on which stores count AND on column order — a store with no
 * StockLevel row still gets a zero entry, because Ashley has no rows at all and a missing
 * column would silently shift the table's numbers under the wrong heading.
 */
export function resolveVariantStock(
  input: VariantStockInput,
  storeIds: readonly string[],
): VariantStock {
  const byId = new Map(input.stockLevels.map((l) => [l.storeId, l]))

  const byStore = storeIds.map((storeId) => ({
    storeId,
    quantityBase: byId.get(storeId)?.quantityBase ?? 0,
  }))

  const quantityBase = byStore.reduce((sum, s) => sum + s.quantityBase, 0)

  // Summed across the in-scope stores, so "both stores" compares a combined quantity
  // against a combined threshold rather than against one store's. A store with no row
  // contributes the category default, which is the point of having one.
  let reorderBase: number | null = null
  for (const storeId of storeIds) {
    const point = byId.get(storeId)?.reorderPointBase ?? input.categoryDefaultReorderBase
    if (point === null) continue
    reorderBase = (reorderBase ?? 0) + point
  }

  return {
    quantityBase,
    reorderBase,
    status: statusFor(quantityBase, reorderBase),
    byStore,
  }
}

function statusFor(quantityBase: number, reorderBase: number | null): StockStatus {
  if (quantityBase <= 0) return 'OUT'
  // A null or zero threshold makes LOW unreachable. That is deliberate: with no reorder
  // point recorded anywhere, "below reorder" would be a guess dressed as a fact.
  if (reorderBase !== null && reorderBase > 0 && quantityBase <= reorderBase) return 'LOW'
  return 'OK'
}

const SEVERITY: Record<StockStatus, number> = { OUT: 2, LOW: 1, OK: 0 }

/**
 * Roll a product up from its variants.
 *
 * Status is the WORST variant, not an average and not the first: a tincture family with
 * five healthy potencies and one at zero is a product that needs attention, and a row
 * reporting OK would hide the only fact worth acting on.
 */
export function resolveProductStock(
  variants: readonly VariantStock[],
  trackingModes: readonly TrackingMode[],
  storeIds: readonly string[],
): ProductStock {
  const status = variants.reduce<StockStatus>(
    (worst, v) => (SEVERITY[v.status] > SEVERITY[worst] ? v.status : worst),
    'OK',
  )

  // Never sum across tracking modes — House rule: "units sold is meaningless across a gummy
  // and a gram". A mixed product reports no total rather than a wrong one.
  const first = trackingModes[0]
  const uniformMode =
    first !== undefined && trackingModes.every((m) => m === first) ? first : null

  const byStore = storeIds.map((storeId) => ({
    storeId,
    quantityBase:
      uniformMode === null
        ? 0
        : variants.reduce(
            (sum, v) => sum + (v.byStore.find((b) => b.storeId === storeId)?.quantityBase ?? 0),
            0,
          ),
  }))

  return {
    status,
    quantityBase:
      uniformMode === null ? null : variants.reduce((sum, v) => sum + v.quantityBase, 0),
    trackingMode: uniformMode,
    byStore,
    outCount: variants.filter((v) => v.status === 'OUT').length,
    variantCount: variants.length,
  }
}
