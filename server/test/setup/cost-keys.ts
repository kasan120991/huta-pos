/**
 * The cost-leak walker, in one place.
 *
 * House rule: "Never include cost, margin, or supplier pricing in a response to a staff
 * principal. Strip it server-side; do not hide it in the UI." Asserting that on one known
 * key proves nothing — a nested include is exactly how cost would leak — so the check walks
 * the whole payload looking for anything cost-shaped.
 *
 * THE BOUNDARY THAT USED TO BE HERE DID NOT WORK. The original pattern was
 * `/(^|[^a-z])(cost|margin|...)/i`, and under the `i` flag `[^a-z]` case-folds to "not a
 * letter at all" — so a camelCase key never satisfied it. `costCents` matched, but
 * `unitCostCents`, `avgUnitCostCents`, `totalCostCents` and `grossMargin` all sailed
 * through. Every cost field added in phase 7 is camelCase-embedded, so the guard would have
 * passed while proving nothing.
 *
 * A bare substring match is the right instrument. It is deliberately over-eager: a false
 * positive costs one renamed test fixture, while a false negative costs a cost leak that
 * nobody notices until a staff member reads a margin off a screen.
 */
const COST_SHAPED = /(cost|margin|wholesale|landed)/i

/** Every path in `value` whose key looks like it carries cost. */
export function findCostKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, i) => findCostKeys(item, `${path}[${i}]`))

  const hits: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (COST_SHAPED.test(key)) hits.push(`${path}.${key}`)
    hits.push(...findCostKeys(child, `${path}.${key}`))
  }
  return hits
}
