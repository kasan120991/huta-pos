import type { Server } from 'socket.io'

import { ADMIN_ROOM, storeRoom } from './io.js'

/**
 * How a service reaches the socket server.
 *
 * `createIo` returns an instance that `index.ts` holds as a local, and `createApp()` never
 * listens — integration tests mount services directly and no socket server ever exists in
 * that context. A service that imported a live `io` would therefore either crash under test
 * or need a stub wired into every suite.
 *
 * So the io is INJECTED at boot and every emit NO-OPS until it is. Emitting stays what it
 * should be: a fire-and-forget side effect that the business logic does not depend on.
 * The house rules are explicit that a socket payload is a hint to refetch, never the thing that
 * makes a change real — a dropped event must cost nothing but a slower refresh.
 */

let io: Server | null = null

/** Called once from `index.ts`, immediately after `createIo`. */
export function setIo(server: Server): void {
  io = server
}

/** Test hook — drops the injected server so no suite leaks a socket into the next. */
export function clearIo(): void {
  io = null
}

/**
 * Events the server emits. A union rather than free strings so a typo in a room name or an
 * event name is a compile error instead of a listener that silently never fires.
 */
export type ServerEvent =
  | { readonly name: 'receipt.variance'; readonly payload: VariancePayload }
  | { readonly name: 'stock.changed'; readonly payload: StockChangedPayload }
  | { readonly name: 'sale.completed'; readonly payload: SaleCompletedPayload }
  | { readonly name: 'sale.refunded'; readonly payload: SaleRefundedPayload }
  | { readonly name: 'transfer.changed'; readonly payload: TransferChangedPayload }

/**
 * ONE event for every lifecycle transition — created, accepted, declined, shipped,
 * received, cancelled. Consumers refetch on any of them, so per-transition event names
 * would be six ways to spell "refetch". Emitted to BOTH store rooms and admin.
 */
export interface TransferChangedPayload {
  readonly transferId: string
  readonly status: string
  readonly requestingStoreId: string
  readonly sourceStoreId: string
}

export interface SaleRefundedPayload {
  readonly saleId: string
  readonly storeId: string
  readonly number: number
  readonly amountCents: number
  readonly method: 'CASH' | 'CARD'
  /** True when the Stripe refund FAILED — the record stands but the money did not move. */
  readonly cardRefundFailed: boolean
}

export interface SaleCompletedPayload {
  readonly saleId: string
  readonly storeId: string
  readonly storeName: string
  readonly number: number
  readonly totalCents: number
}

export interface VariancePayload {
  readonly receiptId: string
  readonly storeId: string
  readonly storeName: string
  readonly supplierName: string | null
  readonly purchaseOrderReference: string
  readonly lineCount: number
}

export interface StockChangedPayload {
  readonly storeId: string
  readonly variantId: string
}

/**
 * Never throws.
 *
 * A delivery that posted correctly must not fail because a notification could not be
 * delivered — the stock is already committed by the time this runs, and the review queue is
 * readable by refetching regardless.
 */
function safeEmit(room: string, event: ServerEvent): void {
  if (!io) return
  try {
    io.to(room).emit(event.name, event.payload)
  } catch (error) {
    console.error('[realtime] emit failed', event.name, error)
  }
}

export function emitToAdmin(event: ServerEvent): void {
  safeEmit(ADMIN_ROOM, event)
}

export function emitToStore(storeId: string, event: ServerEvent): void {
  safeEmit(storeRoom(storeId), event)
}
