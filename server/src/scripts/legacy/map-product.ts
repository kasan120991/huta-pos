/**
 * Legacy product row -> new-schema shape.
 *
 * The central insight from surveying the legacy data: 312 products collapse to 291 slugs,
 * and every collision group differs by `(concentration, count)` — potency and pack size.
 * That IS the variant axis, so this module produces (productKey, variant) pairs and the
 * caller groups them.
 */

import { type Cents, parseDollarsToCents, slugify, unwrapOrThrow } from '@huta/shared'

import type { LegacyProduct } from './connect.js'

/** Legacy rows that are not products at all. */
export const EXCLUDED_LEGACY_IDS = new Map<number, string>([
  [140, 'Test row (title "Test", supplier 2)'],
  [180, 'Open-price POS mechanism, not a product (646 line items, price 0–499)'],
  [224, 'Clearance open-price POS mechanism, not a product'],
])

/**
 * Accidental duplicates to fold together: ids 35 and 206 are
 * "The Hemp Doctor Delta-8 Cartridge" and "The Hemp Doctor Delta 8 Cartridge" — same
 * price, same (zero) stock, titles differing by one hyphen. Slugify already folds them to
 * the same slug, so grouping handles it; this map exists to record the decision.
 */
export const MERGED_LEGACY_IDS = new Map<number, number>([[206, 35]])

/**
 * Products sold by weight. The legacy "Flower" category holds seven rows, but only these
 * two are actually weighed at the counter — the rest are pre-rolls, blunts and cigarillos
 * sold as units.
 */
export const WEIGHT_TRACKED: ReadonlyMap<number, string> = new Map([
  [151, 'flower'], // Regular Flower, $10/g
  [214, 'premium-flower'], // Moonrock Flower, $15/g
])

/**
 * `on_hand` values that are sentinels rather than counts.
 *   151: 9959 — bulk flower, seeded absurdly high so it never depleted.
 *   284: -2  — oversell drift on Delta 9 THC Lollipops.
 */
export const STOCK_OVERRIDES = new Map<number, number>([
  [151, 0],
  [284, 0],
])

/** `count` values that look like data-entry errors. Imported as-is, but reported. */
export const COUNT_ANOMALIES = new Map<number, string>([
  [249, 'count=30 with concentration=30 → 1mg per gummy; concentration may be per-unit'],
  [204, 'count=13 on a cartridge — almost certainly an on-hand value typed into count'],
  [265, 'count=4 with concentration=3g → 0.75g each'],
])

/** Legacy category id -> seeded category slug. */
export const CATEGORY_MAP: ReadonlyMap<number, string> = new Map([
  [1, 'cartridge'],
  [2, 'disposable'],
  [3, 'edible'],
  [4, 'tincture'],
  [5, 'vape'],
  [6, 'skin-care'],
  [7, 'pet-care'],
  [8, 'flower'],
  [9, 'novelty'],
  [10, 'dab'],
  [11, 'kratom'],
  [12, 'coffee'],
  [13, 'other'],
  [14, 'rolling-papers'],
  [15, 'wraps'],
  [16, 'rolling-trays'],
])

/**
 * Convert a legacy DOUBLE price to integer cents.
 *
 * The legacy column is `double` and the float damage is already visible in the data
 * (`SUM(total)` returns values like `4011.6974999999916`). Rounding to 2dp as a STRING
 * and parsing the decimal digits avoids compounding it — `parseFloat(x) * 100` is exactly
 * the mistake `@huta/shared` exists to prevent.
 */
export function legacyPriceToCents(value: number | null): Cents | null {
  if (value === null || !Number.isFinite(value)) return null
  return unwrapOrThrow(parseDollarsToCents(value.toFixed(2)))
}

/**
 * Build a human-readable variant label from potency and pack size.
 *
 * `concentration_uom` is the discriminator, NOT the category: `mg` means potency (as a
 * package total), `g`/`oz` means package size. Both appear within Cartridge, Disposable
 * and Dab, so keying on category would be wrong.
 */
export function variantLabel(row: LegacyProduct): string | null {
  const parts: string[] = []
  if (row.concentration !== null && row.concentration_uom !== null) {
    parts.push(`${row.concentration}${row.concentration_uom}`)
  }
  if (row.count > 1) {
    parts.push(`${row.count} ct`)
  }
  return parts.length > 0 ? parts.join(' / ') : null
}

/**
 * Per-unit potency in milligrams.
 *
 * `concentration` with `uom = 'mg'` is the potency of the WHOLE PACKAGE — confirmed by
 * id 121's own description ("30mg of Delta 8 THC in each gummy", stored as 600 with
 * count 20) and by image filenames like `naysa-vegan-iso-30-count-25mg.png`. 52 of 58
 * edibles divide to round per-unit values.
 *
 * `g` and `oz` describe package size, not potency, so they yield nothing here.
 */
export function perUnitPotencyMg(row: LegacyProduct): number | null {
  if (row.concentration_uom !== 'mg' || row.concentration === null) return null
  const count = row.count > 0 ? row.count : 1
  return Math.round(row.concentration / count)
}

/** Deterministic SKU. `products.sku` is NULL for all 312 rows, so there is nothing to carry. */
export function legacySku(legacyId: number): string {
  return `LEGACY-${legacyId}`
}

/** The slug that decides which legacy rows become variants of one product. */
export function productSlug(title: string): string {
  return slugify(title)
}
