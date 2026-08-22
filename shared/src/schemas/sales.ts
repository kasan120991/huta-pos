import type {
  CashMovementType,
  PaymentMethod,
  PaymentStatus,
  SaleStatus,
  ShiftStatus,
  TrackingMode,
} from '../enums.js'
import type { ManualDiscountInput } from './pricing.js'

/**
 * Sales & shifts wire types — Phase 8, extended by Phase 9 (card, refunds, voids, split).
 *
 * Everything on a SaleReceipt is a SNAPSHOT taken at checkout: prices, tier, promotions,
 * tax rate, supplier, cost. Re-displaying a receipt renders these numbers verbatim and
 * never joins to current catalog or pricing state.
 *
 * `unitCostCents` is `?: number | null` — OPTIONAL, not nullable-only. The server omits
 * the key entirely for a principal without `cost.view`.
 */

// --- shifts ------------------------------------------------------------------------------

export interface ShiftRow {
  readonly id: string
  readonly storeId: string
  readonly storeName: string
  readonly terminalId: string | null
  readonly openedById: string
  readonly openedByName: string
  readonly openedAt: string
  readonly openingCashCents: number
  readonly closedById: string | null
  readonly closedByName: string | null
  readonly closedAt: string | null
  readonly closingCountedCashCents: number | null
  /** Set only at close. Counted − expected; negative is short. Recorded, never absorbed. */
  readonly expectedCashCents: number | null
  readonly varianceCents: number | null
  readonly status: ShiftStatus
  readonly notes: string | null
  /** Live figures for the close screen header. */
  readonly saleCount: number
  readonly cashSalesCents: number
  /** Card money never touches the drawer — shown for context, excluded from expected. */
  readonly cardSalesCents: number
  /** Cash paid OUT of this shift's drawer as refunds (by the refund's shift, not the
   *  sale's — a Tuesday refund of a Monday sale hits Tuesday's drawer). */
  readonly cashRefundsCents: number
}

export interface CashMovementRow {
  readonly id: string
  readonly type: CashMovementType
  /** Always positive — the type carries the direction. */
  readonly amountCents: number
  readonly reason: string
  readonly userName: string
  readonly createdAt: string
}

export interface OpenShiftInput {
  readonly openingCashCents: number
  /** Admin only — staff are pinned to their own store server-side. */
  readonly storeId?: string
}

export interface CloseShiftInput {
  /** What was actually counted in the drawer, keyed BLIND — expected reveals after. */
  readonly countedCashCents: number
  readonly notes?: string
}

export interface CashMovementInput {
  readonly type: CashMovementType
  readonly amountCents: number
  readonly reason: string
}

// --- checkout ----------------------------------------------------------------------------

export interface CheckoutLineInput {
  readonly variantId: string
  /** Items for EACH, MILLIGRAMS for WEIGHT — the client converts typed grams. */
  readonly quantityBase: number
  readonly manualDiscount?: ManualDiscountInput
}

/**
 * One tender per method, at most one of each. The CARD amount is never in the body — it
 * was fixed when the intent was created and the server re-verifies it against its own
 * quote at checkout.
 */
export type TenderInput =
  | {
      readonly method: 'CASH'
      /** Cash presented. In a cash-only sale change is computed server-side; in a split
       *  sale cash is an EXACT applied amount (change 0) — the card took the rest. */
      readonly tenderedCents: number
    }
  | { readonly method: 'CARD'; readonly paymentIntentId: string }

export interface CheckoutInput {
  readonly lines: readonly CheckoutLineInput[]
  readonly orderDiscount?: ManualDiscountInput
  /**
   * The cashier's attestation that the customer is 21+. Required (server 409s) whenever
   * the cart contains a cannabinoid-bearing product; persisting it records WHO verified.
   */
  readonly ageVerified: boolean
  /** Empty is legal ONLY when the total is $0 (a fully discounted sale). */
  readonly tenders: readonly TenderInput[]
}

/** What the register sends to stage a card charge before confirming it with Elements. */
export interface SaleIntentInput {
  readonly lines: readonly CheckoutLineInput[]
  readonly orderDiscount?: ManualDiscountInput
  /** Cash applied alongside the card; the intent charges `total − cashCents`. */
  readonly cashCents: number
}

