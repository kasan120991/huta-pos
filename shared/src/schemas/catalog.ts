import type { TrackingMode } from '../enums.js'
import type { StockStatus } from '../stock.js'
import type { WeightVarianceRow } from './receiving.js'

/**
 * Catalog wire types.
 *
 * Cost is `costCents?: number` — OPTIONAL, not nullable. The server omits the key entirely
 * for a principal without `cost.view`, so a client that treats it as always-present is
 * making an assumption the API deliberately does not honour.
 */

export interface CatalogStockLevel {
  readonly storeId: string
  readonly quantityBase: number
  readonly reorderPointBase: number | null
}

/** Per-variant stock, already reduced over whichever stores are in scope. */
export interface VariantStock {
  readonly quantityBase: number
  /**
   * The threshold this was judged against, summed over the in-scope stores, or null when
   * neither the stock rows nor the category set one. Null means LOW is unreachable.
   */
  readonly reorderBase: number | null
  readonly status: StockStatus
  /** Per-store, in the reference store order, so the table can lay out columns. */
  readonly byStore: ReadonlyArray<{ readonly storeId: string; readonly quantityBase: number }>
}

export interface CatalogPriceTier {
  readonly minQuantityBase: number
  readonly totalPriceCents: number
}

export interface CatalogPriceGroup {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly basePricePerGramCents: number
  readonly tiers: readonly CatalogPriceTier[]
}

export interface CatalogVariant {
  readonly id: string
  readonly sku: string
  readonly barcode: string | null
  readonly label: string | null
  readonly trackingMode: TrackingMode
  readonly priceCents: number | null
  readonly taxable: boolean
  /**
   * Staff payloads only ever contain active variants, so for them this is always true.
   * Admin detail payloads include inactive variants — quick-created stock is real stock.
   */
  readonly active: boolean
  /** Register sale guardrails, in the variant's base unit. Null means unbounded. */
  readonly minSaleBase: number | null
  readonly maxSaleBase: number | null
  /** Present only for a principal that may see cost. */
  readonly costCents?: number | null
  readonly priceGroup: CatalogPriceGroup | null
  readonly stockLevels: readonly CatalogStockLevel[]
  /** Resolved against the in-scope stores. See VariantStock. */
  readonly stock: VariantStock
  /**
   * DETAIL payloads only — the list omits it deliberately (a per-variant potency join on
   * 300-odd rows buys nothing the list renders). Present means already resolved.
   */
  readonly identity?: ResolvedIdentity
}

export interface CatalogCannabinoidLink {
  readonly mgPerUnit: number | null
  readonly percentBps: number | null
  readonly cannabinoid: { readonly id: string; readonly name: string; readonly slug: string }
}

/**
 * Strain identity a VARIANT may carry in its own right, added 2026-08-21 when strains
 * became variants of one flower product. Every field is nullable and null means "inherit
 * the product's" — the server resolves the fallback and ships the ANSWER (see
 * `ResolvedIdentity`), so no client re-implements the rule.
 */
export interface VariantIdentityInput {
  readonly strainType?: string | null | undefined
  readonly terpeneProfile?: string | null | undefined
  readonly nose?: string | null | undefined
  /** Empty string is accepted and coerced to null server-side — "no COA". */
  readonly coaUrl?: string | null | undefined
  readonly description?: string | null | undefined
  /** Overrides the product's primarySupplier for SaleLine attribution. */
  readonly supplierId?: string | null | undefined
}

/** Which level a resolved value actually came from. Render inherited values differently. */
export type IdentitySource = 'variant' | 'product'

/**
 * What detail payloads carry per variant: the resolved answer plus, per field, which level
 * it came from. Read THIS, never the variant's raw columns — those are un-inherited.
 */
export interface ResolvedIdentity {
  readonly strainType: string | null
  readonly terpeneProfile: string | null
  readonly nose: string | null
  readonly coaUrl: string | null
  readonly description: string | null
  /** Per FIELD — the scalars fall back one at a time. */
  readonly sources: {
    readonly strainType: IdentitySource
    readonly terpeneProfile: IdentitySource
    readonly nose: IdentitySource
    readonly coaUrl: IdentitySource
    readonly description: IdentitySource
  }
  /** ALL-OR-NOTHING, unlike the scalars: a variant with any link owns the whole list. */
  readonly cannabinoids: readonly CatalogCannabinoidLink[]
  readonly cannabinoidSource: IdentitySource
  readonly supplier: { readonly id: string; readonly name: string } | null
  readonly supplierSource: IdentitySource
}

