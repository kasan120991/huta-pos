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
 * handshake's own Origin allowlist already name :3000. `location.hostname` rather than a
 * literal `localhost` so the iPad-over-LAN dev setup reaches the Mac's API too.
 *
 * THE SCHEME IS MIRRORED, NOT ASSUMED. `DEV_TLS=1` serves the page over https, and an
 * http://:3001 socket from an https page is mixed content the browser blocks outright.
 * This used to be handled by skipping the connection entirely, which quietly turned
 * realtime OFF in the exact mode the documented setup tells you to run for the iPad
 * camera scanner —
 * the transfers toast and the rail's needs-action badge had therefore never once fired on
 * that setup. The API now serves TLS under the same flag and the same cert pair, so the
 * page's own protocol is the right one to dial.
 *
 * ⚠️ Under DEV_TLS the cert must be trusted for :3001 too. A socket handshake is a
 * SUBRESOURCE request: an untrusted cert fails silently with no interstitial to click
 * through, and the only symptom is `connect_error` in the console. Trust
 * `app/.certs/ca.pem` in the system keychain, or open https://localhost:3001/health once
 * and accept it.
 *
 * Production is unaffected: app and API share one https origin there, and `url` is
 * undefined so socket.io dials the page's own origin through the normal proxy.
 */

export default defineNuxtPlugin(() => {
  const url = import.meta.dev
    ? `${location.protocol}//${location.hostname}:3001`
    : undefined

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
  //
  // A TLS failure is the opposite: it is a broken dev setup that looks like nothing at all.
  // The handshake is a subresource request, so an untrusted certificate gives no
  // interstitial and no visible error — realtime simply never works, which is precisely
  // how it stayed broken under DEV_TLS for weeks. `UNAUTHORIZED` and `FORBIDDEN_ORIGIN`
  // are the server talking, so the transport is fine; anything else on an https dev page
  // after a couple of attempts is almost certainly the cert, and says so once.
  let attempts = 0
  socket.on('connect_error', (error) => {
    if (!import.meta.dev) return
    console.debug('[socket] not connected:', error.message)

    attempts += 1
    const serverSpoke = error.message === 'UNAUTHORIZED' || error.message === 'FORBIDDEN_ORIGIN'
    if (attempts === 3 && !serverSpoke && location.protocol === 'https:') {
      console.warn(
        `[socket] cannot reach ${url ?? 'the API'}. Under DEV_TLS the API's self-signed ` +
          'certificate must be trusted for :3001 as well as :3000 — open ' +
          `${url}/health in this browser once and accept it. Until then every realtime ` +
          'feature (the transfers toast, the needs-action badge) is silently off.',
      )
    }
  })

  return { provide: { socket: socket as Socket | null } }
})
