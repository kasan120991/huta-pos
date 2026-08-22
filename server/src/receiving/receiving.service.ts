import {
  MovementType,
  PurchaseOrderStatus,
  TrackingMode,
  receiptLineValueCents,
} from '@huta/shared'
import type {
  OpenOrderRow,
  ReceiptInput,
  ReceiptLineInput,
  ReceiptRow,
  VarianceLine,
} from '@huta/shared/schemas'

import { canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/index.js'
import type { Prisma } from '../generated/prisma/client.js'
import { uniqueProductSlug } from '../catalog/product-slug.js'
import { applyMovement } from '../inventory/inventory.service.js'
import { formatReference, receivedByVariant } from '../purchasing/purchase-order.service.js'
import { emitToAdmin } from '../realtime/emitter.js'

/**
 * Receiving — the one path that creates stock from nothing.
 *
 * That makes it the primary inventory-fraud and data-error vector, which is why every
 * receipt is permanently attributed (who, when, which store, which lines) and why receipts
 * post immediately with no approval gate: the house position is that inventory staying
 * accurate matters more than a gate, and the audit trail is the control.
 *
 * Staff can receive. Staff cannot see or enter cost — not hidden in the UI while present
 * in the payload, but omitted from the response entirely and refused on the way in.
 */

// --- reads -----------------------------------------------------------------------------

function lineSelect(principal: Principal) {
  return {
    id: true,
    quantityBase: true,
    // The ONE place receipt-line cost is decided.
    ...(canSeeCost(principal) ? { unitCostCents: true } : {}),
    variant: {
      select: {
        id: true,
        sku: true,
        label: true,
        trackingMode: true,
        product: { select: { name: true } },
      },
    },
  }
}

function receiptSelect(principal: Principal) {
  return {
    id: true,
    storeId: true,
    supplierId: true,
    receivedById: true,
    receivedAt: true,
    invoiceNumber: true,
    notes: true,
    hasVariance: true,
    reviewedAt: true,
    purchaseOrderId: true,
    store: { select: { name: true } },
    supplier: { select: { name: true } },
    purchaseOrder: { select: { number: true } },
    reviewedBy: { select: { firstName: true, lastName: true } },
    receivedBy: { select: { firstName: true, lastName: true } },
    lines: { select: lineSelect(principal), orderBy: { id: 'asc' as const } },
  }
}

type ReceiptQueryRow = {
  id: string
  storeId: string
  supplierId: string | null
  receivedById: string
  receivedAt: Date
  invoiceNumber: string | null
  notes: string | null
  hasVariance: boolean
  reviewedAt: Date | null
  purchaseOrderId: string | null
  store: { name: string }
  supplier: { name: string } | null
  purchaseOrder: { number: number | null } | null
  reviewedBy: { firstName: string; lastName: string } | null
  receivedBy: { firstName: string; lastName: string }
  lines: Array<{
    id: string
    quantityBase: number
    unitCostCents?: number | null
    variant: {
      id: string
      sku: string
      label: string | null
      trackingMode: string
      product: { name: string }
    }
  }>
}

function toRow(principal: Principal, row: ReceiptQueryRow): ReceiptRow {
  const showCost = canSeeCost(principal)

  const lines = row.lines.map((line) => ({
    id: line.id,
    variantId: line.variant.id,
    productName: line.variant.product.name,
    label: line.variant.label,
    sku: line.variant.sku,
    trackingMode: line.variant.trackingMode,
    quantityBase: line.quantityBase,
    ...(showCost ? { unitCostCents: line.unitCostCents ?? null } : {}),
  }))

  return {
    id: row.id,
    storeId: row.storeId,
    storeName: row.store.name,
    supplierId: row.supplierId,
    supplierName: row.supplier?.name ?? null,
    receivedById: row.receivedById,
    receivedByName: `${row.receivedBy.firstName} ${row.receivedBy.lastName}`.trim(),
    receivedAt: row.receivedAt.toISOString(),
    invoiceNumber: row.invoiceNumber,
    notes: row.notes,
    hasVariance: row.hasVariance,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedByName: row.reviewedBy
      ? `${row.reviewedBy.firstName} ${row.reviewedBy.lastName}`.trim()
      : null,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderReference:
      row.purchaseOrderId === null ? null : formatReference(row.purchaseOrder?.number ?? null),
    lines,
    // Both of these are cost-derived, so they are omitted rather than zeroed for staff.
    // A field that renders differently per role is a field that leaks the difference.
    ...(showCost
      ? {
          uncostedLineCount: row.lines.filter((l) => l.unitCostCents === null).length,
          totalCostCents: totalCostOf(row),
        }
      : {}),
  }
}

function totalCostOf(row: ReceiptQueryRow): number | null {
  const costed = row.lines.filter((l) => l.unitCostCents !== null && l.unitCostCents !== undefined)
  if (costed.length === 0) return null

  return costed.reduce(
    (sum, line) =>
      sum +
      receiptLineValueCents(
        line.variant.trackingMode as TrackingMode,
        line.quantityBase,
        line.unitCostCents as number,
      ),
    0,
  )
}

export interface ReceiptFilter {
  readonly storeId?: string | undefined
  readonly supplierId?: string | undefined
  /** Admin costing queue: receipts with at least one line carrying no cost. */
  readonly uncostedOnly?: boolean | undefined
  /** Admin review queue: flagged and not yet signed off. */
  readonly needsReviewOnly?: boolean | undefined
  readonly limit?: number
}

export async function listReceipts(
  principal: Principal,
  filter: ReceiptFilter = {},
): Promise<ReceiptRow[]> {
  const rows = await prisma.receipt.findMany({
    where: {
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(filter.uncostedOnly ? { lines: { some: { unitCostCents: null } } } : {}),
      ...(filter.needsReviewOnly ? { hasVariance: true, reviewedAt: null } : {}),
    },
    select: receiptSelect(principal),
    orderBy: { receivedAt: 'desc' },
    take: filter.limit ?? 100,
  })

  return rows.map((row) => toRow(principal, row as ReceiptQueryRow))
}

export async function getReceipt(principal: Principal, id: string): Promise<ReceiptRow> {
  const row = await prisma.receipt.findUnique({
    where: { id },
    select: receiptSelect(principal),
  })
  if (!row) throw new NotFoundError('That receipt does not exist.')
  return toRow(principal, row as ReceiptQueryRow)
}

// --- writes ----------------------------------------------------------------------------

export interface CreateReceiptInput extends ReceiptInput {
  readonly storeId: string
  readonly userId: string
}

/**
 * Post a delivery.
 *
 * ONE transaction covers the `Receipt`, every `ReceiptLine`, every `RECEIVE` movement and
 * the audit row. That is what `applyMovement`'s optional `tx` parameter exists for: a
 * failure on the last line of a ten-line delivery must not leave the first nine posted
 * against a receipt that was rolled back, which is precisely what N separate transactions
 * would produce.
 *
 * The audit row goes INSIDE the transaction, unlike `adjustStock` which writes its own
 * outside. Receiving is the fraud vector; its attribution should not be able to outlive a
 * rollback of the stock it describes.
 */
export async function createReceipt(
  principal: Principal,
  input: CreateReceiptInput,
): Promise<ReceiptRow> {
  if (input.lines.length === 0) {
    throw new ConflictError('A delivery needs at least one line.')
  }

  const showCost = canSeeCost(principal)
  for (const line of input.lines) {
    if (line.quantityBase <= 0) {
      // The DB CHECK would reject this too; failing here gives a usable message.
      throw new ConflictError('A delivery line needs a quantity greater than zero.')
    }
    if (line.unitCostCents !== undefined && !showCost) {
      // Refused, not silently dropped. A staff terminal that thinks it recorded a cost and
      // did not is a worse failure than being told no.
      throw new ForbiddenError('Only an admin may enter cost.')
    }
  }

  await assertVariantsExist(input.lines)

  if (input.supplierId) {
    const supplier = await prisma.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, active: true },
    })
    if (!supplier) throw new NotFoundError('That supplier does not exist.')
    if (!supplier.active) throw new ConflictError('That supplier is no longer active.')
  }

  const order = input.purchaseOrderId ? await loadOrderForReceipt(input) : null

  // An admin who did not type a cost inherits the one on the order line — that is what the
  // PO line's ADMIN-ONLY cost is for. A staff principal never reaches this branch, because
  // any cost at all was already refused above.
  const lines = order && showCost ? withOrderCosts(input.lines, order) : input.lines

  const variance = order ? varianceAgainstOrder(lines, order) : []

  const receiptId = await prisma.$transaction(async (tx) => {
    const receipt = await tx.receipt.create({
      data: {
        storeId: input.storeId,
        receivedById: input.userId,
        // Over-delivery and an unexpected item flag immediately. A SHORT delivery does not:
        // while the order is open that is just a partial, and flagging it would fire on
        // every normal split delivery. Short becomes a variance only when someone closes
        // the order — see `closeShort` in the purchasing service.
        ...(variance.length > 0 ? { hasVariance: true } : {}),
        ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
        ...(input.supplierId ? { supplierId: input.supplierId } : {}),
        ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber.trim() } : {}),
        ...(input.notes ? { notes: input.notes.trim() } : {}),
      },
      select: { id: true },
    })

    for (const line of lines) {
      await tx.receiptLine.create({
        data: {
          receiptId: receipt.id,
          variantId: line.variantId,
          quantityBase: line.quantityBase,
          ...(line.unitCostCents === undefined ? {} : { unitCostCents: line.unitCostCents }),
        },
      })

      await applyMovement(
        {
          storeId: input.storeId,
          variantId: line.variantId,
          type: MovementType.RECEIVE,
          quantityBase: line.quantityBase,
          userId: input.userId,
          unitCostCents: line.unitCostCents,
          reference: { receiptId: receipt.id },
        },
        tx,
      )

      // Keep ProductVariant.costCents meaning what its comment says — most recent unit
      // cost. It is a reference figure for pricing decisions; margin comes from the
      // per-store weighted average, not from here.
      if (line.unitCostCents !== undefined) {
        await tx.productVariant.update({
          where: { id: line.variantId },
          data: { costCents: line.unitCostCents },
        })
      }
    }

    if (order) await advanceOrder(tx, order, lines)

    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'inventory.receive',
        entityType: 'Receipt',
        entityId: receipt.id,
        before: {},
        after: {
          storeId: input.storeId,
          supplierId: input.supplierId ?? null,
          purchaseOrderId: input.purchaseOrderId ?? null,
          lineCount: lines.length,
          costed: lines.some((l) => l.unitCostCents !== undefined),
          variance: variance.length,
        },
      },
    })

    return receipt.id
  })

  // AFTER the commit, never inside it. An emit from within the transaction would announce a
  // variance that a later rollback erased, and the emitter deliberately cannot fail loudly.
  if (variance.length > 0 && order) {
    emitToAdmin({
      name: 'receipt.variance',
      payload: {
        receiptId,
        storeId: input.storeId,
        storeName: order.store.name,
        supplierName: order.supplier.name,
        purchaseOrderReference: formatReference(order.number),
        lineCount: variance.length,
      },
    })
  }

  return getReceipt(principal, receiptId)
}

