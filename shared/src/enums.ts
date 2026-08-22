/**
 * Mirrors of the 14 enums in `server/prisma/schema.prisma`.
 *
 * These are hand-maintained duplicates, deliberately. The frontend must never import the
 * Prisma client: the generated directory is gitignored, and its entry points value-import
 * `@prisma/client/runtime/*`, which would drag the Prisma runtime into the register's
 * browser bundle and invert the dependency direction the house rules sets.
 *
 * The safety net is `server/src/db/enum-parity.ts`, a compile-time proof that these match
 * what Prisma generates. Change an enum in the schema without changing it here and
 * `pnpm typecheck` fails.
 *
 * The shape (`const` object + derived type) is byte-identical to Prisma's own emission.
 * The repetition is on purpose — a generic factory would break the literal-type inference
 * the parity check depends on.
 */

export const Role = {
  ADMIN: 'ADMIN',
  STAFF: 'STAFF',
} as const
export type Role = (typeof Role)[keyof typeof Role]
export const ROLE_VALUES = Object.values(Role) as readonly Role[]

export const TrackingMode = {
  EACH: 'EACH',
  WEIGHT: 'WEIGHT',
} as const
export type TrackingMode = (typeof TrackingMode)[keyof typeof TrackingMode]
export const TRACKING_MODE_VALUES = Object.values(TrackingMode) as readonly TrackingMode[]

export const StrainType = {
  INDICA: 'INDICA',
  SATIVA: 'SATIVA',
  HYBRID: 'HYBRID',
} as const
export type StrainType = (typeof StrainType)[keyof typeof StrainType]
export const STRAIN_TYPE_VALUES = Object.values(StrainType) as readonly StrainType[]

export const MovementType = {
  SALE: 'SALE',
  RETURN: 'RETURN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  ADJUSTMENT: 'ADJUSTMENT',
  RECEIVE: 'RECEIVE',
  SHRINKAGE: 'SHRINKAGE',
} as const
export type MovementType = (typeof MovementType)[keyof typeof MovementType]
export const MOVEMENT_TYPE_VALUES = Object.values(MovementType) as readonly MovementType[]

export const TransferStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  IN_TRANSIT: 'IN_TRANSIT',
  RECEIVED: 'RECEIVED',
  DECLINED: 'DECLINED',
  CANCELLED: 'CANCELLED',
} as const
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus]
export const TRANSFER_STATUS_VALUES = Object.values(TransferStatus) as readonly TransferStatus[]

export const PurchaseOrderStatus = {
  DRAFT: 'DRAFT',
  ORDERED: 'ORDERED',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus]
export const PURCHASE_ORDER_STATUS_VALUES = Object.values(
  PurchaseOrderStatus,
) as readonly PurchaseOrderStatus[]

export const SaleStatus = {
  COMPLETED: 'COMPLETED',
  VOIDED: 'VOIDED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const
export type SaleStatus = (typeof SaleStatus)[keyof typeof SaleStatus]
export const SALE_STATUS_VALUES = Object.values(SaleStatus) as readonly SaleStatus[]

export const PaymentMethod = {
  CASH: 'CASH',
  CARD: 'CARD',
} as const
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod]
export const PAYMENT_METHOD_VALUES = Object.values(PaymentMethod) as readonly PaymentMethod[]

export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus]
export const PAYMENT_STATUS_VALUES = Object.values(PaymentStatus) as readonly PaymentStatus[]

export const ShiftStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const
export type ShiftStatus = (typeof ShiftStatus)[keyof typeof ShiftStatus]
export const SHIFT_STATUS_VALUES = Object.values(ShiftStatus) as readonly ShiftStatus[]

/**
 * How a time entry ended — the difference between a fact and an estimate.
 *
 * AUTO is the one that matters: nobody clocked out and the entry was closed at the cutoff,
 * so its end time is a GUESS. Any figure derived from it has to say so, or someone gets paid
 * from a number the system invented.
 */
