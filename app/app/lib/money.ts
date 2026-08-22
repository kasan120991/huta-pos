/**
 * Typed dollars ↔ integer cents, in one place.
 *
 * This function had grown two near-identical copies (`admin/pricing.vue`, `admin/receiving.vue`)
 * that differed only in whether they tolerated a leading `$`. Money parsing is exactly the
 * thing that must not exist twice with a subtle difference, so it lives here now.
 *
 * The rule it exists to enforce, straight out of the project's non-negotiables: **parse the
 * digits, never `Number(x) * 100`.** `19.99 * 100` is `1998.9999999999998`, and a price that
 * is a cent light on every hundredth transaction is the kind of bug nobody reports and
 * everybody eventually reconciles.
 */

/**
 * `"19.99"` → `1999`. Null for anything that is not a plain dollar amount — more than two
 * decimals, a negative, a thousands separator, or empty.
 *
 * Null means "this isn't a dollar amount", which is a different answer from zero. A caller
 * that wants a blank field to mean "not set" must check for the empty string itself, because
 * `""` and `"banana"` are both refused here and only one of them is a deliberate clear.
 */
export function parseDollars(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, frac = ''] = cleaned.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}

/** `1999` → `"19.99"`. The bare figure — no currency symbol, for use inside an input. */
export function dollars(cents: number): string {
  return (cents / 100).toFixed(2)
}
