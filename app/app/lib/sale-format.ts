import type { BaseQuantity, Cents, TrackingMode } from '@huta/shared'
import { formatCents, formatQuantity } from '@huta/shared'

/**
 * The vocabulary every sales surface shares — the receipt, the return screen, the register
 * history and the back-office ledger all render the same facts and had all grown their own
 * copy of these.
 *
 * Formatting money and quantities goes through `@huta/shared` rather than `Intl`: the house rules
 * requires the server and the register to format identically and receipts to be byte-stable,
 * and a bare number without its unit is how a 2-item sale ends up displayed as 2 grams.
 */

/** `#0042`. Sale numbers are PER STORE, so this is only unique alongside the store. */
export const saleNumber = (n: number): string => `#${String(n).padStart(4, '0')}`

export const money = (cents: number): string => formatCents(cents as Cents)

export const quantity = (base: number, mode: TrackingMode): string =>
  formatQuantity(base as BaseQuantity, mode)

/**
 * A quantity that has to stand ALONE, so it names its unit.
 *
 * `formatQuantity` gives a WEIGHT its "g" but leaves an EACH count bare, which is right
 * beside a product name and wrong on its own — "1 given back" does not say one of what.
 * Weights are untouched; only counts gain a noun.
 */
export function quantityWithUnit(base: number, mode: TrackingMode): string {
  const formatted = quantity(base, mode)
  if (mode !== 'EACH') return formatted
  return `${formatted} ${base === 1 ? 'item' : 'items'}`
}

/** "Regular Flower · 1g", collapsing the label when it just repeats the product name. */
export function lineName(line: {
  productName: string
  variantLabel: string | null
}): string {
  return line.variantLabel && line.variantLabel !== line.productName
    ? `${line.productName} · ${line.variantLabel}`
    : line.productName
}

/**
 * The rate a weight line was priced at, as a DESCRIPTION of the charge.
 *
 * Never multiply it back: `extendTier` charges the total the admin typed at a tier
 * threshold and floors just above it, so rate × quantity does not reproduce `grossCents`
 * on most tiers. It is here to answer "why was 3.50 g $30.00?", nothing more.
 */
export function rateLabel(pricePerGramCents: number | null): string | null {
  return pricePerGramCents === null ? null : `${money(pricePerGramCents)}/g`
}

/** Trailing zeros trimmed: 400 bps reads "4%", 825 reads "8.25%". */
export const taxLabel = (bps: number): string =>
  `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`

/**
 * A sale's status as a badge. COMPLETED renders NOTHING on purpose — the ordinary case
 * should not wear a label, or the exceptional ones stop standing out.
 */
export const STATUS_BADGE: Record<string, { label: string, class: string }> = {
  VOIDED: { label: 'Voided', class: 'bg-destructive/15 text-destructive' },
  REFUNDED: { label: 'Refunded', class: 'bg-amber-500/15 text-amber-500' },
  PARTIALLY_REFUNDED: { label: 'Part refunded', class: 'bg-amber-500/15 text-amber-500' },
}

/** How a refund actually landed. A FAILED one moved no money but kept its restock. */
export function refundStatusNote(status: string): string | null {
  if (status === 'FAILED') return 'failed — no money moved'
  if (status === 'PENDING') return 'pending'
  return null
}