export interface CatalogProduct {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly category: {
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly parent: { readonly id: string; readonly name: string; readonly slug: string } | null
  }
  readonly brand: { readonly id: string; readonly name: string } | null
  readonly primarySupplier: { readonly id: string; readonly name: string } | null
  /** Staff lists only ever contain active products; admins can ask for inactive ones. */
  readonly active: boolean
  /** First image by sortOrder, or null. The full images array lives on the detail payload only. */
  readonly imageUrl: string | null
  readonly cannabinoids: readonly CatalogCannabinoidLink[]
  readonly variants: readonly CatalogVariant[]
  /**
   * The product's own stock, rolled up over its variants.
   *
   * `status` is the WORST of the variants — a product with five healthy variants and one at
   * zero needs attention, and a row that reported OK would hide that. `quantityBase` is
   * summed only when every variant shares a tracking mode; across a gummy and a gram it is
   * null, because "units sold" is meaningless across modes.
   */
  readonly stock: ProductStock
}

export interface ProductStock {
  readonly status: StockStatus
  /** Null when the product mixes EACH and WEIGHT variants — a sum would be nonsense. */
  readonly quantityBase: number | null
  readonly trackingMode: TrackingMode | null
  readonly byStore: ReadonlyArray<{ readonly storeId: string; readonly quantityBase: number }>
  /** How many of its variants are OUT — what the row badge counts. */
  readonly outCount: number
  readonly variantCount: number
}

export interface CatalogProductDetail extends CatalogProduct {
  readonly description: string | null
  readonly coaUrl: string | null
  readonly strainType: string | null
  readonly terpeneProfile: string | null
  readonly nose: string | null
  readonly images: ReadonlyArray<{ readonly url: string; readonly alt: string | null }>
  readonly stores: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/**
 * Admin product creation. The first variant is REQUIRED — a product with no variant
 * cannot be priced, stocked, or sold, so it never gets created without one. Cannabinoid
 * links and images are follow-up PUTs, not part of the create.
 */
export interface ProductCreateRequest {
  readonly name: string
  readonly categoryId: string
  readonly description?: string | null
  readonly brandId?: string | null
  readonly primarySupplierId?: string | null
  readonly coaUrl?: string | null
  readonly strainType?: string | null
  readonly terpeneProfile?: string | null
  readonly nose?: string | null
  /** Defaults to true — deliberate admin creation, unlike receiving's rescue path. */
  readonly active?: boolean
  readonly variant: {
    readonly sku: string
    readonly trackingMode: TrackingMode
    readonly label?: string | null
    readonly barcode?: string | null
    /** EACH only — WEIGHT variants price through their group. */
    readonly priceCents?: number | null
    /** WEIGHT only. */
    readonly priceGroupId?: string | null
    readonly taxable?: boolean
    readonly active?: boolean
    readonly minSaleBase?: number | null
    readonly maxSaleBase?: number | null
  }
}

export interface ProductCreateResult {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly active: boolean
  readonly variant: {
    readonly id: string
    readonly sku: string
    readonly trackingMode: TrackingMode
    readonly active: boolean
  }
}

export interface CatalogPage {
  readonly products: readonly CatalogProduct[]
  /**
   * The stores in scope, in the order `stock.byStore` is laid out.
   *
   * Returned with the page rather than looked up from the reference data, so a column
   * heading can never drift out of step with the numbers under it.
   */
  readonly stores: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly pageCount: number
}

// --- admin writes (Phase: products flow) ---------------------------------------------------
//
// The wire shapes of the catalog's admin write endpoints. The server's Zod schemas in
// catalog.routes.ts are the runtime authority; catalog-admin.service.ts imports THESE so
// client and server cannot drift without a compile error. No DELETE shapes exist because
// no DELETE routes exist — deactivation is the only removal.

/** PATCH /catalog/products/:id — send only the keys that changed (the audit row records them). */
export interface ProductPatchInput {
  readonly name?: string | undefined
  readonly description?: string | null | undefined
  readonly categoryId?: string | undefined
  readonly brandId?: string | null | undefined
  readonly primarySupplierId?: string | null | undefined
  /** Empty string is accepted and coerced to null server-side — "no COA". */
  readonly coaUrl?: string | null | undefined
  readonly strainType?: string | null | undefined
  readonly terpeneProfile?: string | null | undefined
  readonly nose?: string | null | undefined
  readonly active?: boolean | undefined
}

/** One row of PUT /catalog/products/:id/cannabinoids — a full-array replace. */
export interface CannabinoidLinkInput {
  readonly cannabinoidId: string
  /** Both may be null — "contains X, potency unrecorded" is a legal, honest fact. */
  readonly mgPerUnit: number | null
  readonly percentBps: number | null
}

/** One row of PUT /catalog/products/:id/images — array index IS the display order. */
export interface ProductImageInput {
  readonly url: string
  readonly alt?: string | null | undefined
}

/**
 * PATCH /catalog/variants/:id. `trackingMode` is deliberately absent — changing it would
 * re-unit every historical quantity. The server validates the MERGED row, so a pricing
 * change must send the full mutually exclusive pair (priceCents XOR priceGroupId).
 */
export interface VariantPatchInput extends VariantIdentityInput {
  readonly label?: string | null | undefined
  readonly sku?: string | undefined
  readonly barcode?: string | null | undefined
  readonly priceCents?: number | null | undefined
  readonly priceGroupId?: string | null | undefined
  readonly taxable?: boolean | undefined
  readonly active?: boolean | undefined
  readonly minSaleBase?: number | null | undefined
  readonly maxSaleBase?: number | null | undefined
}

/** POST /catalog/products/:id/variants. No cost field — receiving owns cost. */
export interface VariantCreateInput extends VariantIdentityInput {
  readonly sku: string
  readonly trackingMode: TrackingMode
  readonly label?: string | null | undefined
  readonly barcode?: string | null | undefined
  readonly priceCents?: number | null | undefined
  readonly priceGroupId?: string | null | undefined
  readonly taxable?: boolean | undefined
  readonly active?: boolean | undefined
  readonly minSaleBase?: number | null | undefined
  readonly maxSaleBase?: number | null | undefined
}

/** What POST /catalog/brands returns. */
export interface BrandCreateResult {
  readonly id: string
  readonly name: string
}

export interface CatalogReference {
  readonly categories: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly parentId: string | null
    /**
     * ROLLED UP over descendants, not the direct count.
     *
     * The direct count is zero for every real parent, which is what made the parent chips
     * vanish from the filter bar and left `expandCategoryIds` with no control that could
     * invoke it. A parent's count must describe what selecting it returns.
     */
    readonly productCount: number
    /** Products filed directly on this node. `Other` is the only parent with any. */
    readonly directProductCount: number
  }>
  readonly cannabinoids: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly productCount: number
  }>
  readonly stores: ReadonlyArray<{ readonly id: string; readonly name: string }>
  /** Active brands, for the product editor's picker. */
  readonly brands: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/**
 * Counts for the summary strip.
 *
 * Deliberately carries NO money. Inventory valuation is cost-derived and therefore
 * admin-only, and a strip that renders differently per role is a strip that leaks the
 * difference. Valuation belongs on the Phase 11 reporting dashboard, which is admin-gated
 * as a whole.
 */
