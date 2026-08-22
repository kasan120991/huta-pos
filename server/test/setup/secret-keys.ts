/**
 * Walks a payload for credential-shaped keys.
 *
 * The sibling of `cost-keys.ts`, and it exists for the same reason: a rule enforced by an
 * explicit Prisma `select` is one refactor away from being broken silently, so the tests
 * assert the absence rather than trusting the select.
 *
 * ⚠️ PLAIN LOWERCASE SUBSTRINGS, deliberately. `cost-keys.ts` carries the scar: its original
 * regex used `/(^|[^a-z])(cost|…)/i`, and under the `i` flag `[^a-z]` case-folds to "not a
 * letter at all" — so it matched `costCents` but never `unitCostCents`. Every camelCase
 * embedding sailed through. Do not reintroduce a word boundary here.
 */
const SECRET_FRAGMENTS = ['passwordhash', 'pinhash', 'pinlookup', 'tokenhash', 'codehash']

export function findSecretKeys(value: unknown, path = '$'): string[] {
  const hits: string[] = []

  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findSecretKeys(item, `${path}[${i}]`)))
    return hits
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase()
      if (SECRET_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
        hits.push(`${path}.${key}`)
      }
      hits.push(...findSecretKeys(child, `${path}.${key}`))
    }
  }
  return hits
}
