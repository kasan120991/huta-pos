import type { DiscountType, PromotionScope, TrackingMode } from '../enums.js'

/**
 * Pricing wire types.
 *
 * The client sends what it wants priced and renders what comes back. It never derives a
 * price from a rate and a weight — the house rule is explicit, and the arithmetic below is why
 * it could not do so correctly anyway: `grossCents` is NOT reproducible from
 * `pricePerGramCents` for a tiered line.
 */

/** A manual discount typed by a cashier, as opposed to a Promotion the system matched. */
export interface ManualDiscountInput {
  /** `PERCENT_OFF` reads `value` as basis points; `AMOUNT_OFF` reads it as cents. */
  readonly discountType: Exclude<DiscountType, 'OVERRIDE_PRICE_PER_GRAM'>
  readonly value: number
  readonly reason?: string | undefined
}

export interface QuoteLineInput {
  readonly variantId: string
  /** Base units: items for EACH, milligrams for WEIGHT. */
  readonly quantityBase: number
  readonly manualDiscount?: ManualDiscountInput | undefined
}

export interface QuoteInput {
  readonly lines: readonly QuoteLineInput[]
  /** Required for an admin; a staff or terminal principal is pinned to its own store. */
  readonly storeId?: string | undefined
  readonly orderDiscount?: ManualDiscountInput | undefined
  /**
   * Price as of this instant instead of now. Admin-only, and for explaining a past or
   * scheduled price — never sent by the register.
   */
  readonly at?: string | undefined
}

/** One promotion that actually took money off, and how much. */
export interface AppliedPromotion {
  readonly promotionId: string
  readonly name: string
  readonly scopeType: PromotionScope
  readonly discountType: DiscountType
  readonly value: number
  /** What THIS promotion took off, after any that ran before it. */
  readonly discountCents: number
}

/**
 * A promotion that matched the line but was not used.
 *
 * Surfaced rather than dropped: with "best outcome" selection a real, active, correctly
 * scoped promotion can lose to a better one, and staff asked "what happened to the 10%
 * off?" need an answer that is on the screen rather than in the database.
 */
export interface RejectedPromotion {
  readonly promotionId: string
  readonly name: string
  readonly reason: 'lost-to-better-outcome' | 'not-applicable-to-tracking-mode'
}

export type PromotionStrategy = 'none' | 'single-non-stackable' | 'stacked'

export interface QuotedLine {
  readonly variantId: string
  readonly productName: string
  readonly variantLabel: string | null
  readonly sku: string
  readonly trackingMode: TrackingMode
  readonly quantityBase: number

  /** EACH lines only. */
  readonly unitPriceCents: number | null
  /** WEIGHT lines only — the resolved rate, for the receipt and for `SaleLine`. */
  readonly pricePerGramCents: number | null
  /** The tier that decided the rate, if one did. */
  readonly appliedTierId: string | null
  readonly appliedTierLabel: string | null

  /**
   * The line total before any discount, and the AUTHORITATIVE figure.
   *
   * Deliberately not reproducible from `pricePerGramCents × quantityBase` on a tiered
   * line: `extendTier` charges the total the admin typed at the threshold and floors above
   * it, so the rate is a rounded description of the charge rather than its input.
   */
  readonly grossCents: number

  readonly appliedPromotions: readonly AppliedPromotion[]
  readonly rejectedPromotions: readonly RejectedPromotion[]
  readonly promotionStrategy: PromotionStrategy
  readonly promotionDiscountCents: number

  readonly manualDiscountCents: number
  /** This line's share of an order-level discount. */
  readonly orderDiscountCents: number

  readonly discountCents: number
  readonly netCents: number
  /**
   * This line's exact share of the sale's tax (largest-remainder allocated, so line
   * taxes sum to the quote's). 0 for a non-taxable variant.
   */
  readonly taxCents: number

  /** Short human-readable steps, for the register's "why is that $42.85?" panel. */
  readonly explain: readonly string[]
}

export interface Quote {
  readonly storeId: string
  readonly lines: readonly QuotedLine[]
  readonly subtotalCents: number
  readonly discountCents: number
  readonly netCents: number
  /**
   * Tax and the amount actually due, computed with checkout's exact math so what the
   * register displays can NEVER disagree with what checkout charges.
   */
  readonly taxRateBps: number
  readonly taxCents: number
  readonly totalCents: number
  /** The instant the quote was resolved at, so it can be replayed. */
  readonly pricedAt: string
}

// --- price group administration --------------------------------------------------------

export interface PriceTierRow {
  readonly id: string
  readonly minQuantityBase: number
  readonly totalPriceCents: number
  /** The per-gram rate this tier implies, derived for display only. */
  readonly derivedPerGramCents: number
}

export interface PriceGroupRow {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly basePricePerGramCents: number
  readonly active: boolean
  readonly tiers: readonly PriceTierRow[]
  /** How many variants price through this group — the blast radius of an edit. */
  readonly variantCount: number
  /**
   * The variants this group prices, for the editor's register preview.
   *
   * The preview quotes a REAL variant rather than the group in the abstract, because a
   * group-only preview could only see group-scoped promotions and would quietly disagree
   * with what the counter charges on a strain carrying its own promo.
   */
  readonly variants: ReadonlyArray<{
    readonly id: string
    readonly productName: string
    readonly label: string | null
  }>
}

/**
 * One row of a group's price list: what the LADDER charges at that weight.
 *
 * Promotion-free and store-free by construction, which is the difference between this and
 * a quote. A price list answers "what does the shelf say"; a quote answers "what will this
 * register ring right now, for this variant, at this store, under today's promotions".
 * The pricing desk shows both and labels which is which — they legitimately disagree.
 */
export interface PriceLadderRow {
  readonly quantityBase: number
  readonly totalCents: number
  /** The tier's DESCRIPTIVE per-gram rate. Never multiply it back — see extendTier. */
  readonly perGramCents: number
  /** Null below the lowest tier, where the base rate applies. */
  readonly tierId: string | null
  /** True only when a stored tier sits exactly at this weight — the rest are illustrative. */
  readonly isTierThreshold: boolean
  /** How far below the base rate this row's per-gram rate sits, in basis points. */
  readonly savingBps: number
}

export interface PriceGroupInput {
  readonly name: string
  readonly basePricePerGramCents: number
  readonly active?: boolean | undefined
}

export interface PriceTierInput {
  readonly minQuantityBase: number
  readonly totalPriceCents: number
}
