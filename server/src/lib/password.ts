import { hash, verify } from '@node-rs/argon2'

/**
 * Password and PIN hashing.
 *
 * argon2id — memory-hard, so a GPU farm gains far less than it does against bcrypt or
 * PBKDF2. `@node-rs/argon2` ships prebuilt binaries; the `argon2` package needs node-gyp,
 * and this repo has already hit pnpm's build-script approval friction twice.
 */

/**
 * ~64 MiB, 3 passes, parallelism 4 — in the region OWASP recommends for argon2id and
 * roughly 100ms on this hardware. Slow enough to make offline cracking expensive, fast
 * enough that a cashier does not feel it when punching a PIN.
 */
/**
 * `algorithm` is deliberately NOT set. The library's `Algorithm` export is an ambient
 * `const enum`, which cannot be imported under `verbatimModuleSyntax`. Argon2id is the
 * library default, and `password.test.ts` asserts every hash starts with `$argon2id$` so
 * a future default change fails a test rather than silently weakening every credential.
 */
const OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const

export function hashSecret(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS)
}

/**
 * Verify a secret against its hash.
 *
 * Returns false rather than throwing on a malformed hash — a corrupt row must read as
 * "wrong credential", never as a 500 that tells an attacker they found something odd.
 */
export async function verifySecret(hashValue: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(hashValue, plaintext, OPTIONS)
  } catch {
    return false
  }
}
