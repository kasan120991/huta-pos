import { PurchaseOrderStatus, TrackingMode, receiptLineValueCents } from '@huta/shared'
import type {
  PurchaseOrderDraftInput,
  PurchaseOrderInput,
  PurchaseOrderRow,
} from '@huta/shared/schemas'

import { canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError } from '../errors/index.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * Purchase orders — an INTERNAL order log, not a document sent to anyone.
 *
 * It exists so lead time is measurable: nothing else in the schema knows when an order was
 * placed. `firstReceiptAt` and `fullyReceivedAt` are tracked separately because a partial
 * that finishes three weeks later is not a two-day lead time.
 *
 * Admin-only throughout — `purchaseOrder.manage` is not in `STAFF_CAPABILITIES`.
 */

type Db = Prisma.TransactionClient

/** The counter name used for per-store order numbers. */
const PO_COUNTER = 'purchaseOrder'

// --- reads -------------------------------------------------------------------------------

function lineSelect(principal: Principal) {
  return {
    id: true,
    quantityBase: true,
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

function orderSelect(principal: Principal) {
  return {
    id: true,
    number: true,
    status: true,
    storeId: true,
    supplierId: true,
    orderedById: true,
    orderedAt: true,
    expectedAt: true,
    firstReceiptAt: true,
    fullyReceivedAt: true,
    cancelledAt: true,
    notes: true,
    store: { select: { name: true } },
    supplier: { select: { name: true } },
    orderedBy: { select: { firstName: true, lastName: true } },
    lines: { select: lineSelect(principal), orderBy: { id: 'asc' as const } },
    receipts: {
      select: {
        id: true,
        lines: { select: { variantId: true, quantityBase: true } },
      },
    },
  }
}

type OrderQueryRow = {
  id: string
  number: number | null
  status: string
  storeId: string
  supplierId: string
  orderedById: string
  orderedAt: Date
  expectedAt: Date | null
  firstReceiptAt: Date | null
  fullyReceivedAt: Date | null
  cancelledAt: Date | null
  notes: string | null
  store: { name: string }
  supplier: { name: string }
  orderedBy: { firstName: string; lastName: string }
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
  receipts: Array<{ id: string; lines: Array<{ variantId: string; quantityBase: number }> }>
}

/** `PO-0007`, or a plain word while the order has no number yet. */
export function formatReference(number: number | null): string {
  return number === null ? 'Draft' : `PO-${String(number).padStart(4, '0')}`
}

/**
 * Received quantity per variant, summed across every receipt on the order.
 *
 * DERIVED, never stored. `PurchaseOrderLine` deliberately has no `quantityReceivedBase`: a
 * stored column would be a second source of truth and would drift the first time a receipt
 * was corrected.
 */
export function receivedByVariant(
  receipts: ReadonlyArray<{ lines: ReadonlyArray<{ variantId: string; quantityBase: number }> }>,
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const receipt of receipts) {
    for (const line of receipt.lines) {
      totals.set(line.variantId, (totals.get(line.variantId) ?? 0) + line.quantityBase)
    }
  }
  return totals
}

/** Whole days between two instants, floored — a delivery 30 hours later took one day. */
function daysBetween(from: Date, to: Date | null): number | null {
  if (to === null) return null
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

function toRow(principal: Principal, row: OrderQueryRow): PurchaseOrderRow {
  const showCost = canSeeCost(principal)
  const received = receivedByVariant(row.receipts)

  const lines = row.lines.map((line) => {
    const receivedBase = received.get(line.variant.id) ?? 0
    return {
      id: line.id,
      variantId: line.variant.id,
      productName: line.variant.product.name,
      label: line.variant.label,
      sku: line.variant.sku,
      trackingMode: line.variant.trackingMode,
      quantityBase: line.quantityBase,
      receivedBase,
      varianceBase: receivedBase - line.quantityBase,
      ...(showCost ? { unitCostCents: line.unitCostCents ?? null } : {}),
    }
  })

  const terminal =
    row.status === PurchaseOrderStatus.RECEIVED || row.status === PurchaseOrderStatus.CANCELLED

  return {
    id: row.id,
    number: row.number,
    reference: formatReference(row.number),
    status: row.status,
    storeId: row.storeId,
    storeName: row.store.name,
    supplierId: row.supplierId,
    supplierName: row.supplier.name,
    orderedById: row.orderedById,
    orderedByName: `${row.orderedBy.firstName} ${row.orderedBy.lastName}`.trim(),
    orderedAt: row.orderedAt.toISOString(),
    expectedAt: row.expectedAt?.toISOString() ?? null,
    firstReceiptAt: row.firstReceiptAt?.toISOString() ?? null,
    fullyReceivedAt: row.fullyReceivedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    notes: row.notes,
    lines,
    receiptCount: row.receipts.length,
    daysToFirstReceipt: daysBetween(row.orderedAt, row.firstReceiptAt),
    daysToFullReceipt: daysBetween(row.orderedAt, row.fullyReceivedAt),
    // An order with no receipt and no cancellation is OUTSTANDING — counted separately
    // rather than folded into any average, which would quietly flatter a slow supplier.
    outstanding: row.status !== PurchaseOrderStatus.DRAFT && !terminal,
    ...(showCost ? { totalCostCents: totalCostOf(row) } : {}),
  }
}

function totalCostOf(row: OrderQueryRow): number | null {
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

export interface OrderFilter {
  readonly storeId?: string | undefined
  readonly supplierId?: string | undefined
  readonly outstandingOnly?: boolean | undefined
}

export async function listOrders(
  principal: Principal,
  filter: OrderFilter = {},
): Promise<PurchaseOrderRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: {
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(filter.outstandingOnly
        ? {
            status: {
              in: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED],
            },
          }
        : {}),
    },
    select: orderSelect(principal),
    orderBy: [{ orderedAt: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  })

  return rows.map((row) => toRow(principal, row as unknown as OrderQueryRow))
}

export async function getOrder(principal: Principal, id: string): Promise<PurchaseOrderRow> {
  const row = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: orderSelect(principal),
  })
  if (!row) throw new NotFoundError('That purchase order does not exist.')
  return toRow(principal, row as unknown as OrderQueryRow)
}

