/**
 * Wire shapes for suppliers and receiving.
 *
 * Pure TypeScript interfaces, no Zod — the same split as `catalog.ts` and `pricing.ts`.
 * Request schemas stay inline in the routes file unless both client and server validate
 * the same form, which none of these do.
 *
 * SOME FIELDS ARE OPTIONAL RATHER THAN NULLABLE, AND THE DIFFERENCE IS LOAD-BEARING:
 * `unitCostCents` and the commercial-terms fields on a supplier are OMITTED entirely for a
 * principal without the capability to see them. The server decides at the Prisma `select`,
 * so the key is absent rather than null. A client that treats them as always-present is
 * making an assumption the API deliberately does not honour.
 */

// --- suppliers -------------------------------------------------------------------------

export interface SupplierRow {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly contactName: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly website: string | null
  readonly addressLine1: string | null
  readonly addressLine2: string | null
  readonly city: string | null
  readonly state: string | null
  readonly postalCode: string | null
  readonly licenseNumber: string | null
  readonly active: boolean
  /** Products naming this supplier as primary. */
  readonly productCount: number

  /**
   * Commercial terms. Present ONLY for a principal that may see them — the permission matrix grants
   * staff "contact info only" on supplier records.
   */
  readonly accountNumber?: string | null
  readonly paymentTerms?: string | null
  readonly minimumOrderCents?: number | null
  readonly notes?: string | null
}

/**
 * `| undefined` is explicit on every optional field because the workspace compiles with
 * `exactOptionalPropertyTypes`. Zod's `.nullish()` yields `T | null | undefined`, and
 * without the third member a parsed body does not satisfy this type.
 */
export interface SupplierInput {
  readonly name: string
  readonly contactName?: string | null | undefined
  readonly phone?: string | null | undefined
  readonly email?: string | null | undefined
  readonly website?: string | null | undefined
  readonly addressLine1?: string | null | undefined
  readonly addressLine2?: string | null | undefined
  readonly city?: string | null | undefined
  readonly state?: string | null | undefined
  readonly postalCode?: string | null | undefined
  readonly accountNumber?: string | null | undefined
  readonly paymentTerms?: string | null | undefined
  readonly minimumOrderCents?: number | null | undefined
  readonly licenseNumber?: string | null | undefined
  readonly notes?: string | null | undefined
  readonly active?: boolean | undefined
}

/**
 * Operational activity for one supplier. ADMIN-ONLY, gated on `supplier.report` — the house
 * permission table puts lead-time reporting on the admin side of the line.
 *
 * Deliberately carries NO money. Spend, margin, sell-through and inventory valuation belong to
 * the Phase 12 supplier health dashboard; the moment they appear here this stops being a
 * supplier record and becomes the reporting phase, which is the same line that keeps
 * `/admin/sales` a history rather than a report.
 *
 * The sample counts are part of the answer, not decoration. An average over two orders and an
 * average over two hundred are different claims, and the screen has to be able to say which
 * one it is showing.
 */
export interface SupplierActivity {
  readonly supplierId: string
  /** Orders past DRAFT. A draft has no number and was never placed with anyone. */
  readonly ordersPlaced: number
  /** Placed, neither fully received nor cancelled. Counted, NEVER folded into an average. */
  readonly outstandingCount: number
  readonly cancelledCount: number
  readonly receiptCount: number
  readonly lastReceivedAt: string | null
  /** Whole days, floored, from `orderedAt` to the first delivery against the order. */
  readonly avgDaysToFirstReceipt: number | null
  /** How many orders that average is over — zero means it is null, not zero days. */
  readonly firstReceiptSample: number
  /** Ordered to fully received. A partial that finishes three weeks later is not a fast order. */
  readonly avgDaysToFullReceipt: number | null
  readonly fullReceiptSample: number
}

// --- receiving -------------------------------------------------------------------------

export interface ReceiptLineRow {
  readonly id: string
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly sku: string
  readonly trackingMode: string
  readonly quantityBase: number
  /** ADMIN-ONLY. Per item for EACH, per GRAM for WEIGHT. Absent for staff. */
  readonly unitCostCents?: number | null
}

export interface ReceiptRow {
  readonly id: string
  readonly storeId: string
  readonly storeName: string
  readonly supplierId: string | null
  readonly supplierName: string | null
  readonly receivedById: string
  readonly receivedByName: string
  readonly receivedAt: string
  readonly invoiceNumber: string | null
  readonly notes: string | null
  readonly hasVariance: boolean
  readonly reviewedAt: string | null
  readonly reviewedByName: string | null
  readonly purchaseOrderId: string | null
  /** `PO-0007`, or null for a standalone delivery. */
  readonly purchaseOrderReference: string | null
  readonly lines: readonly ReceiptLineRow[]
  /**
   * Lines with no cost recorded. Visible to admins as the costing queue; always 0 for a
   * staff principal, who cannot see cost and so cannot see its absence either.
   */
  readonly uncostedLineCount?: number
  /** ADMIN-ONLY. Total value this delivery added to the cost basis. */
  readonly totalCostCents?: number | null
}

export interface ReceiptLineInput {
  readonly variantId: string
  readonly quantityBase: number
  /** ADMIN-ONLY on the way in. A staff principal sending this is refused, not ignored. */
  readonly unitCostCents?: number | undefined
}

export interface ReceiptInput {
  readonly storeId?: string | undefined
  readonly supplierId?: string | null | undefined
  readonly purchaseOrderId?: string | null | undefined
  readonly invoiceNumber?: string | null | undefined
  readonly notes?: string | null | undefined
  readonly lines: readonly ReceiptLineInput[]
}

// --- purchase orders ---------------------------------------------------------------------

