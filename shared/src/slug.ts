/**
 * Slug generation.
 *
 * Slugs are the identity of a Product, Category, Brand and Supplier, and they are UNIQUE
 * in the database — so this function decides which records collide and merge. That makes
 * its normalisation rules load-bearing rather than cosmetic.
 *
 * The legacy catalog contains every hazard this has to survive:
 *   - `Lost 8’s Party Pack` (U+2019) and `Lost 8's Party Pack` (U+0027) are the same
 *     product entered twice.
 *   - `Lost8's X Toast Gummies – Delta 8` uses an en dash (U+2013).
 *   - `Dr. Greenthumb's X Stündenglass Gravity Infuser` carries a diacritic.
 *   - `The Hemp Doctor Delta-8 Cartridge` and `... Delta 8 Cartridge` differ by one
 *     hyphen and are the same product.
 */

/**
 * Convert arbitrary text to a URL- and database-safe slug.
 *
 * Apostrophes are DROPPED rather than turned into separators, so `Lost 8's` becomes
 * `lost-8s` rather than `lost-8-s`. Every other non-alphanumeric run collapses to a
 * single hyphen.
 *
 * Diacritics are folded to their base letters via NFKD, so `Stündenglass` becomes
 * `stundenglass` — searchable by someone typing on a US keyboard.
 */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Strip combining marks left behind by NFKD (the umlaut off the u).
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Curly quotes and primes fold to nothing, not to a separator.
      .replace(/[‘’ʼ′']/g, '')
      // Everything else non-alphanumeric becomes a separator. This catches the en/em
      // dashes, ampersands, slashes, plus signs and commas that pepper the legacy titles.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

/**
 * Make a slug unique against a set of slugs already taken, by appending `-2`, `-3`, …
 *
 * Mutates `taken` so successive calls keep converging. Use this only where a collision is
 * genuinely two different things — when two rows SHOULD merge, let the slug collide and
 * group on it instead.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  let suffix = 2
  let candidate = `${base}-${suffix}`
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `${base}-${suffix}`
  }
  taken.add(candidate)
  return candidate
}
