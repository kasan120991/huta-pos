/**
 * Cannabinoid extraction.
 *
 * Two sources, used in order:
 *
 * 1. `products.cannabinoids` — a JSON array of NAME strings (not ids). It has three
 *    distinct "empty" encodings that all occur in the data: SQL `NULL` (149 rows), `[]`
 *    (24 rows), and the literal four-character string `"null"` (18 rows).
 * 2. The product TITLE, with the brand prefix stripped. 61% of the catalog has no
 *    cannabinoid column data at all, and title parsing recovers roughly 78 products —
 *    taking coverage from about 39% to 64%.
 */

import { CANNABINOID_SLUGS } from '@huta/shared'

/**
 * Token → canonical slug.
 *
 * Longest-first at match time, so `delta-10` is tested before `delta-1` would be, and
 * `thc-p` before `thc`.
 */
const ALIASES: ReadonlyArray<readonly [pattern: string, slug: string]> = [
  ['delta-8', 'delta-8'],
  ['delta 8 thc', 'delta-8'],
  ['delta 8', 'delta-8'],
  ['d8', 'delta-8'],
  ['delta-9', 'delta-9'],
  ['delta 9 thc', 'delta-9'],
  ['delta 9', 'delta-9'],
  ['d9', 'delta-9'],
  ['delta-10', 'delta-10'],
  ['delta 10', 'delta-10'],
  ['d10', 'delta-10'],
  ['delta-11', 'delta-11'],
  ['delta 11', 'delta-11'],
  // HXY-11 IS 11-hydroxy-THC; these are the same molecule under different marketing names.
  ['hxy-11', 'hxy-11'],
  ['hxy11', 'hxy-11'],
  ['11-hydroxy-thc', 'hxy-11'],
  ['11-hydroxy', 'hxy-11'],
  ['thc-a', 'thc-a'],
  ['thca', 'thc-a'],
  // "THC-Oa" is a typo for THC-O in id 161; "THC-POV" a typo for THC-P in id 243.
  ['thc-oa', 'thc-o'],
  ['thc-pov', 'thc-p'],
  ['thc-o', 'thc-o'],
  ['thco', 'thc-o'],
  ['thc-p', 'thc-p'],
  ['thc-v', 'thc-v'],
  ['thcv', 'thc-v'],
  ['thc-h', 'thc-h'],
  ['thc-x', 'thc-x'],
  ['hhc-o', 'hhc-o'],
  ['hhc-p', 'hhc-p'],
  ['hhc', 'hhc'],
  ['phc', 'phc'],
  ['cbd', 'cbd'],
  ['cbn', 'cbn'],
  ['cbg', 'cbg'],
  ['cbc', 'cbc'],
]

const SORTED = [...ALIASES].sort((a, b) => b[0].length - a[0].length)

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ′']/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse the legacy JSON column. Returns canonical slugs.
 *
 * Order in the source array is unstable (`["THC-O","Delta-8"]` and `["Delta-8","THC-O"]`
 * both occur), so the result is a deduplicated set.
 */
export function parseCannabinoidColumn(raw: string | null): string[] {
  if (raw === null) return []
  const trimmed = raw.trim()
  // All three empty encodings.
  if (trimmed === '' || trimmed === '[]' || trimmed === 'null') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const found = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const slug = matchToken(normalize(entry))
    if (slug) found.add(slug)
  }
  return [...found]
}

/** Exact-ish match for a single token from the JSON column. */
function matchToken(normalized: string): string | null {
  for (const [pattern, slug] of SORTED) {
    if (normalized === pattern) return slug
  }
  // "Isolate" is in the legacy lookup table but describes a form, not a cannabinoid.
  return null
}

/**
 * Parse cannabinoids out of a product title.
 *
 * `text` should already have the brand prefix removed — otherwise
 * `The Hemp Doctor Nighttime Gummies` and `The Hemp Doctor Kayo Cartridge` produce false
 * hits from the brand name alone.
 *
 * NOTE: `hemp` is never a match token. It appears in brand names (`The Hemp Doctor`,
 * `High Hemp`, `Twisted Hemp`, `Hempire`, `Metta Hemp`) far more often than it signals
 * anything about cannabinoid content.
 */
export function parseCannabinoidsFromTitle(text: string): string[] {
  const normalized = normalize(text)
  const found = new Set<string>()

  for (const [pattern, slug] of SORTED) {
    if (found.has(slug)) continue
    // Word-boundary match so "d8" does not fire inside "d80" and "cbd" does not fire
    // inside "cbdmadeeasy".
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(normalized)) {
      found.add(slug)
    }
  }
  return [...found]
}

/** Every slug this module can emit must exist in the seeded Cannabinoid table. */
export function assertAliasesAreSeeded(): void {
  const seeded = new Set(CANNABINOID_SLUGS)
  const unknown = [...new Set(ALIASES.map(([, slug]) => slug))].filter((s) => !seeded.has(s))
  if (unknown.length > 0) {
    throw new Error(
      `Cannabinoid alias map emits slugs missing from CANNABINOID_SEED: ${unknown.join(', ')}`,
    )
  }
}