// --- writes ------------------------------------------------------------------------------

export interface CreateOrderInput extends PurchaseOrderInput {
  readonly storeId: string
  readonly userId: string
}

export async function createOrder(
  principal: Principal,
  input: CreateOrderInput,
): Promise<PurchaseOrderRow> {
  if (input.lines.length === 0) throw new ConflictError('An order needs at least one line.')
  await assertLinesValid(input.lines)

  const supplier = await prisma.supplier.findUnique({
    where: { id: input.supplierId },
    select: { id: true, active: true },
  })
  if (!supplier) throw new NotFoundError('That supplier does not exist.')
  if (!supplier.active) throw new ConflictError('That supplier is no longer active.')

  const created = await prisma.purchaseOrder.create({
    data: {
      supplierId: input.supplierId,
      storeId: input.storeId,
      orderedById: input.userId,
      status: PurchaseOrderStatus.DRAFT,
      // A draft has no meaningful order date yet; `place()` overwrites it. The column is
      // non-null, so it needs a value now.
      orderedAt: new Date(),
      ...(input.expectedAt ? { expectedAt: new Date(input.expectedAt) } : {}),
      ...(input.notes ? { notes: input.notes.trim() } : {}),
      lines: {
        create: input.lines.map((line) => ({
          variantId: line.variantId,
          quantityBase: line.quantityBase,
          ...(line.unitCostCents === undefined ? {} : { unitCostCents: line.unitCostCents }),
        })),
      },
    },
    select: { id: true },
  })

  return getOrder(principal, created.id)
}

/**
 * Replace a draft's lines.
 *
 * Only a DRAFT is editable. Once placed, the lines ARE the record of what was asked for —
 * editing them afterwards would make every variance calculation retroactively agree with
 * whatever turned up, which is the opposite of the point.
 */
export async function updateDraft(
  principal: Principal,
  id: string,
  input: PurchaseOrderDraftInput,
): Promise<PurchaseOrderRow> {
  const existing = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: { id: true, status: true },
  })
  if (!existing) throw new NotFoundError('That purchase order does not exist.')
  if (existing.status !== PurchaseOrderStatus.DRAFT) {
    throw new ConflictError('Only a draft order can be edited. Cancel it and raise a new one.')
  }

  if (input.lines !== undefined) {
    if (input.lines.length === 0) throw new ConflictError('An order needs at least one line.')
    await assertLinesValid(input.lines)
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(input.supplierId === undefined ? {} : { supplierId: input.supplierId }),
        ...(input.expectedAt === undefined
          ? {}
          : { expectedAt: input.expectedAt ? new Date(input.expectedAt) : null }),
        ...(input.notes === undefined ? {} : { notes: input.notes?.trim() || null }),
      },
    })

    if (input.lines !== undefined) {
      await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } })
      for (const line of input.lines) {
        await tx.purchaseOrderLine.create({
          data: {
            purchaseOrderId: id,
            variantId: line.variantId,
            quantityBase: line.quantityBase,
            ...(line.unitCostCents === undefined ? {} : { unitCostCents: line.unitCostCents }),
          },
        })
      }
    }
  })

  return getOrder(principal, id)
}

