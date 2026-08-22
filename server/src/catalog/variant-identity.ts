/**
 * Strain identity resolution — variant first, product as the fallback.
 *
 * Background: strains became VARIANTS of one flower Product on 2026-08-21 (the house rules,
 * Domain model). Before that, every identity fact — strain type, terpenes, nose, COA,
 * description, potency, supplier — lived on `Product`, which meant every strain under one
 * flower product would have shared a single set. Migration `variant_strain_attributes`
 * added nullable twins on `ProductVariant`; this module is the ONE place that decides
 * which of the two a reader sees.
 *
 * Two different fallback rules, deliberately:
 *
 *   * SCALARS fall back FIELD BY FIELD. A strain that records only its THCa nose still
 *     inherits the shelf's description, and a packaged good that sets none of them behaves
 *     exactly as it did before this migration existed.
 *
 *   * The CANNABINOID LIST falls back ALL OR NOTHING. If the variant carries any link, its
 *     list replaces the product's entirely. Merging would have to answer "the product says
 *     24% THCa and the variant says 19% — which is it?", and there is no honest answer;
 *     a per-cannabinoid merge would also silently resurrect a product-level entry the
 *     strain deliberately omits.
 *
 * Nothing here reads or returns cost. Supplier IS returned — it is not cost-shaped, staff
 * already see `primarySupplier` on product detail, and `SaleLine.supplierId` has always
 * been snapshotted from it.
 */

export interface StrainScalars {
  readonly strainType: string | null
  readonly terpeneProfile: string | null
  readonly nose: string | null
  readonly coaUrl: string | null
  readonly description: string | null
}

export interface PotencyLink {
  readonly mgPerUnit: number | null
  readonly percentBps: number | null
  readonly cannabinoid: {
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly sortOrder?: number
  }
}

/** Which side a resolved value came from — the UI renders inherited values differently. */
export type IdentitySource = 'variant' | 'product'

export interface ResolvedIdentity extends StrainScalars {
  /** Per FIELD, so a half-filled strain shows exactly which halves are its own. */
  readonly sources: Readonly<Record<keyof StrainScalars, IdentitySource>>
}

const SCALAR_KEYS = [
  'strainType',
  'terpeneProfile',
  'nose',
  'coaUrl',
  'description',
] as const satisfies readonly (keyof StrainScalars)[]

/**
 * Field-by-field: the variant's value when it has one, else the product's.
 *
 * An empty string counts as "not set" — the product editor coerces '' to null on the way
 * in, but a variant row written before that coercion existed, or by a future caller that
 * forgets, must not blank out an inherited COA by accident.
 */
export function resolveVariantIdentity(
  variant: Partial<StrainScalars> | null | undefined,
  product: Partial<StrainScalars> | null | undefined,
): ResolvedIdentity {
  const values = {} as Record<keyof StrainScalars, string | null>
  const sources = {} as Record<keyof StrainScalars, IdentitySource>

  for (const key of SCALAR_KEYS) {
    const own = variant?.[key]
    const isSet = own !== null && own !== undefined && own !== ''
    values[key] = isSet ? own : (product?.[key] ?? null)
    sources[key] = isSet ? 'variant' : 'product'
  }

  return { ...values, sources } as ResolvedIdentity
}

/**
 * All or nothing. A variant with zero links inherits the product's list wholesale; a
 * variant with one link owns the whole answer.
 */
export function resolveVariantCannabinoids<T extends PotencyLink>(
  variantLinks: readonly T[] | null | undefined,
  productLinks: readonly T[] | null | undefined,
): { readonly links: readonly T[], readonly source: IdentitySource } {
  if (variantLinks && variantLinks.length > 0) return { links: variantLinks, source: 'variant' }
  return { links: productLinks ?? [], source: 'product' }
}

/**
 * Who a sale attributes to. The variant's supplier wins, then the product's — this is what
 * keeps two strains bought from two distributors from collapsing onto one supplier in the
 * Phase-12 margin report. Snapshotted onto `SaleLine.supplierId` at sale time and never
 * re-joined afterwards, per the snapshot rule.
 */
export function resolveSupplierId(
  variantSupplierId: string | null | undefined,
  productSupplierId: string | null | undefined,
): string | null {
  return variantSupplierId ?? productSupplierId ?? null
}

/**
 * Is this line cannabinoid-bearing, and therefore 21+?
 *
 * Counts BOTH levels. Keying on the product alone — which is what checkout did before
 * variant links existed — would let a strain that records its potency on the variant slip
 * past the age gate while its product carries no links at all. That is a compliance record,
 * not a UI prompt, so it fails toward asking.
 */
export function bearsCannabinoids(
  variantLinkCount: number,
  productLinkCount: number,
): boolean {
  return variantLinkCount > 0 || productLinkCount > 0
}