/**
 * The open orders a register can receive against, for ONE store.
 *
 * Deliberately COST-FREE for every principal: no `unitCostCents` is even selected, so
 * there is nothing to strip. This is the chooser's payload — the person at the door needs
 * what is outstanding, not what it cost. Store scoping happens at the route via
 * `scopeStoreId`; the storeId arriving here is already authorised.
 */
export async function openOrdersForReceiving(storeId: string): Promise<OpenOrderRow[]> {
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      storeId,
      status: { in: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED] },
    },
    orderBy: { orderedAt: 'desc' },
    select: {
      id: true,
      number: true,
      status: true,
      orderedAt: true,
      expectedAt: true,
      supplier: { select: { id: true, name: true } },
      lines: {
        select: {
          quantityBase: true,
          variant: {
            select: {
              id: true,
              label: true,
              sku: true,
              trackingMode: true,
              product: { select: { name: true } },
            },
          },
        },
      },
      receipts: { select: { lines: { select: { variantId: true, quantityBase: true } } } },
    },
  })

  return orders.map((order) => {
    const received = receivedByVariant(order.receipts)
    return {
      id: order.id,
      reference: formatReference(order.number),
      status: order.status,
      supplierId: order.supplier.id,
      supplierName: order.supplier.name,
      orderedAt: order.orderedAt.toISOString(),
      expectedAt: order.expectedAt?.toISOString() ?? null,
      lines: order.lines.map((line) => {
        const receivedBase = received.get(line.variant.id) ?? 0
        return {
          variantId: line.variant.id,
          productName: line.variant.product.name,
          label: line.variant.label,
          sku: line.variant.sku,
          trackingMode: line.variant.trackingMode,
          orderedBase: line.quantityBase,
          receivedBase,
          outstandingBase: Math.max(0, line.quantityBase - receivedBase),
        }
      }),
    }
  })
}