/**
 * Place a draft: allocate its number and start the clock.
 *
 * The number comes from the store's `StoreCounter` row under `SELECT … FOR UPDATE`, inside
 * the same transaction that flips the status. That lock is what makes concurrent placement
 * safe — two admins placing at once would otherwise read the same counter and both claim the
 * same number, and the unique index would reject one of them with a raw constraint error.
 */
export async function placeOrder(
  principal: Principal,
  id: string,
  userId: string,
): Promise<PurchaseOrderRow> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true, storeId: true, lines: { select: { id: true } } },
    })
    if (!order) throw new NotFoundError('That purchase order does not exist.')
    if (order.status !== PurchaseOrderStatus.DRAFT) {
      throw new ConflictError('That order has already been placed.')
    }
    if (order.lines.length === 0) throw new ConflictError('An order needs at least one line.')

    const number = await nextOrderNumber(tx, order.storeId)

    await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: PurchaseOrderStatus.ORDERED,
        number,
        orderedAt: new Date(),
        orderedById: userId,
      },
    })
  })

  return getOrder(principal, id)
}

/**
 * The next per-store order number.
 *
 * Ensure-then-lock, because `FOR UPDATE` cannot lock a row that does not exist yet and a
 * store that has never ordered has no counter row.
 *
 * The ensure step is `createMany({ skipDuplicates: true })` — an `INSERT … ON CONFLICT DO
 * NOTHING` — and NOT an `upsert`. An upsert is two statements: two transactions placing an
 * order at the same moment both find no row, both try to insert, and one dies on the unique
 * constraint. `ON CONFLICT DO NOTHING` instead waits for the other transaction and then
 * skips, after which the `FOR UPDATE` below serialises the increment properly. A test places
 * five orders concurrently and asserts the numbers come out 1..5.
 */
async function nextOrderNumber(tx: Db, storeId: string): Promise<number> {
  await tx.storeCounter.createMany({
    data: [{ storeId, name: PO_COUNTER, value: 0 }],
    skipDuplicates: true,
  })

  const locked = await tx.$queryRaw<Array<{ value: number }>>`
    SELECT "value" FROM "StoreCounter"
     WHERE "storeId" = ${storeId} AND "name" = ${PO_COUNTER}
     FOR UPDATE
  `
  const next = (locked[0]?.value ?? 0) + 1

  await tx.storeCounter.update({
    where: { storeId_name: { storeId, name: PO_COUNTER } },
    data: { value: next },
  })

  return next
}

export async function cancelOrder(
  principal: Principal,
  id: string,
): Promise<PurchaseOrderRow> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: { id: true, status: true },
  })
  if (!order) throw new NotFoundError('That purchase order does not exist.')
  if (
    order.status === PurchaseOrderStatus.RECEIVED ||
    order.status === PurchaseOrderStatus.CANCELLED
  ) {
    throw new ConflictError('That order is already closed.')
  }

  await prisma.purchaseOrder.update({
    where: { id },
    data: { status: PurchaseOrderStatus.CANCELLED, cancelledAt: new Date() },
  })

  return getOrder(principal, id)
}

/**
 * Delete a draft outright — discarded, or never placed at all.
 *
 * The append-only rule this bends, and why it holds anyway: the house rules forbid deleting a sale,
 * payment, refund or inventory movement, because those are the audit trail. A draft that was
 * never placed is none of those — it has no number, it was never sent to anyone, no stock
 * moved, and nothing can reference it. Leaving it in the list is just litter in a queue that
 * is supposed to be work.
 *
 * Accepts DRAFT as well as CANCELLED so discarding is ONE step rather than cancel-then-delete:
 * a tombstone for something nobody ever saw is the litter, not the cure. Kasan's call,
 * 2026-08-24.
 *
 * ⚠️ Two guards, and both are load-bearing:
 *
 *  * **`number` must be NULL.** A cancelled order that WAS placed burned a per-store number,
 *    and the sequence is something a person reconciles against. Deleting it punches a hole in
 *    that sequence with no record of what filled it — which is precisely why numbering happens
 *    at placement and not at creation.
 *  * **No receipts.** `Receipt.purchaseOrderId` is `ON DELETE SET NULL`, so the database would
 *    silently DETACH a delivery rather than refuse the delete. A draft cannot have receipts,
 *    so this can only fire if something is already wrong — which is exactly when a silent
 *    detach would be worst.
 *
 * The `PurchaseOrderLine` rows go with it by cascade. The AuditLog row is written FIRST and
 * deliberately carries the whole order in `before`: once the row is gone, the log is the only
 * evidence it ever existed.
 */
