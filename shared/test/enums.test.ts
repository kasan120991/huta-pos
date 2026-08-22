import { describe, expect, it } from 'vitest'

import * as E from '../src/enums.js'

const MIRRORS = [
  ['Role', E.Role, ['ADMIN', 'STAFF']],
  ['TrackingMode', E.TrackingMode, ['EACH', 'WEIGHT']],
  ['StrainType', E.StrainType, ['INDICA', 'SATIVA', 'HYBRID']],
  [
    'MovementType',
    E.MovementType,
    ['SALE', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'RECEIVE', 'SHRINKAGE'],
  ],
  [
    'TransferStatus',
    E.TransferStatus,
    ['PENDING', 'ACCEPTED', 'IN_TRANSIT', 'RECEIVED', 'DECLINED', 'CANCELLED'],
  ],
  [
    'PurchaseOrderStatus',
    E.PurchaseOrderStatus,
    ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  ],
  ['SaleStatus', E.SaleStatus, ['COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED']],
  ['PaymentMethod', E.PaymentMethod, ['CASH', 'CARD']],
  ['PaymentStatus', E.PaymentStatus, ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']],
  ['ShiftStatus', E.ShiftStatus, ['OPEN', 'CLOSED']],
  ['CashMovementType', E.CashMovementType, ['PAID_IN', 'PAID_OUT', 'DROP', 'PICKUP']],
  ['PromotionScope', E.PromotionScope, ['VARIANT', 'PRODUCT', 'CATEGORY', 'PRICE_GROUP']],
  [
    'DiscountType',
    E.DiscountType,
    ['PERCENT_OFF', 'AMOUNT_OFF', 'OVERRIDE_PRICE_PER_GRAM'],
  ],
  [
    'LoyaltyTransactionType',
    E.LoyaltyTransactionType,
    ['EARN', 'REDEEM', 'ADJUST', 'CREDIT_ADD', 'CREDIT_SPEND'],
  ],
] as const

describe('enum mirrors', () => {
  it('covers all 14 schema enums', () => {
    expect(MIRRORS).toHaveLength(14)
  })

  it.each(MIRRORS)('%s has exactly the expected members', (_name, mirror, expected) => {
    expect(Object.values(mirror)).toEqual([...expected])
  })

  // Every Prisma enum emits key === value. If that ever diverges here, the parity
  // assertion on the server would catch it, but this gives a readable failure first.
  it.each(MIRRORS)('%s has key === value for every member', (_name, mirror) => {
    for (const [key, value] of Object.entries(mirror)) {
      expect(key).toBe(value)
    }
  })
})

describe('guards', () => {
  it('accept members and reject near-misses', () => {
    expect(E.isRole('ADMIN')).toBe(true)
    expect(E.isRole('admin')).toBe(false)
    expect(E.isRole('')).toBe(false)
    expect(E.isRole(undefined)).toBe(false)
    expect(E.isTrackingMode('WEIGHT')).toBe(true)
    expect(E.isTrackingMode('WEIGHTED')).toBe(false)
  })
})

describe('movement direction sets', () => {
  // Mirrors the InventoryMovement_direction_check constraint. ADJUSTMENT is deliberately
  // in neither set — it may go either way.
  it('partition every movement type except ADJUSTMENT', () => {
    const covered = [...E.NEGATIVE_MOVEMENT_TYPES, ...E.POSITIVE_MOVEMENT_TYPES]
    expect(new Set(covered).size).toBe(covered.length)
    const uncovered = E.MOVEMENT_TYPE_VALUES.filter((t) => !covered.includes(t))
    expect(uncovered).toEqual([E.MovementType.ADJUSTMENT])
  })
})