// --- receiving against a purchase order --------------------------------------------------

type OrderForReceipt = {
  id: string
  number: number | null
  status: string
  storeId: string
  firstReceiptAt: Date | null
  store: { name: string }
  supplier: { name: string }
  lines: Array<{ variantId: string; quantityBase: number; unitCostCents: number | null }>
  receipts: Array<{ lines: Array<{ variantId: string; quantityBase: number }> }>
}

async function loadOrderForReceipt(input: CreateReceiptInput): Promise<OrderForReceipt> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId as string },
    select: {
      id: true,
      number: true,
      status: true,
      storeId: true,
      firstReceiptAt: true,
      store: { select: { name: true } },
      supplier: { select: { name: true } },
      lines: { select: { variantId: true, quantityBase: true, unitCostCents: true } },
      receipts: { select: { lines: { select: { variantId: true, quantityBase: true } } } },
    },
  })
  if (!order) throw new NotFoundError('That purchase order does not exist.')

  if (order.storeId !== input.storeId) {
    // Receiving an order into a store it was not raised for would post the stock somewhere
    // the buyer never intended and quietly corrupt that store's cost basis.
    throw new ConflictError('That order was raised for a different store.')
  }
  if (order.status === PurchaseOrderStatus.DRAFT) {
    throw new ConflictError('That order has not been placed yet.')
  }
  if (
    order.status === PurchaseOrderStatus.CANCELLED ||
    order.status === PurchaseOrderStatus.RECEIVED
  ) {
    throw new ConflictError('That order is closed. Receive this as a standalone delivery.')
  }

  return order as OrderForReceipt
}