export async function deleteCancelledDraft(principal: Principal, id: string): Promise<void> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      storeId: true,
      supplierId: true,
      notes: true,
      createdAt: true,
      _count: { select: { receipts: true } },
      lines: { select: { variantId: true, quantityBase: true } },
    },
  })
  if (!order) throw new NotFoundError('That purchase order does not exist.')

  if (
    order.status !== PurchaseOrderStatus.DRAFT &&
    order.status !== PurchaseOrderStatus.CANCELLED
  ) {
    throw new ConflictError('Only a draft can be deleted.')
  }
  if (order.number !== null) {
    throw new ConflictError(
      'That order was placed, so it keeps its number and stays on the record. Only a draft discarded before it was placed can be deleted.',
    )
  }
  if (order._count.receipts > 0) {
    throw new ConflictError('That order has deliveries against it and cannot be deleted.')
  }

  await prisma.auditLog.create({
    data: {
      userId: principal.userId,
      action: 'purchaseOrder.delete',
      entityType: 'PurchaseOrder',
      entityId: order.id,
      before: {
        storeId: order.storeId,
        supplierId: order.supplierId,
        notes: order.notes,
        createdAt: order.createdAt.toISOString(),
        lines: order.lines.map((l) => ({ variantId: l.variantId, quantityBase: l.quantityBase })),
      },
      after: {},
    },
  })

  await prisma.purchaseOrder.delete({ where: { id } })
}

/**
 * Close an order that never filled.
 *
 * This is the ONE place a shortfall becomes a variance. While an order is open, a short
 * delivery is simply `PARTIALLY_RECEIVED` — flagging it would fire on every normal split
 * delivery and fill the review queue with entries an admin dismisses without reading. It is
 * only when someone declares the order finished that "we never got the rest" becomes a fact
 * worth recording.
 *
 * The flag lands on the order's most recent receipt, which is the one an admin will look at.
 */
export async function closeShort(
  principal: Principal,
  id: string,
): Promise<PurchaseOrderRow> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      lines: { select: { variantId: true, quantityBase: true } },
      receipts: {
        select: { id: true, receivedAt: true, lines: { select: { variantId: true, quantityBase: true } } },
        orderBy: { receivedAt: 'desc' },
      },
    },
  })
  if (!order) throw new NotFoundError('That purchase order does not exist.')
  if (order.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED) {
    throw new ConflictError('Only a partially received order can be closed short.')
  }

  const received = receivedByVariant(order.receipts)
  const short = order.lines.some((l) => (received.get(l.variantId) ?? 0) < l.quantityBase)
  if (!short) throw new ConflictError('That order is not short — nothing to close.')

  const latestReceiptId = order.receipts[0]?.id ?? null
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: PurchaseOrderStatus.RECEIVED,
        fullyReceivedAt: now,
        // The CHECK requires firstReceiptAt whenever fullyReceivedAt is set, and a
        // PARTIALLY_RECEIVED order always has one.
      },
    })

    // The DB CHECK refuses hasVariance on a receipt with no order, which cannot happen here
    // — every receipt reached through `order.receipts` is PO-linked by construction.
    if (latestReceiptId) {
      await tx.receipt.update({ where: { id: latestReceiptId }, data: { hasVariance: true } })
    }
  })

  return getOrder(principal, id)
}

async function assertLinesValid(
  lines: ReadonlyArray<{ variantId: string; quantityBase: number }>,
): Promise<void> {
  for (const line of lines) {
    if (line.quantityBase <= 0) {
      throw new ConflictError('An order line needs a quantity greater than zero.')
    }
  }

  const ids = [...new Set(lines.map((l) => l.variantId))]
  if (ids.length !== lines.length) {
    // The unique index would reject it, but a named reason beats a constraint error.
    throw new ConflictError('The same product appears twice on that order.')
  }

  const found = await prisma.productVariant.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  if (found.length !== ids.length) {
    throw new NotFoundError('A product on that order does not exist.')
  }
}
