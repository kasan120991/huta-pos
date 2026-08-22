import { describe, expect, it } from 'vitest'

import { normalizePairingCode, pairingCode, pinLookup, randomToken, sha256, timingSafeEqual } from '../src/lib/crypto.js'
import { hashSecret, verifySecret } from '../src/lib/password.js'
import { signAccessToken, verifyAccessToken } from '../src/lib/tokens.js'

describe('pinLookup', () => {
  it('is deterministic — the same PIN always yields the same lookup', () => {
    // This is what makes the value indexable and unique-constrainable. If it were not
    // stable, a staff member could never be found by their PIN.
    expect(pinLookup('1234')).toBe(pinLookup('1234'))
  })

  it('differs for different PINs', () => {
    expect(pinLookup('1234')).not.toBe(pinLookup('1235'))
  })

  it('does not reveal the PIN', () => {
    expect(pinLookup('1234')).not.toContain('1234')
    expect(pinLookup('1234')).toHaveLength(64)
  })
})

describe('password / PIN hashing', () => {
  it('produces an argon2id hash', async () => {
    // The `algorithm` option is deliberately unset because the library's `Algorithm`
    // export is an ambient const enum that cannot be imported under verbatimModuleSyntax.
    // This assertion is what guarantees the default has not drifted to argon2i or argon2d.
    const hash = await hashSecret('correct horse battery staple')
    expect(hash.startsWith('$argon2id$')).toBe(true)
  })

  it('round-trips', async () => {
    const hash = await hashSecret('s3cret')
    expect(await verifySecret(hash, 's3cret')).toBe(true)
    expect(await verifySecret(hash, 's3cre7')).toBe(false)
  })

  it('salts — the same input hashes differently every time', async () => {
    expect(await hashSecret('same')).not.toBe(await hashSecret('same'))
  })

  it('returns false rather than throwing on a corrupt hash', async () => {
    // A corrupt row must read as "wrong credential", never as a 500 that tells an
    // attacker they found something unusual.
    expect(await verifySecret('not-a-hash', 'anything')).toBe(false)
    expect(await verifySecret('', 'anything')).toBe(false)
  })
})

describe('timingSafeEqual', () => {
  it('compares equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
  })

  it('rejects different strings of equal length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false rather than throwing on a length mismatch', () => {
    // node's timingSafeEqual throws on unequal buffer lengths; a CSRF check must not 500.
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
  })
})

describe('pairing codes', () => {
  it('avoids characters people misread', () => {
    // No I, L, O or U — a code read aloud over the phone must not be ambiguous.
    for (let i = 0; i < 200; i += 1) {
      expect(pairingCode()).not.toMatch(/[ILOU]/)
    }
  })

  it('normalises case and separators so a typed code matches', () => {
    const code = pairingCode()
    expect(normalizePairingCode(code.toLowerCase())).toBe(normalizePairingCode(code))
    expect(normalizePairingCode('k4m2-9xqt')).toBe('K4M29XQT')
    expect(normalizePairingCode('K4M2 9XQT')).toBe('K4M29XQT')
  })

  it('is unpredictable', () => {
    const seen = new Set(Array.from({ length: 500 }, () => pairingCode()))
    expect(seen.size).toBeGreaterThan(495)
  })
})

describe('randomToken', () => {
  it('is url-safe and unique', () => {
    const tokens = Array.from({ length: 500 }, () => randomToken())
    expect(new Set(tokens).size).toBe(500)
    for (const token of tokens.slice(0, 20)) expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('sha256', () => {
  it('is a stable 64-char hex digest', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const token = await signAccessToken({
      sub: 'u-1',
      kind: 'staff',
      storeId: 's-1',
      terminalId: 't-1',
    })
    const claims = await verifyAccessToken(token)
    expect(claims).toEqual({ sub: 'u-1', kind: 'staff', storeId: 's-1', terminalId: 't-1' })
  })

  it('returns null for a tampered token rather than throwing', async () => {
    const token = await signAccessToken({
      sub: 'u-1',
      kind: 'admin',
      storeId: null,
      terminalId: null,
    })
    expect(await verifyAccessToken(`${token}x`)).toBeNull()
    expect(await verifyAccessToken('garbage')).toBeNull()
    expect(await verifyAccessToken('')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await signAccessToken(
      { sub: 'u-1', kind: 'admin', storeId: null, terminalId: null },
      -10,
    )
    expect(await verifyAccessToken(token)).toBeNull()
  })

  it('rejects an unsigned (alg: none) token', async () => {
    // Algorithm confusion is the classic JWT failure. jose is given an explicit
    // allowlist, so a header claiming `none` must not be accepted.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u-1', kind: 'admin', iss: 'huta-pos' }),
    ).toString('base64url')
    expect(await verifyAccessToken(`${header}.${payload}.`)).toBeNull()
  })
})
