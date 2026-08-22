import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto'

import { env } from '../config/env.js'

/**
 * Cryptographic primitives.
 *
 * These live in `server/` and not `shared/` because `shared/tsconfig.json` sets
 * `"types": []` — it has no `node:crypto` and no `Buffer`, deliberately, so that package
 * stays safe to import into a browser bundle.
 */

/** SHA-256 hex. For high-entropy tokens we generated ourselves — NOT for passwords or PINs. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The deterministic PIN lookup value.
 *
 * A PIN has to be findable in one indexed query and unique in the database, and an
 * argon2 hash is salted so it can do neither. This HMAC gives both. It is keyed with a
 * server-side pepper, so a database dump alone does not let an attacker map the ~10,000
 * possible 4-digit PINs to users.
 *
 * The pepper can never change — see the comment on PIN_PEPPER in config/env.ts.
 */
export function pinLookup(pin: string): string {
  return createHmac('sha256', env.PIN_PEPPER).update(pin, 'utf8').digest('hex')
}

/** URL-safe random token. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

// Crockford-ish: no I, L, O, U — removes the characters people misread when a code is
// read aloud over the phone or copied off a screen.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Short human-transcribable pairing code, e.g. "K4M2-9XQT". */
export function pairingCode(length = 8): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length))
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * A temporary numeric PIN for a staff reset.
 *
 * `randomInt` rather than `Math.random` because this is a credential, however short-lived.
 *
 * ⚠️ FOUR digits, and that is dictated by the register, not by preference. `zPin` accepts
 * 4–6, but `pages/register/sign-in.vue` fixes its pad at `PIN_LENGTH = 4` and auto-submits
 * on the fourth digit — a deliberate touch affordance. A six-digit temporary PIN is
 * therefore literally unkeyable at a till: the pad fires at four and rejects it. Six was the
 * first thing tried here, precisely because it makes the global `pinLookup` collision a
 * hundred times less likely, and it had to be walked back. If the pad ever grows to accept
 * 4–6 with an explicit submit, this can grow with it.
 *
 * The 10,000-wide space is handled by the retry loop in `user.service.ts`, not by length.
 *
 * Returned to the admin exactly once and never stored in plaintext — the same contract as
 * `pairingCode`.
 */
export function tempPin(): string {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += String(randomInt(10))
  return out
}

/** Normalise a typed pairing code: strip separators, fold case. */
export function normalizePairingCode(input: string): string {
  return input.replace(/[^0-9a-zA-Z]/g, '').toUpperCase()
}

/**
 * Constant-time string comparison.
 *
 * `a === b` on secrets leaks their common prefix length through timing. Length is
 * compared first and non-secretly, which is fine — the length of a token is not the
 * secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return nodeTimingSafeEqual(bufferA, bufferB)
}