export interface SaleIntentResult {
  readonly paymentIntentId: string
  readonly clientSecret: string
  readonly cardAmountCents: number
  readonly totalCents: number
}

/** `publishableKey: null` means Stripe is not configured — the register disables Card. */
export interface PaymentsConfig {
  readonly publishableKey: string | null
}

export interface SaleReceiptLine {
  readonly id: string
  readonly variantId: string
  readonly productName: string
  readonly variantLabel: string | null
  readonly trackingMode: TrackingMode
  readonly quantityBase: number
  /** EACH only. */
  readonly unitPriceCents: number | null
  /** WEIGHT only — a rounded DESCRIPTION of the charge, never its input. */
  readonly pricePerGramCents: number | null
  readonly priceTierId: string | null
  readonly grossCents: number
  readonly discountCents: number
  readonly netCents: number
  readonly taxCents: number
  readonly promotions: ReadonlyArray<{
    readonly promotionId: string
    readonly nameSnapshot: string
    readonly discountCents: number
    readonly sequence: number
  }>
  /** How much of `quantityBase` has been refunded so far (Phase 9). */
  readonly refundedQuantityBase: number
  /** ADMIN-ONLY. Weighted-average cost at the moment of sale; null = cost unknown. */
  readonly unitCostCents?: number | null
}

export interface SaleReceipt {
  readonly id: string
  /** Per-store sequence, allocated at checkout. */
  readonly number: number
  readonly storeId: string
  readonly storeName: string
  readonly terminalId: string | null
  readonly cashierName: string
  readonly createdAt: string
  readonly status: SaleStatus
  readonly subtotalCents: number
  readonly discountCents: number
  readonly taxCents: number
  readonly totalCents: number
  /** The store's rate AT SALE TIME — changing the store never alters this receipt. */
  readonly taxRateBps: number
  readonly ageVerified: boolean
  /** Empty for a fully discounted $0 sale. Split cash/card sales carry two entries. */
  readonly payments: readonly ReceiptPayment[]
  /** Everything given back so far, newest last. Empty until a refund or void happens. */
  readonly refunds: readonly RefundReceipt[]
  readonly voidedAt: string | null
  readonly voidReason: string | null
  readonly lines: readonly SaleReceiptLine[]
}

export type ReceiptPayment =
  | {
      readonly method: 'CASH'
      readonly amountCents: number
      readonly cashTenderedCents: number
      readonly cashChangeCents: number
    }
  | {
      readonly method: 'CARD'
      readonly amountCents: number
      /** e.g. "visa" — from the retrieved intent; null if Stripe did not say. */
      readonly cardBrand: string | null
      readonly cardLast4: string | null
    }

// --- refunds & voids (Phase 9) -----------------------------------------------------------

export interface RefundLineInput {
  readonly saleLineId: string
  /** Base units to give back — must not exceed what remains unrefunded on the line. */
  readonly quantityBase: number
  /** False for damaged/unsellable goods: money back, no RETURN movement. */
  readonly restock: boolean
}

/**
 * Amounts are SERVER-computed from each line's actual charge — the client never sends a
 * dollar figure. Every refund and void requires a step-up grant (policy, 2026-08-18);
 * calling without one gets 403 STEP_UP_REQUIRED naming `sale.refund`.
 */
export interface RefundInput {
  readonly lines: readonly RefundLineInput[]
  readonly method: PaymentMethod
  readonly reason?: string
  readonly stepUpGrantId?: string
}

export interface VoidInput {
  readonly reason: string
  readonly stepUpGrantId?: string
}

/**
 * Preview of what a refund would give back — the register renders THESE figures and
 * never derives a share itself. The same server math runs again at the real refund.
 */
export interface RefundQuoteInput {
  readonly lines: ReadonlyArray<{ readonly saleLineId: string, readonly quantityBase: number }>
}

export interface RefundQuoteResult {
  readonly lines: ReadonlyArray<{ readonly saleLineId: string, readonly amountCents: number }>
  readonly totalCents: number
}

