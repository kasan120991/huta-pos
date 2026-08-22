import type { TrackingMode, TransferStatus } from '../enums.js'

/**
 * Transfers wire types — Phase 10.
 *
 * The lifecycle is PENDING → ACCEPTED → IN_TRANSIT → RECEIVED, with DECLINED and
 * CANCELLED as exits. Between ship and receive the stock belongs to NEITHER store's
 * sellable count — the source relieved it at ship, the destination gains it at receive.
 *
 * `shippedCostCents` is `?: number | null` — OPTIONAL, not nullable-only. It is the
 * value the SOURCE's weighted-average basis relieved at ship time (null when the pool
 * was uncosted), and the server omits the key entirely for a principal without
 * `cost.view`. Everything else on a line is visible to anyone who can see the transfer.
 */

// --- rows --------------------------------------------------------------------------------

export interface TransferLineRow {
  readonly id: string
  readonly variantId: string
  readonly productName: string
  readonly label: string | null
  readonly sku: string
  readonly trackingMode: TrackingMode
  readonly requestedBase: number
  /** Null until the source acts on the request. Zero is a declined line. */
  readonly approvedBase: number | null
  /** Null until the destination confirms. Below approved = an in-transit loss. */
  readonly receivedBase: number | null
  /** ADMIN-ONLY. What the source's basis relieved at ship; null = uncosted pool. */
  readonly shippedCostCents?: number | null
}

export interface TransferRow {
  readonly id: string
  readonly status: TransferStatus
  readonly requestingStoreId: string
  readonly requestingStoreName: string
  readonly sourceStoreId: string
  readonly sourceStoreName: string
  readonly requestedByName: string
  readonly acceptedByName: string | null
  readonly shippedByName: string | null
  readonly receivedByName: string | null
  readonly note: string | null
  /** Why the source declined, or why the requester cancelled. */
  readonly reason: string | null
  readonly createdAt: string
  readonly acceptedAt: string | null
  readonly shippedAt: string | null
  readonly receivedAt: string | null
  readonly lines: readonly TransferLineRow[]
}

/**
 * On hand at the SOURCE store, per line of one transfer.
 *
 * Deliberately a SEPARATE read rather than a field on `TransferLineRow`. A transfer row is
 * a historical record — a RECEIVED one from last week carrying today's shelf count would be
 * a live number wearing an archive's clothes — and `listTransfers` returns up to 200 rows,
 * so joining stock onto every line of every list call would buy nothing the list renders.
 *
 * Carries no cost key by construction: only `quantityBase` is ever selected.
 */
export interface TransferAvailabilityRow {
  readonly variantId: string
  /** Base units at the source store: items for EACH, milligrams for WEIGHT. */
  readonly quantityBase: number
}

// --- inputs ------------------------------------------------------------------------------

/**
 * `| undefined` is explicit on optional fields because the workspace compiles with
 * `exactOptionalPropertyTypes` — same convention as `receiving.ts`.
 */
export interface TransferLineInput {
  readonly variantId: string
  readonly quantityBase: number
}

export interface TransferCreateInput {
  /** Where the stock should come FROM. The requesting store is the principal's own. */
  readonly sourceStoreId: string
  /** Required for an admin (no home store); staff omit it and act at their own store. */
  readonly requestingStoreId?: string | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly TransferLineInput[]
}

export interface TransferAcceptLineInput {
  readonly lineId: string
  /** Base units the source will actually send. Zero declines the line. */
  readonly approvedBase: number
}

export interface TransferAcceptInput {
  /** Lines omitted here are approved at their requested quantity. */
  readonly lines?: readonly TransferAcceptLineInput[] | undefined
}

export interface TransferDeclineInput {
  readonly reason: string
}

export interface TransferReceiveLineInput {
  readonly lineId: string
  /** 0 ≤ received ≤ approved. Below approved records an in-transit loss on the line. */
  readonly receivedBase: number
}

export interface TransferReceiveInput {
  /** Lines omitted here are received in full at their approved quantity. */
  readonly lines?: readonly TransferReceiveLineInput[] | undefined
}

export interface TransferCancelInput {
  readonly reason?: string | null | undefined
}

/** Admin-only immediate move — one transaction, recorded as a request born RECEIVED. */
export interface DirectMoveInput {
  readonly fromStoreId: string
  readonly toStoreId: string
  readonly note?: string | null | undefined
  readonly lines: readonly TransferLineInput[]
}
