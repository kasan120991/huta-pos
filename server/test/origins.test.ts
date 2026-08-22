import { describe, expect, it } from 'vitest'

import { buildAllowedOrigins } from '../src/config/origins.js'

/**
 * The credentialed-request allowlist. `io.ts` checks the Origin header against this list
 * by hand, because a WebSocket upgrade is NOT subject to the same-origin policy and the
 * browser will attach our session cookies to it from anywhere. A list that is too wide is
 * cross-site WebSocket hijacking, so the production branch is asserted exactly.
 */
describe('buildAllowedOrigins', () => {
  it('adds NOTHING to the configured list in production', () => {
    expect(buildAllowedOrigins('https://pos.huta.example', true, ['192.168.1.175'])).toEqual([
      'https://pos.huta.example',
    ])
  })

  it('accepts a comma-separated list and trims it', () => {
    expect(buildAllowedOrigins('https://a.example, https://b.example ,', true)).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('adds both schemes for loopback in development, so DEV_TLS pages are allowed', () => {
    const origins = buildAllowedOrigins('http://localhost:3000', false)

    // The plain-dev origin is still there…
    expect(origins).toContain('http://localhost:3000')
    // …and the DEV_TLS one, whose absence silently killed every socket feature.
    expect(origins).toContain('https://localhost:3000')
    expect(origins).toContain('https://127.0.0.1:3000')
    // No duplicate from CORS_ORIGIN naming an origin the dev list also generates.
    expect(new Set(origins).size).toBe(origins.length)
  })

  it('admits the LAN address in development, for the iPad reaching the Mac', () => {
    const origins = buildAllowedOrigins('http://localhost:3000', false, ['192.168.1.175'])
    expect(origins).toContain('https://192.168.1.175:3000')
  })

  it('never widens to a public address, even if one is passed in', () => {
    // `lanAddresses()` filters to RFC 1918 before this is called; belt and braces.
    const origins = buildAllowedOrigins('http://localhost:3000', true, ['203.0.113.7'])
    expect(origins.some((o) => o.includes('203.0.113.7'))).toBe(false)
  })
})