/** Fill in each line's cost from the order when the receiver did not type one. */
function withOrderCosts(
  lines: readonly ReceiptLineInput[],
  order: OrderForReceipt,
): ReceiptLineInput[] {
  const byVariant = new Map(order.lines.map((l) => [l.variantId, l.unitCostCents]))
  return lines.map((line) => {
    if (line.unitCostCents !== undefined) return line
    const fromOrder = byVariant.get(line.variantId)
    return fromOrder === null || fromOrder === undefined
      ? line
      : { ...line, unitCostCents: fromOrder }
  })
}

/**
 * What differs between this delivery and the order — on CUMULATIVE totals, not this receipt
 * alone.
 *
 * Two receipts of 8 and 12 against an order for 20 must produce no variance at all: the
 * first is short only in isolation, and judging each receipt on its own would flag both.
 * Only over-delivery and an item that was never ordered are knowable now; a shortfall is not
 * a fact until someone declares the order finished.
 */
function varianceAgainstOrder(
  lines: readonly ReceiptLineInput[],
  order: OrderForReceipt,
): VarianceLine[] {
  const ordered = new Map(order.lines.map((l) => [l.variantId, l.quantityBase]))
  const already = receivedByVariant(order.receipts)

  const out: VarianceLine[] = []
  for (const line of lines) {
    const orderedBase = ordered.get(line.variantId)
    const cumulative = (already.get(line.variantId) ?? 0) + line.quantityBase

    if (orderedBase === undefined) {
      out.push({
        variantId: line.variantId,
        productName: '',
        label: null,
        trackingMode: '',
        orderedBase: null,
        receivedBase: cumulative,
        kind: 'UNEXPECTED',
        differenceBase: line.quantityBase,
      })
      continue
    }

    if (cumulative > orderedBase) {
      out.push({
        variantId: line.variantId,
        productName: '',
        label: null,
        trackingMode: '',
        orderedBase,
        receivedBase: cumulative,
        kind: 'OVER',
        differenceBase: cumulative - orderedBase,
      })
    }
  }
  return out
}

/** Move the order's status and lead-time timestamps on, inside the receipt's transaction. */
async function advanceOrder(
  tx: Prisma.TransactionClient,
  order: OrderForReceipt,
  lines: readonly ReceiptLineInput[],
): Promise<void> {
  const totals = receivedByVariant(order.receipts)
  for (const line of lines) {
    totals.set(line.variantId, (totals.get(line.variantId) ?? 0) + line.quantityBase)
  }

  const complete = order.lines.every((l) => (totals.get(l.variantId) ?? 0) >= l.quantityBase)
  const now = new Date()

  await tx.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: complete ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIALLY_RECEIVED,
      // Time to FIRST delivery is set once and never moved; time to FULL fulfillment is a
      // separate column precisely so a partial that finishes weeks later does not read as a
      // fast lead time.
      ...(order.firstReceiptAt === null ? { firstReceiptAt: now } : {}),
      ...(complete ? { fullyReceivedAt: now } : {}),
    },
  })
}

