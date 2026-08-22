import { HutaPreset } from './app/assets/theme'

export default defineNuxtConfig({
  compatibilityDate: '2025-08-15',
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
   */
  devServer: { port: 3000 },

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
        target: 'http://localhost:3001/api',
        changeOrigin: true,
        cookieDomainRewrite: '',
      },

      /**
       * NOTE: Socket.IO is deliberately NOT proxied. See `plugins/socket.client.ts` — in
       * development the client connects straight to the API on :3001, because routing a
       * long-lived polling connection through Nitro's dev proxy crash-loops the dev server.
       */
    },
  },

  modules: ['@primevue/nuxt-module', '@pinia/nuxt'],

  primevue: {
    options: {
      theme: {
        preset: HutaPreset,
        options: {
          // A class selector, not `system`: a POS runs under fixed store lighting, so
          // staff should pick rather than inherit whatever the OS decided.
          darkModeSelector: '.app-dark',
          cssLayer: false,
        },
      },
    },
  },

  /**
   * PrimeIcons supplies the `pi pi-*` glyphs. Without this stylesheet those classes render
   * an empty element — PrimeVue still reserves the icon slot, so a Button with an icon shows
   * a stray gap rather than anything visibly missing, which is how two of them survived
   * unnoticed through phases 7a and 7b.
   */
  css: ['~/assets/base.css', 'primeicons/primeicons.css'],

  runtimeConfig: {
    public: {
      // Same-origin by default because of the proxy above.
      apiBase: '/api',

      /**
       * PrimeVue 5 licence key.
       *
       * This MUST be declared here even though the value comes from
       * NUXT_PUBLIC_PRIMEUI_LICENSE in app/.env — Nuxt only applies a NUXT_* environment
       * override to a key that already exists in runtimeConfig. Leaving it undeclared
       * silently ignores the env var and every page renders an "Invalid PrimeUI License"
       * badge.
       */
      PRIMEUI_LICENSE: '',
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },
})