export interface CatalogSummary {
  readonly products: number
  readonly variants: number
  readonly outOfStock: number
  readonly belowReorder: number
  /** Products matching each stock filter, for the rail's counts. */
  readonly productsOutOfStock: number
  readonly productsBelowReorder: number
  /** Quantity-based: anything actually on the shelf in scope. See STOCK_FILTERS. */
  readonly productsOnHand: number
}

export interface StockLevelRow {
  readonly storeId: string
  readonly storeName: string
  readonly quantityBase: number
  readonly reorderPointBase: number | null
  /** Present only for a principal that may see cost. Null means cost unknown, not zero. */
  readonly costBasisCents?: number | null
  /** Derived basis ÷ quantity (per item / per GRAM). Present only alongside the basis. */
  readonly avgUnitCostCents?: number | null
}

/**
 * Admin-only product economics, aggregated server-side.
 *
 * Everything here is cost-derived, so the whole endpoint sits behind `cost.view` rather
 * than optional-key-stripping field by field. Null consistently means "not knowable":
 * a null basis is unknown cost, never zero, and stock with unknown cost is EXCLUDED from
 * the blended margin rather than dragging it toward 100%.
 */
export interface ProductInsights {
  /** Sum of known cost bases over the in-scope stores; null when none is known. */
  readonly valueAtCostCents: number | null
  /** Blended over on-hand stock where retail AND cost are both known. */
  readonly marginBps: number | null
  /** Null when the product has no WEIGHT variant. Window is the server's default (90d). */
  readonly lossRate90d: {
    readonly receivedBase: number
    readonly lostBase: number
    readonly lossRateBps: number | null
  } | null
  readonly variants: ReadonlyArray<{
    readonly variantId: string
    readonly avgUnitCostCents: number | null
    readonly marginBps: number | null
    readonly levels: readonly StockLevelRow[]
    /** WEIGHT variants only. */
    readonly variance?: readonly WeightVarianceRow[]
  }>
}