/** Mark a flagged delivery as reviewed. Admin only — the queue is a cost-bearing surface. */
export async function reviewReceipt(
  principal: Principal,
  id: string,
  userId: string,
): Promise<ReceiptRow> {
  if (!canSeeCost(principal)) throw new ForbiddenError('Only an admin may review a delivery.')

  const receipt = await prisma.receipt.findUnique({
    where: { id },
    select: { id: true, hasVariance: true, reviewedAt: true },
  })
  if (!receipt) throw new NotFoundError('That receipt does not exist.')
  if (!receipt.hasVariance) throw new ConflictError('That delivery has no variance to review.')
  if (receipt.reviewedAt !== null) throw new ConflictError('That delivery is already reviewed.')

  // Both columns together — the CHECK refuses half a review record.
  await prisma.receipt.update({
    where: { id },
    data: { reviewedById: userId, reviewedAt: new Date() },
  })

  return getReceipt(principal, id)
}

/**
 * The ordered-vs-received comparison an admin reads in the review queue.
 *
 * Recomputed on read rather than snapshotted: it is a description of two records that both
 * still exist, and a stored copy would go stale the moment a cost or a later receipt landed.
 */
export async function varianceForReceipt(id: string): Promise<VarianceLine[]> {
  const receipt = await prisma.receipt.findUnique({
    where: { id },
    select: {
      purchaseOrderId: true,
      purchaseOrder: {
        select: {
          lines: { select: { variantId: true, quantityBase: true } },
          receipts: { select: { lines: { select: { variantId: true, quantityBase: true } } } },
        },
      },
    },
  })
  if (!receipt?.purchaseOrder) return []

  const ordered = new Map(receipt.purchaseOrder.lines.map((l) => [l.variantId, l.quantityBase]))
  const received = receivedByVariant(receipt.purchaseOrder.receipts)

  const variantIds = [...new Set([...ordered.keys(), ...received.keys()])]
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, label: true, trackingMode: true, product: { select: { name: true } } },
  })
  const byId = new Map(variants.map((v) => [v.id, v]))

  const out: VarianceLine[] = []
  for (const variantId of variantIds) {
    const orderedBase = ordered.get(variantId) ?? null
    const receivedBase = received.get(variantId) ?? 0
    const variant = byId.get(variantId)
    if (!variant) continue

    const shape = {
      variantId,
      productName: variant.product.name,
      label: variant.label,
      trackingMode: variant.trackingMode,
      orderedBase,
      receivedBase,
    }

    if (orderedBase === null) {
      out.push({ ...shape, kind: 'UNEXPECTED', differenceBase: receivedBase })
    } else if (receivedBase > orderedBase) {
      out.push({ ...shape, kind: 'OVER', differenceBase: receivedBase - orderedBase })
    } else if (receivedBase < orderedBase) {
      out.push({ ...shape, kind: 'SHORT', differenceBase: receivedBase - orderedBase })
    }
  }
  return out
}

async function assertVariantsExist(lines: readonly ReceiptLineInput[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.variantId))]
  const found = await prisma.productVariant.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  if (found.length !== ids.length) {
    throw new NotFoundError('A product on that delivery does not exist.')
  }
}

export interface LineCostInput {
  readonly lineId: string
  readonly unitCostCents: number
}

/**
 * Enter cost on a receipt staff posted without it. Admin only.
 *
 * The value lands on the store's CURRENT basis, not on the pool as it stood when the
 * delivery arrived. If some of that stock has already sold, the cost attaches to what
 * remains and the average is an approximation.
 *
 * The alternative — restating the COGS of lines that already sold — would rewrite figures
 * a sales receipt has already reported to a customer, which the house rules forbid outright.
 * An approximation that is documented beats a silent revision of history.
 */
