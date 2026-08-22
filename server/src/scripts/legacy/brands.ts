/**
 * Brand extraction from legacy product titles.
 *
 * The legacy database has no brand table — brand exists only as a prefix on
 * `products.title`. About 276 of 312 titles carry one; the rest are accessories and house
 * generics and get no brand at all.
 *
 * Two rules make this work:
 *
 * 1. **Longest match first.** `Sugar Extrax` must beat `Extrax`, `Classic Raw` must beat
 *    `Raw`, and `Twisted Hemp` must beat `Twist`. Aliases are sorted by length descending
 *    at module load so callers cannot get this wrong.
 * 2. **Supplier is not brand.** Supplier 1 ("Binoid CBD") carries 43 products of which
 *    only 28 are Binoid-branded; the rest span Cali Reserve, Dank-Lite, Extrax and
 *    others. Never infer brand from supplier.
 */

export interface BrandDefinition {
  readonly name: string
  /** Title prefixes that identify this brand. The canonical name is matched implicitly. */
  readonly aliases?: readonly string[]
}

/**
 * Curated brand list.
 *
 * Deliberately EXCLUDED as too ambiguous to auto-assign — these fall through to "no
 * brand" and appear in the import report for a human: `Super 6`/`Super 8` (a blend name,
 * not a maker), `Delta-Bombs`, `Moon Slyme`, `Sugar Cartridge`, `Click-It Gun Lighter`,
 * `Lighter Leash`.
 */
export const BRANDS: readonly BrandDefinition[] = [
  { name: 'Naysa' },
  { name: 'Binoid' },
  { name: 'Huta' },
  // One brand under seven spellings in the legacy data.
  {
    name: "Lost8's",
    aliases: ['Lost 8s', "Lost 8's", 'Lost8s', 'Lost9s', 'Lost Gummiez', 'Lost CBD', 'Lost THC-O'],
  },
  { name: 'JustCBD', aliases: ['Just CBD', 'Just Delta', 'Just HHC', 'Just THC-O', 'Just Supreme'] },
  { name: 'The Hemp Doctor' },
  { name: 'King Palm' },
  { name: 'King Royal' },
  { name: 'Space Gods' },
  { name: 'Space Walker' },
  { name: 'Strange Clouds' },
  { name: 'Metta Hemp' },
  { name: 'Treetop Hemp Co' },
  { name: 'Sugar Extrax' },
  { name: 'Goliath x Extrax', aliases: ['Goliath'] },
  { name: 'Extrax', aliases: ['ExtraX'] },
  { name: 'Happi', aliases: ['Happi + Strange Clouds', 'Happi Strange Clouds'] },
  { name: 'Trehouse', aliases: ['TreHouse'] },
  { name: 'Classic Raw' },
  { name: 'Raw' },
  { name: 'Dank-Lite' },
  { name: 'Earth Kratom' },
  { name: 'Yocan' },
  { name: 'Twisted Hemp' },
  { name: 'Twist' },
  { name: 'Rare' },
  { name: 'Cake 1.5' },
  { name: 'Cali Reserve' },
  { name: 'Flying Monkey' },
  { name: 'HoneyRoot' },
  { name: 'Lookah' },
  { name: 'Mellow Fellow' },
  { name: 'Nerds' },
  { name: 'Toast' },
  // Three genuinely different brands sharing a first word. Never match bare "Kush".
  { name: 'Kush Rope' },
  { name: 'Kush Kolectiv' },
  { name: 'Kush Burst' },
  { name: 'High Hemp' },
  { name: 'Hempire' },
  { name: 'Hemp Bombs' },
  { name: 'Wild Hemp' },
  { name: 'Koi' },
  { name: 'KoKo Nuggz' },
  { name: 'Trollii' },
  { name: 'Fieldstone Farms' },
  { name: 'Avaloo' },
  { name: 'No Cap' },
  { name: 'Hangten' },
  { name: 'Herbz Depot' },
  { name: 'Gush Gummies' },
  { name: 'Jahrootz' },
  { name: 'Viva Zen' },
  { name: 'Nodzilla' },
  { name: 'Remarkable Herbs' },
  { name: 'Hush Kratom' },
  { name: 'Pain Out Maxx' },
  { name: 'Xscape' },
  { name: 'Wulf' },
  { name: 'Exus' },
  { name: 'Deez Nutz' },
  { name: 'Delta Labs' },
  { name: 'Skol' },
  { name: 'Loy' },
  { name: 'Runtz' },
  { name: 'Vibez' },
  { name: 'Kayo' },
  { name: 'OCB' },
  { name: 'Job 1.5' },
  { name: 'Mr. Good Guy' },
  { name: 'Diamond Shruumz' },
  { name: "Dr. Greenthumb's" },
  { name: 'Quick Fix' },
  { name: 'Marshall' },
  { name: 'Sandman' },
  { name: 'Caution' },
  { name: 'Klean Lean' },
  { name: 'D8-HI' },
  { name: 'Glow Tray' },
  { name: 'AK Dabber' },
]

/**
 * Normalise a title for prefix matching: fold case, curly apostrophes and dashes, and
 * collapse whitespace. `Lost 8’s` and `Lost8's` must land on the same string.
 */
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

interface CompiledAlias {
  readonly brandName: string
  readonly normalized: string
}

/** Sorted longest-first so `Sugar Extrax` is tested before `Extrax`. */
const COMPILED: readonly CompiledAlias[] = BRANDS.flatMap((brand) =>
  [brand.name, ...(brand.aliases ?? [])].map((alias) => ({
    brandName: brand.name,
    normalized: normalize(alias),
  })),
).sort((a, b) => b.normalized.length - a.normalized.length)

export interface BrandMatch {
  readonly brandName: string
  /**
   * The NORMALIZED title with the brand prefix removed, for downstream cannabinoid
   * parsing. Normalized rather than original because normalisation changes string length
   * — folding `Lost 8’s` drops a character — so slicing the original by a normalized
   * offset would cut in the wrong place. The cannabinoid parser normalises anyway.
   */
  readonly remainder: string
}

/**
 * Identify the brand at the head of a title.
 *
 * Returns null for the ~36 genuinely brandless products (Grinder, Glass Bong, Small Tray,
 * Regular Flower, Stickers…). Those get `brandId: null` rather than a synthetic
 * "Unbranded" row, which would show up in every brand report as a meaningless bucket.
 */
export function matchBrand(title: string): BrandMatch | null {
  const normalized = normalize(title)

  for (const alias of COMPILED) {
    if (normalized === alias.normalized) {
      return { brandName: alias.brandName, remainder: '' }
    }
    if (!normalized.startsWith(alias.normalized)) continue

    // Require a word boundary so "Raw" does not match "Rawhide" — but ANY non-alphanumeric
    // counts, not just a space. Titles like "Just CBD+THC Sour Gummies" and
    // "Just Delta-10 Gummies" put a `+` or `-` immediately after the brand.
    const next = normalized.charAt(alias.normalized.length)
    if (/[a-z0-9]/.test(next)) continue

    return {
      brandName: alias.brandName,
      remainder: normalized.slice(alias.normalized.length + 1),
    }
  }
  return null
}
