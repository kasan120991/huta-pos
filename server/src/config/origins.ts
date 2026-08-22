import { networkInterfaces } from 'node:os'

import { env, isProduction } from './env.js'

/**
 * The credentialed-request allowlist, used by BOTH the HTTP CORS middleware and the
 * Socket.IO handshake.
 *
 * It lives here rather than being split out of `CORS_ORIGIN` in two places, because the
 * socket's copy is the security-critical one: a WebSocket upgrade is not subject to the
 * same-origin policy, so `io.ts` checks the Origin header by hand. Two independently
 * derived lists could drift, and the one that drifts open is that one.
 */

/**
 * In DEVELOPMENT ONLY, the app can be served four ways and every one of them is a
 * different origin:
 *
 *   http://localhost:3000          plain `pnpm dev` at the desk
 *   https://localhost:3000         `DEV_TLS=1 pnpm dev` at the desk
 *   https://192.168.1.x:3000       the same, reached from the iPad over the LAN
 *   http://192.168.1.x:3000        a LAN device that does not need a secure context
 *
 * Enumerating the machine's own addresses means the list self-heals when the Mac's DHCP
 * lease changes — the certs still have to be regenerated (their SANs are baked in), but
 * the allowlist is one less thing to remember. Loopback and private ranges only: this
 * must never widen to a public address, and it never runs in production at all.
 */
export function lanAddresses(): string[] {
  const found: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      // RFC 1918 only.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) {
        found.push(address.address)
      }
    }
  }
  return found
}

/**
 * Pure so the production branch can be asserted directly. The one property that must
 * never regress: with `production` true the result is EXACTLY what `CORS_ORIGIN` names,
 * with nothing added — a dev convenience that leaked into production would hand a
 * credentialed session to any origin on the list.
 */
export function buildAllowedOrigins(
  corsOrigin: string,
  production: boolean,
  lan: string[] = [],
): string[] {
  const configured = corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0)

  if (production) return [...new Set(configured)]

  const development = ['localhost', '127.0.0.1', ...lan].flatMap((host) => [
    `http://${host}:3000`,
    `https://${host}:3000`,
  ])

  return [...new Set([...configured, ...development])]
}

export const allowedOrigins: string[] = buildAllowedOrigins(
  env.CORS_ORIGIN,
  isProduction,
  lanAddresses(),
)
