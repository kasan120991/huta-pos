import { existsSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as NodeServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.js'
import { env, isProduction } from './config/env.js'
import { prisma } from './db/client.js'
import { setIo } from './realtime/emitter.js'
import { createIo } from './realtime/io.js'

/**
 * Process entry point. Boot and shutdown only — everything else is in `createApp`, which
 * never listens so tests can mount it directly.
 */

/**
 * Opt-in TLS in DEVELOPMENT, mirroring the Nuxt dev server's own `DEV_TLS=1`.
 *
 * The flag exists for the iPad camera scanner (getUserMedia needs a secure origin), but
 * turning it on used to switch REALTIME OFF: an https page cannot open a socket to a
 * plain-http API, so the client plugin skipped connecting entirely and every socket
 * feature — the transfers toast, the rail's needs-action badge, the receiving desk's
 * variance badge — silently stopped working in the exact mode the docs tell you to run.
 *
 * Serving the API over the SAME cert pair the app uses fixes that: one flag, both
 * origins secure, nothing to choose between. Reuses `app/.certs` deliberately rather
 * than minting a second pair — the SANs (localhost, 127.0.0.1, the LAN IP) are already
 * right, and the iPad has already been made to trust that CA once.
 *
 * ⚠️ The certificate must be trusted for `:3001` as well as `:3000`, and a socket request
 * is a SUBRESOURCE — the browser rejects an untrusted cert silently, with no interstitial
 * to click through. Trust the CA (`app/.certs/ca.pem`) in the system keychain, or visit
 * https://localhost:3001/health once and accept it there.
 *
 * Production never takes this path: TLS is terminated ahead of the process by the
 * platform, and the flag is ignored outright.
 */
const certDir = join(dirname(fileURLToPath(import.meta.url)), '../../app/.certs')

const tls =
  !isProduction &&
  process.env['DEV_TLS'] === '1' &&
  existsSync(join(certDir, 'dev.key')) &&
  existsSync(join(certDir, 'dev.pem'))
    ? {
        key: readFileSync(join(certDir, 'dev.key')),
        cert: readFileSync(join(certDir, 'dev.pem')),
      }
    : null

const app = createApp()
const httpServer: NodeServer = tls ? createHttpsServer(tls, app) : createHttpServer(app)
const io = createIo(httpServer)

// Hand the socket server to the emitter so services can notify without importing it. Until
// this runs — which is never, under test — every emit is a no-op.
setIo(io)

httpServer.listen(env.PORT, () => {
  const scheme = tls ? 'https' : 'http'
  console.log(`huta-pos API listening on ${scheme}://localhost:${env.PORT} (${env.NODE_ENV})`)
  if (tls) {
    console.log(
      '  TLS on (DEV_TLS=1), using app/.certs. If the socket will not connect, the CA is not ' +
        'trusted for :3001 — visit the URL above once and accept it.',
    )
  }
})

/**
 * Graceful shutdown. A POS is mid-transaction more often than most services: dropping
 * connections on deploy can leave a sale recorded with no payment, so in-flight requests
 * are drained before the process exits.
 */
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, draining…`)

  io.close()
  httpServer.close(() => {
    void prisma.$disconnect().then(() => process.exit(0))
  })

  // Backstop: never hang a deploy waiting on a stuck socket.
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
