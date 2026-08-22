import { type Socket, io } from 'socket.io-client'

/**
 * The realtime connection.
 *
 * `.client.ts` because this is an SPA and there is no server context to open a socket from.
 *
 * House rule: "Treat every socket payload as a hint to refetch or as a display-only
 * notification. Never let a socket event be the only thing that mutates client-side state
 * that matters." Nothing here writes to a store; screens subscribe and refetch.
 *
 * IN DEVELOPMENT THIS DOES NOT GO THROUGH THE `/api` PROXY, unlike every other request.
 *
 * Nitro's dev proxy cannot hold a Socket.IO polling connection: the request stays open for
 * ~25s, and when it closes the proxy writes to a dead socket, dies with
 * `read ECONNRESET` / `write EPIPE`, and takes the entire dev server down with it. Nuxt then
 * restarts, the client reconnects, and it happens again — a crash loop where no page loads.
 *
 * Connecting straight to the API avoids the proxy altogether, and the cookies still arrive:
 * SameSite is evaluated per SITE and ports are not part of a site, so `localhost:3000` and
 * `localhost:3001` are same-site and the `lax` session cookies are sent. CORS and the
 * handshake's own Origin allowlist already name :3000.
 *
 * In production the app and API share an origin, so the default same-origin connect is right
 * and a real reverse proxy handles the websocket upgrade.
 */

export default defineNuxtPlugin(() => {
  const url = import.meta.dev ? 'http://localhost:3001' : undefined

  const socket: Socket = io(url as string, {
    // The cookies are the credential; the handshake reads them server-side.
    withCredentials: true,
    // A register runs all day on shop wifi. Reconnect quietly and indefinitely rather than
    // giving up and leaving the screen silently stale.
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
    // Poll first, then upgrade. Never websocket-only: behind a proxy that does not forward
    // upgrades that fails outright, in a way that reads like an auth bug rather than a
    // transport one.
    transports: ['polling', 'websocket'],
    autoConnect: true,
  })

  // An unauthenticated socket is rejected by design — an unpaired device and a signed-out
  // admin both land here. It is not an error worth showing anyone.
  socket.on('connect_error', (error) => {
    if (import.meta.dev) console.debug('[socket] not connected:', error.message)
  })

  return { provide: { socket } }
})