/**
 * One line of an order, with what has actually turned up against it.
 *
 * `receivedBase` is DERIVED — summed from every ReceiptLine across the order's receipts, not
 * stored on the line. A stored column would be a second source of truth and would drift the
 * first time a receipt was corrected.
 */
export interface PurchaseOrderLineRow {
  readonly id: string
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly sku: string
  readonly trackingMode: string
  readonly quantityBase: number
  readonly receivedBase: number
  /** Negative when short, positive when over. Zero once the line is exactly satisfied. */
  readonly varianceBase: number
  /** ADMIN-ONLY. Per item for EACH, per GRAM for WEIGHT. */
  readonly unitCostCents?: number | null
}

export interface PurchaseOrderRow {
  readonly id: string
  /** Null while the order is still a DRAFT — a number is allocated when it is placed. */
  readonly number: number | null
  /** `PO-0007`, or "Draft" when there is no number yet. Formatted once, on the server. */
  readonly reference: string
  readonly status: string
  readonly storeId: string
  readonly storeName: string
  readonly supplierId: string
  readonly supplierName: string
  readonly orderedById: string
  readonly orderedByName: string
  readonly orderedAt: string
  readonly expectedAt: string | null
  readonly firstReceiptAt: string | null
  readonly fullyReceivedAt: string | null
  readonly cancelledAt: string | null
  readonly notes: string | null
  readonly lines: readonly PurchaseOrderLineRow[]
  readonly receiptCount: number
  /**
   * Whole days from `orderedAt` to the FIRST delivery, and to full fulfillment. Both, because
   * a partial that finishes three weeks later is not a two-day lead time.
   */
  readonly daysToFirstReceipt: number | null
  readonly daysToFullReceipt: number | null
  /** True while the order is placed, not cancelled, and not yet fully received. */
  readonly outstanding: boolean
  /** ADMIN-ONLY. What the order was worth at the costs entered on it. */
  readonly totalCostCents?: number | null
}

export interface PurchaseOrderLineInput {
  readonly variantId: string
  readonly quantityBase: number
  readonly unitCostCents?: number | undefined
}

export interface PurchaseOrderInput {
  readonly storeId?: string | undefined
  readonly supplierId: string
  readonly expectedAt?: string | null | undefined
  readonly notes?: string | null | undefined
  readonly lines: readonly PurchaseOrderLineInput[]
}

/**
 * A partial edit of a draft. Spelled out rather than `Partial<PurchaseOrderInput>` because
 * under `exactOptionalPropertyTypes` the mapped type omits the `| undefined` that a parsed
 * Zod `.partial()` body actually carries.
 */
export interface PurchaseOrderDraftInput {
  readonly supplierId?: string | undefined
  readonly expectedAt?: string | null | undefined
  readonly notes?: string | null | undefined
  readonly lines?: readonly PurchaseOrderLineInput[] | undefined
}

/** One line of the ordered-vs-received comparison shown in the review queue. */
export interface VarianceLine {
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly trackingMode: string
  /** Null when the variant was not on the order at all. */
  readonly orderedBase: number | null
  readonly receivedBase: number
  readonly kind: 'OVER' | 'SHORT' | 'UNEXPECTED'
  readonly differenceBase: number
}

// --- receiving against a purchase order ---------------------------------------------------

/**
 * An open order the register can receive against. Deliberately COST-FREE for every
 * principal — this payload exists for the person at the door, and the house rule is explicit
 * that staff never see cost. The admin's costed view of the same order lives on
 * /purchase-orders.
 */
export interface OpenOrderLine {
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly sku: string
  readonly trackingMode: string
  readonly orderedBase: number
  readonly receivedBase: number
  /** ordered − received, floored at zero — an over-delivered line has nothing outstanding. */
  readonly outstandingBase: number
}

export interface OpenOrderRow {
  readonly id: string
  /** "PO-0003". */
  readonly reference: string
  readonly status: string
  readonly supplierId: string
  readonly supplierName: string
  readonly orderedAt: string
  readonly expectedAt: string | null
  readonly lines: readonly OpenOrderLine[]
}

// --- the movement ledger -----------------------------------------------------------------

export interface MovementRow {
  readonly id: string
  readonly type: string
  readonly quantityBase: number
  readonly balanceAfterBase: number
  readonly reasonCode: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly storeId: string
  readonly storeName: string
  readonly userName: string | null
  /** ADMIN-ONLY. */
  readonly unitCostCents?: number | null
  readonly costBasisAfterCents?: number | null
}

// --- weight reconciliation ---------------------------------------------------------------

export interface ReconcileRow {
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly sku: string
  readonly onRecordBase: number
  /** ADMIN-ONLY, and this screen is admin-only, but gated the same way regardless. */
  readonly avgUnitCostCents?: number | null
}

export interface ReconcileCountInput {
  readonly variantId: string
  /** Base units. A variant the admin did not count is ABSENT, never sent as 0. */
  readonly countedBase: number
}

export interface ReconcileResultLine {
  readonly variantId: string
  readonly productName: string
  readonly deltaBase: number
  readonly movementType: string
  /** What the write-off was worth at the store's weighted-average cost. */
  readonly valueCents: number | null
}

export interface ReconcileResult {
  readonly storeId: string
  readonly storeName: string
  readonly lines: readonly ReconcileResultLine[]
  readonly totalDeltaBase: number
  readonly totalValueCents: number | null
}

/** Cumulative weight variance for one variant, per store. */
export interface WeightVarianceRow {
  readonly storeId: string
  readonly storeName: string
  readonly receivedBase: number
  readonly lostBase: number
  /** Basis points of received weight lost. Null when nothing was received in the window. */
  readonly lossRateBps: number | null
}
