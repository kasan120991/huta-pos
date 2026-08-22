import cookieParser from 'cookie-parser'
import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'

import { principalFromUser } from '../auth/auth.service.js'
import type { Principal } from '../auth/principal.js'
import { principalFromDeviceToken } from '../auth/terminal.service.js'
import { allowedOrigins } from '../config/origins.js'
import { COOKIE } from '../lib/cookies.js'
import { verifyAccessToken } from '../lib/tokens.js'

/**
 * Socket.IO with an authenticated handshake.
 *
 * Rooms: `store:{storeId}` for store-scoped events, `admin` for global. A socket that
 * cannot be authenticated joins nothing and is rejected.
 */

export const ADMIN_ROOM = 'admin'
export const storeRoom = (storeId: string): string => `store:${storeId}`
export const userRoom = (userId: string): string => `user:${userId}`
export const terminalRoom = (terminalId: string): string => `terminal:${terminalId}`

function isAllowedOrigin(origin: string | undefined): boolean {
  // A missing Origin is a non-browser client (a kiosk wrapper, a test). Browsers always
  // send one on a WebSocket upgrade.
  if (origin === undefined) return true
  return allowedOrigins.includes(origin)
}

async function principalFromCookies(
  cookies: Record<string, string | undefined>,
): Promise<Principal | null> {
  const deviceToken = cookies[COOKIE.DEVICE]
  const terminal = deviceToken ? await principalFromDeviceToken(deviceToken) : null

  const accessToken = cookies[COOKIE.ACCESS]
  const claims = accessToken ? await verifyAccessToken(accessToken) : null

  if (claims) {
    const principal = await principalFromUser(
      claims.sub,
      terminal?.terminalId ?? claims.terminalId,
      terminal?.storeId ?? null,
    )
    if (principal) return principal
  }
  return terminal
}

export function createIo(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  })

  io.engine.use(cookieParser())

  io.use((socket, next) => {
    void (async () => {
      try {
        // CRITICAL: the `cors` option above governs the HTTP long-polling transport ONLY.
        // A WebSocket upgrade is NOT subject to the same-origin policy, and the browser
        // will attach our cookies to it from any origin. Without this explicit check,
        // every socket event is readable by any website a staff member happens to visit
        // — cross-site WebSocket hijacking. Do not remove it because "cors is configured".
        if (!isAllowedOrigin(socket.handshake.headers.origin)) {
          next(new Error('FORBIDDEN_ORIGIN'))
          return
        }

        const cookies =
          (socket.request as { cookies?: Record<string, string | undefined> }).cookies ?? {}
        const principal = await principalFromCookies(cookies)

        if (!principal) {
          next(new Error('UNAUTHORIZED'))
          return
        }

        socket.data.principal = principal
        next()
      } catch {
        // Never surface the real reason — it would distinguish "expired" from "forged".
        next(new Error('UNAUTHORIZED'))
      }
    })()
  })

  io.on('connection', (socket) => {
    const principal = socket.data.principal as Principal

    if (principal.kind === 'admin') socket.join(ADMIN_ROOM)
    if (principal.storeId !== null) socket.join(storeRoom(principal.storeId))
    if (principal.userId !== null) socket.join(userRoom(principal.userId))
    if (principal.terminalId !== null) socket.join(terminalRoom(principal.terminalId))
  })

  return io
}

/**
 * Force-disconnect every socket in a room.
 *
 * An access token is a signed JWT and cannot be revoked before it expires, but a socket
 * opened with one would otherwise live forever. Revocation paths — logout-all,
 * deactivating a terminal, disabling a user — call this so the live connection dies
 * immediately rather than lingering until someone reconnects.
 */
export function revokeSockets(io: Server, room: string): void {
  io.in(room).disconnectSockets(true)
}
