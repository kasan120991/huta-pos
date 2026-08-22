import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/setup/global.ts'],
          /*
           * Point the whole project at a SEPARATE database. Set here rather than relying
           * on globalSetup mutating process.env — that runs in a different context from
           * the test workers, and `db/client.ts` reads DATABASE_URL at module load, so a
           * worker would otherwise connect to the dev database and truncate the catalog.
           */
          env: {
            DATABASE_URL: 'postgresql://huta:huta@localhost:55432/huta_pos_test?schema=public',
            /*
             * Stripe is STUBBED in tests, whatever the developer's .env holds. Real test
             * keys landed in server/.env for the live E2E, and without this the config
             * endpoint's "unconfigured" test read them. Vitest env can only set, not
             * delete — env.ts treats an empty string as unset for exactly this reason.
             */
            STRIPE_SECRET_KEY: '',
            STRIPE_PUBLISHABLE_KEY: '',
            STRIPE_WEBHOOK_SECRET: '',
          },
          // One database, one writer. Parallel files would truncate each other's rows
          // mid-test, which produces failures that look like logic bugs.
          fileParallelism: false,
          testTimeout: 30_000,
          /*
           * Must be raised ALONGSIDE testTimeout, not left at the 10s default.
           *
           * Every integration test does its real setup in `beforeEach` — a TRUNCATE of 42
           * tables plus fixtures — so the hook, not the test body, is what runs long. With
           * only testTimeout raised, a slow truncate blew the 10s hook limit and aborted
           * mid-reset; the NEXT test then started against stale rows and failed on a unique
           * constraint. Two unrelated-looking failures, one cause, and both of them
           * intermittent enough to look like flaky logic.
           */
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