export const TimeEntryStatus = {
  OPEN: 'OPEN',
  CLOCKED: 'CLOCKED',
  AUTO: 'AUTO',
  CORRECTED: 'CORRECTED',
  VOIDED: 'VOIDED',
} as const
export type TimeEntryStatus = (typeof TimeEntryStatus)[keyof typeof TimeEntryStatus]
export const TIME_ENTRY_STATUS_VALUES = Object.values(
  TimeEntryStatus,
) as readonly TimeEntryStatus[]

export const CashMovementType = {
  PAID_IN: 'PAID_IN',
  PAID_OUT: 'PAID_OUT',
  DROP: 'DROP',
  /** The owner collecting the till — the event that resets a carried-over drawer. */
  PICKUP: 'PICKUP',
} as const
export type CashMovementType = (typeof CashMovementType)[keyof typeof CashMovementType]
export const CASH_MOVEMENT_TYPE_VALUES = Object.values(
  CashMovementType,
) as readonly CashMovementType[]

export const PromotionScope = {
  VARIANT: 'VARIANT',
  PRODUCT: 'PRODUCT',
  CATEGORY: 'CATEGORY',
  PRICE_GROUP: 'PRICE_GROUP',
} as const
export type PromotionScope = (typeof PromotionScope)[keyof typeof PromotionScope]
export const PROMOTION_SCOPE_VALUES = Object.values(PromotionScope) as readonly PromotionScope[]

export const DiscountType = {
  PERCENT_OFF: 'PERCENT_OFF',
  AMOUNT_OFF: 'AMOUNT_OFF',
  OVERRIDE_PRICE_PER_GRAM: 'OVERRIDE_PRICE_PER_GRAM',
} as const
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType]
export const DISCOUNT_TYPE_VALUES = Object.values(DiscountType) as readonly DiscountType[]

export const LoyaltyTransactionType = {
  EARN: 'EARN',
  REDEEM: 'REDEEM',
  ADJUST: 'ADJUST',
  CREDIT_ADD: 'CREDIT_ADD',
  CREDIT_SPEND: 'CREDIT_SPEND',
} as const
export type LoyaltyTransactionType =
  (typeof LoyaltyTransactionType)[keyof typeof LoyaltyTransactionType]
export const LOYALTY_TRANSACTION_TYPE_VALUES = Object.values(
  LoyaltyTransactionType,
) as readonly LoyaltyTransactionType[]

// --- guards ---------------------------------------------------------------------------

const memberOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value)

export const isRole = memberOf(ROLE_VALUES)
export const isTrackingMode = memberOf(TRACKING_MODE_VALUES)
export const isStrainType = memberOf(STRAIN_TYPE_VALUES)
export const isMovementType = memberOf(MOVEMENT_TYPE_VALUES)
export const isTransferStatus = memberOf(TRANSFER_STATUS_VALUES)
export const isPurchaseOrderStatus = memberOf(PURCHASE_ORDER_STATUS_VALUES)
export const isSaleStatus = memberOf(SALE_STATUS_VALUES)
export const isPaymentMethod = memberOf(PAYMENT_METHOD_VALUES)
export const isPaymentStatus = memberOf(PAYMENT_STATUS_VALUES)
export const isShiftStatus = memberOf(SHIFT_STATUS_VALUES)
export const isCashMovementType = memberOf(CASH_MOVEMENT_TYPE_VALUES)
export const isPromotionScope = memberOf(PROMOTION_SCOPE_VALUES)
export const isDiscountType = memberOf(DISCOUNT_TYPE_VALUES)
export const isLoyaltyTransactionType = memberOf(LOYALTY_TRANSACTION_TYPE_VALUES)

/**
 * Movement types that must carry a negative `quantityBase`, mirroring the
 * `InventoryMovement_direction_check` constraint. `ADJUSTMENT` may go either way.
 */
export const NEGATIVE_MOVEMENT_TYPES: readonly MovementType[] = [
  MovementType.SALE,
  MovementType.TRANSFER_OUT,
  MovementType.SHRINKAGE,
]

export const POSITIVE_MOVEMENT_TYPES: readonly MovementType[] = [
  MovementType.RETURN,
  MovementType.TRANSFER_IN,
  MovementType.RECEIVE,
]
