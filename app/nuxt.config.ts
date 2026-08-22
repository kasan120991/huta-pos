import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'

/**
 * Opt-in TLS for the dev server: `DEV_TLS=1 pnpm dev`.
 *
 * Needed ONLY for camera barcode scanning on a real device — browsers expose
 * getUserMedia solely on secure origins, and the iPad reaches this machine at
 * http://192.168.x.x:3000, which is not one. `localhost` is always a secure context, so
 * everyday desktop dev stays plain HTTP and nothing changes unless the flag is set.
 *
 * The cert lives in app/.certs (generated with openssl; SANs cover localhost and the
 * LAN IP — regenerate if the Mac's address changes). The iPad must trust the CA once:
 * AirDrop .certs/ca.pem to it → install the profile (Settings → General → VPN & Device
 * Management) → enable full trust (Settings → General → About → Certificate Trust
 * Settings). NEVER commit .certs — this repo has no git today, but the keys are local
 * secrets all the same.
 */
const certDir = fileURLToPath(new URL('.certs', import.meta.url))
const devTls =
  process.env['DEV_TLS'] === '1' &&
  existsSync(`${certDir}/dev.key`) &&
  existsSync(`${certDir}/dev.pem`)

export default defineNuxtConfig({
  compatibilityDate: '2026-08-18',
  devtools: { enabled: true },

  /**
   * SPA. Nothing here is public and there is no SEO argument, so server rendering would
   * buy a faster first paint at the cost of forwarding session cookies from the server
   * context — a well-known source of subtle auth bugs.
   */
  ssr: false,

  /**
   * Port 3000 is NOT arbitrary. The API's CORS_ORIGIN is `http://localhost:3000` and the
   * Socket.IO handshake checks Origin against the same allowlist. Moving this silently
   * breaks both.
   *
   * Host 0.0.0.0 exposes the dev server on the LAN so real devices (the iPad, a register)
   * can hit it at http://<mac-ip>:3000. Only Nuxt is exposed — a device's /api calls go
   * through the Nitro proxy below, so the API itself stays on localhost and cookies stay
   * same-origin. Cookies are `secure` only in production, so plain HTTP works here.
   */
  devServer: {
    host: '0.0.0.0',
    port: 3000,
    ...(devTls
      ? {
          https: {
            key: readFileSync(`${certDir}/dev.key`, 'utf8'),
            cert: readFileSync(`${certDir}/dev.pem`, 'utf8'),
          },
        }
      : {}),
  },

  nitro: {
    devProxy: {
      /**
       * Proxy rather than calling :3001 directly, so the browser only ever sees one
       * origin and session cookies are same-origin — no SameSite edge cases, no CORS
       * preflights, and no requirement that the API be a subdomain of the app in
       * production.
       *
       * NO path rewrite. The refresh cookie is scoped to `path=/api/auth`; a proxy that
       * rewrites the path drops it silently and every refresh 401s.
       */
      '/api': {
        /**
         * The scheme follows DEV_TLS. Under the flag the API serves TLS from the SAME
         * cert pair this dev server uses (see server/src/index.ts) — one flag, both
         * origins secure — so a hardcoded `http://` target would 502 every request.
         *
         * `secure: false` because that cert is self-signed: Node rejects it by default
         * and the proxy fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. This is a
         * SERVER-TO-SERVER hop on loopback in development only; the browser's own trust
         * decision is separate and unaffected.
         */
        target: `${devTls ? 'https' : 'http'}://localhost:3001/api`,
        ...(devTls ? { secure: false } : {}),
        changeOrigin: true,
        cookieDomainRewrite: '',
      },

      /**
       * NOTE: Socket.IO is deliberately NOT proxied — routing a long-lived polling
       * connection through Nitro's dev proxy crash-loops the dev server. The client
       * connects straight to :3001 in development, mirroring the page's own scheme.
       */
    },
  },

  modules: ['shadcn-nuxt', '@pinia/nuxt'],

  shadcn: {
    prefix: '',
    componentDir: './app/components/ui',
  },

  css: ['~/assets/css/tailwind.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  runtimeConfig: {
    public: {
      // Same-origin by default because of the proxy above.
      apiBase: '/api',
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },
})
