/**
 * Seed data for the reference tables.
 *
 * These are NOT enums and the database is authoritative at runtime — the house rule is
 * explicit that categories and cannabinoids are tables so an admin can add a row without
 * a migration and a deploy. These constants exist so the seed script has one definition
 * to read, and so code that genuinely needs to reference a well-known slug can do so
 * without a magic string.
 *
 * Both lists are derived from a survey of the legacy `huta-old` catalog rather than
 * invented.
 */

export interface CategorySeed {
  readonly slug: string
  readonly name: string
  readonly children?: readonly CategorySeed[]
  /**
   * Default reorder point in BASE UNITS, used when a StockLevel sets none of its own.
   *
   * Base units, so this is items for an `EACH` category and MILLIGRAMS for flower —
   * `flower` is 14000 because half an ounce is when you reorder, not 14 grams' worth of
   * some other unit. A category with no default can never be "below reorder", only "out",
   * which is the honest answer for a taxonomy node that holds no products.
   *
   * Seeded, then admin-editable. The column on `Category` is authoritative at runtime.
   */
  readonly reorderBase?: number
}

/**
 * Two-level category tree.
 *
 * The 16 leaves are the verbatim legacy categories, all of which are in use. The parents
 * are new: the legacy system had 16 flat siblings, which makes for a poor register screen
 * and gives reporting no natural rollup.
 *
 * Note the tree is deliberately not purely "cannabis products" — Kratom, Coffee, Novelty
 * and the three rolling-accessory categories are real parts of the catalog.
 */
export const CATEGORY_SEED: readonly CategorySeed[] = [
  {
    slug: 'inhalables',
    name: 'Inhalables',
    children: [
      { slug: 'cartridge', name: 'Cartridge', reorderBase: 4 },
      { slug: 'disposable', name: 'Disposable', reorderBase: 4 },
      { slug: 'vape', name: 'Vape', reorderBase: 3 },
      { slug: 'dab', name: 'Dab', reorderBase: 3 },
      // Milligrams: reorder at half an ounce.
      { slug: 'flower', name: 'Flower', reorderBase: 14_000 },
    ],
  },
  {
    slug: 'ingestibles',
    name: 'Ingestibles',
    children: [
      { slug: 'edible', name: 'Edible', reorderBase: 6 },
      { slug: 'tincture', name: 'Tincture', reorderBase: 3 },
      { slug: 'coffee', name: 'Coffee', reorderBase: 4 },
    ],
  },
  {
    slug: 'topicals',
    name: 'Topicals',
    children: [
      { slug: 'skin-care', name: 'Skin Care', reorderBase: 3 },
      { slug: 'pet-care', name: 'Pet Care', reorderBase: 3 },
    ],
  },
  {
    slug: 'accessories',
    name: 'Accessories',
    children: [
      { slug: 'rolling-papers', name: 'Rolling Papers', reorderBase: 6 },
      { slug: 'wraps', name: 'Wraps', reorderBase: 6 },
      { slug: 'rolling-trays', name: 'Rolling Trays', reorderBase: 3 },
      { slug: 'novelty', name: 'Novelty', reorderBase: 3 },
    ],
  },
  {
    slug: 'other-botanicals',
    name: 'Other Botanicals',
    children: [{ slug: 'kratom', name: 'Kratom', reorderBase: 4 }],
  },
  { slug: 'other', name: 'Other', reorderBase: 2 },
]

export interface CannabinoidSeed {
  readonly slug: string
  readonly name: string
}

/**
 * Cannabinoids.
 *
 * The legacy lookup table had 11 rows, but was stale: nine of these appear only inside
 * product titles ("Binoid HHC-P Cartridge", "Extrax HXY11 + Delta-10 + THC-H Disposable")
 * with no lookup row at all, which is part of why 61% of the legacy catalog had no
 * cannabinoid data. `Isolate` was in the legacy table and is dropped here — it describes
 * a form, not a cannabinoid, and had zero products.
 *
 * CBN, CBG and CBC are kept despite having no current products. They are standard and
 * will turn up.
 */
export const CANNABINOID_SEED: readonly CannabinoidSeed[] = [
  { slug: 'delta-8', name: 'Delta-8' },
  { slug: 'delta-9', name: 'Delta-9' },
  { slug: 'delta-10', name: 'Delta-10' },
  { slug: 'delta-11', name: 'Delta-11' },
  { slug: 'thc-a', name: 'THC-A' },
  { slug: 'thc-o', name: 'THC-O' },
  { slug: 'thc-p', name: 'THC-P' },
  { slug: 'thc-v', name: 'THC-V' },
  { slug: 'thc-h', name: 'THC-H' },
  { slug: 'thc-x', name: 'THC-X' },
  { slug: 'hhc', name: 'HHC' },
  { slug: 'hhc-o', name: 'HHC-O' },
  { slug: 'hhc-p', name: 'HHC-P' },
  { slug: 'hxy-11', name: 'HXY-11' },
  { slug: 'phc', name: 'PHC' },
  { slug: 'cbd', name: 'CBD' },
  { slug: 'cbn', name: 'CBN' },
  { slug: 'cbg', name: 'CBG' },
  { slug: 'cbc', name: 'CBC' },
]

/** Slug of the category whose products are weight-tracked. */
export const FLOWER_CATEGORY_SLUG = 'flower'

/** Slug of the price group flower prices through. */
export const FLOWER_PRICE_GROUP_SLUG = 'flower'

/** Flattened leaf slugs, for validation and for the seed script. */
export const CATEGORY_LEAF_SLUGS: readonly string[] = CATEGORY_SEED.flatMap((c) =>
  c.children ? c.children.map((child) => child.slug) : [c.slug],
)

export const CANNABINOID_SLUGS: readonly string[] = CANNABINOID_SEED.map((c) => c.slug)

/**
 * Why a stock adjustment was made.
 *
 * A constrained set stored in its own column rather than free text, so "how much did we
 * lose to damage this quarter" is a query instead of a reading exercise. A plain string
 * with a shared constant, not a Prisma enum — adding a reason should not need a migration
 * and a deploy, the same reasoning that makes categories and cannabinoids tables.
 */
export interface AdjustmentReason {
  readonly code: string
  readonly label: string
}

export const ADJUSTMENT_REASONS: readonly AdjustmentReason[] = [
  { code: 'damaged', label: 'Damaged' },
  { code: 'miscount', label: 'Miscount' },
  { code: 'expired', label: 'Expired' },
  { code: 'theft', label: 'Theft' },
  // Flower loses moisture between receiving and selling, and keying a 448000mg pound out in
  // gram increments accumulates drift. That is normal, not theft, and it must be separable
  // from theft in a report — a strain quietly bleeding weight and a strain being stolen look
  // identical in a total but call for completely different responses.
  { code: 'moisture', label: 'Moisture loss' },
  { code: 'other', label: 'Other' },
]

export const ADJUSTMENT_REASON_CODES: readonly string[] = ADJUSTMENT_REASONS.map((r) => r.code)

/** The default reason a weight-reconciliation session posts under. */
export const RECONCILE_REASON_CODE = 'moisture'