export async function setLineCosts(
  principal: Principal,
  receiptId: string,
  costs: readonly LineCostInput[],
  userId: string,
): Promise<ReceiptRow> {
  if (!canSeeCost(principal)) throw new ForbiddenError('Only an admin may enter cost.')
  if (costs.length === 0) throw new ConflictError('No costs were supplied.')

  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: {
      id: true,
      storeId: true,
      lines: {
        select: {
          id: true,
          variantId: true,
          quantityBase: true,
          unitCostCents: true,
          variant: { select: { trackingMode: true } },
        },
      },
    },
  })
  if (!receipt) throw new NotFoundError('That receipt does not exist.')

  const byId = new Map(receipt.lines.map((l) => [l.id, l]))
  for (const cost of costs) {
    if (!byId.has(cost.lineId)) {
      throw new NotFoundError('That line is not on this receipt.')
    }
    if (cost.unitCostCents < 0) {
      throw new ConflictError('A unit cost cannot be negative.')
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const cost of costs) {
      const line = byId.get(cost.lineId)!

      const previousValue =
        line.unitCostCents === null
          ? 0
          : receiptLineValueCents(
              line.variant.trackingMode as TrackingMode,
              line.quantityBase,
              line.unitCostCents,
            )
      const nextValue = receiptLineValueCents(
        line.variant.trackingMode as TrackingMode,
        line.quantityBase,
        cost.unitCostCents,
      )
      const delta = nextValue - previousValue

      await tx.receiptLine.update({
        where: { id: line.id },
        data: { unitCostCents: cost.unitCostCents },
      })

      await tx.productVariant.update({
        where: { id: line.variantId },
        data: { costCents: cost.unitCostCents },
      })

      if (delta === 0) continue

      // Move the basis without touching the quantity, so this cannot go through
      // applyMovement — that function's contract is a non-zero stock delta. Locking the
      // row first keeps it serialised against a concurrent sale of the same variant.
      const locked = await tx.$queryRaw<Array<{ costBasisCents: number | null }>>`
        SELECT "costBasisCents" FROM "StockLevel"
         WHERE "storeId" = ${receipt.storeId} AND "variantId" = ${line.variantId}
         FOR UPDATE
      `
      if (locked.length === 0) continue

      const next = Math.max(0, (locked[0]?.costBasisCents ?? 0) + delta)
      await tx.stockLevel.update({
        where: {
          storeId_variantId: { storeId: receipt.storeId, variantId: line.variantId },
        },
        data: { costBasisCents: next },
      })
    }

    await tx.auditLog.create({
      data: {
        userId,
        action: 'inventory.cost',
        entityType: 'Receipt',
        entityId: receipt.id,
        before: {
          lines: receipt.lines.map((l) => ({ id: l.id, unitCostCents: l.unitCostCents })),
        },
        after: { lines: costs.map((c) => ({ id: c.lineId, unitCostCents: c.unitCostCents })) },
      },
    })
  })

  return getReceipt(principal, receiptId)
}

// --- quick product creation --------------------------------------------------------------

export interface QuickProductInput {
  readonly name: string
  readonly categoryId: string
  readonly sku: string
  readonly barcode?: string | undefined
}

/**
 * Create a catalog entry from the loading dock.
 *
 * Kasan chose to let staff do this — a rep turning up with a SKU nobody has entered should
 * not stop the delivery. But pricing is an admin capability and the `EACH` CHECK constraint
 * requires a non-null price, so the honest resolution is that the variant arrives INACTIVE
 * at zero price: stock posts against it immediately and it is invisible to the catalog and
 * unsellable at the register until an admin prices and activates it.
 *
 * EACH only. A WEIGHT variant requires a price group by CHECK constraint, and choosing the
 * price group for a new strain is a merchandising decision, not a receiving one.
 */
export async function quickCreateProduct(input: QuickProductInput) {
  const name = input.name.trim()
  if (name.length === 0) throw new ConflictError('A product needs a name.')

  const sku = input.sku.trim()
  if (sku.length === 0) throw new ConflictError('A product needs a SKU.')

  const category = await prisma.category.findUnique({
    where: { id: input.categoryId },
    select: { id: true },
  })
  if (!category) throw new NotFoundError('That category does not exist.')

  const clash = await prisma.productVariant.findUnique({ where: { sku }, select: { id: true } })
  if (clash) throw new ConflictError('That SKU already exists in the catalog.')

  if (input.barcode) {
    const barcodeClash = await prisma.productVariant.findUnique({
      where: { barcode: input.barcode },
      select: { id: true },
    })
    if (barcodeClash) throw new ConflictError('That barcode already exists in the catalog.')
  }

  const slug = await uniqueProductSlug(name)

  const product = await prisma.product.create({
    data: {
      name,
      slug,
      categoryId: input.categoryId,
      active: false,
      variants: {
        create: {
          sku,
          ...(input.barcode ? { barcode: input.barcode } : {}),
          trackingMode: 'EACH',
          priceCents: 0,
          active: false,
        },
      },
    },
    select: {
      id: true,
      name: true,
      variants: { select: { id: true, sku: true } },
    },
  })

  return {
    productId: product.id,
    name: product.name,
    variantId: product.variants[0]!.id,
    sku: product.variants[0]!.sku,
    /** Surfaced so the register can say so plainly rather than implying it is sellable. */
    needsAdminReview: true,
  }
}