export interface RefundReceiptLine {
  readonly saleLineId: string
  readonly productName: string
  readonly variantLabel: string | null
  readonly trackingMode: TrackingMode
  readonly quantityBase: number
  readonly amountCents: number
  readonly restock: boolean
}

export interface RefundReceipt {
  readonly id: string
  readonly saleId: string
  readonly saleNumber: number
  readonly method: PaymentMethod
  readonly amountCents: number
  /** Cash refunds are SUCCEEDED at birth; card refunds settle after the Stripe call and
   *  can read FAILED — the money did NOT move, the record and any restock stand. */
  readonly status: PaymentStatus
  readonly reason: string | null
  readonly refundedByName: string
  readonly approvedByName: string | null
  readonly createdAt: string
  readonly lines: readonly RefundReceiptLine[]
}

/** One row of the return surface's recent-sales list. */
export interface SaleSummaryRow {
  readonly id: string
  readonly number: number
  readonly createdAt: string
  readonly totalCents: number
  readonly status: SaleStatus
  readonly cashierName: string
  readonly paymentMethods: readonly PaymentMethod[]
}

// --- transaction history -----------------------------------------------------------------
//
// A history row is a SaleSummaryRow plus the columns a browsable table needs that the
// register's 50-row recent list never did. `/recent` keeps returning the narrow shape —
// widening it would put a store name on a list that is already store-scoped by construction.

export interface SaleHistoryRow extends SaleSummaryRow {
  readonly storeId: string
  readonly storeName: string
  /** So a row can seed the cashier filter without a name-to-id lookup. */
  readonly cashierId: string
  /** How many lines the sale had — "1 item" vs "6 items" at a glance. */
  readonly lineCount: number
  /** Money already given back against this sale, SUCCEEDED refunds only. 0 for most rows. */
  readonly refundedCents: number
}

/**
 * Mirrors `CatalogPage` rather than extracting a generic `Page<T>` — there are two paged
 * endpoints in this codebase and a shared generic would be indirection for its own sake.
 * The payload key is the entity name, same convention as `products`.
 */
export interface SalesPage {
  readonly sales: readonly SaleHistoryRow[]
  /** The stores this request covers, echoed so the client can label rows without a lookup. */
  readonly stores: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly pageCount: number
}

/**
 * Totals over the SAME filters as the list, so the two can never disagree.
 *
 * The arithmetic is the shift close generalised to a date range: money in is SUCCEEDED
 * payments, money out is SUCCEEDED refunds dated by the REFUND's own timestamp, and net is
 * the difference. A voided sale therefore contributes its payment AND its reversing refund
 * and nets to zero, exactly as the drawer reckons it — see the house rules, Phase 9.
 */
export interface SalesDayTotals {
  /** `YYYY-MM-DD` in the reporting timezone. */
  readonly day: string
  readonly saleCount: number
  readonly grossCents: number
  readonly refundsCents: number
  readonly netCents: number
}

export interface SalesTotals {
  /**
   * The IANA zone the day buckets were cut in — `Store.timezone`, never the server's.
   * Returned so the screen can label the range honestly instead of implying UTC.
   */
  readonly timezone: string
  /**
   * Filter options for the screen, computed over the filtered set MINUS the filter they
   * populate — otherwise picking a cashier collapses the cashier list to that one cashier
   * and there is no way back to the others.
   */
  readonly cashiers: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly saleCount: number
  /** Reported separately rather than subtracted — a void is a fact, not an absence. */
  readonly voidedCount: number
  readonly grossCents: number
  readonly cashCents: number
  readonly cardCents: number
  readonly refundsCents: number
  readonly netCents: number
  readonly days: readonly SalesDayTotals[]
}

/**
 * The filter shape both the list and the totals accept. Kept as one type so a page cannot
 * send the table one set of filters and the totals strip another.
 */
export interface SalesHistoryQuery {
  readonly storeId?: string | undefined
  readonly cashierId?: string | undefined
  /**
   * Business DAYS as `YYYY-MM-DD`, not instants — "what did we take on the 20th" is a
   * question about the store's calendar, so the server resolves them against
   * `Store.timezone`. Both ends are inclusive of the whole local day.
   */
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly status?: SaleStatus | undefined
  readonly method?: PaymentMethod | undefined
  readonly number?: number | undefined
}
