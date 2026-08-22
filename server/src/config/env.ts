import 'dotenv/config'

import { z } from 'zod'

/**
 * Environment validation.
 *
 * Fails fast and loudly at boot rather than at the first request that needs a secret.
 * A POS that starts successfully and then cannot verify a PIN at 8am is worse than one
 * that refuses to start at all.
 */

/**
 * An optional secret where EMPTY MEANS UNSET. `STRIPE_SECRET_KEY=` in a .env (or a test
 * harness blanking a var it cannot delete) must read as "not configured", not as a
 * present-but-empty key that half-enables the feature.
 */
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /** Signs access tokens. Rotating it logs everyone out, which is survivable. */
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters — generate one, do not invent it'),

  /**
   * Peppers the deterministic PIN lookup: pinLookup = HMAC-SHA256(pin, PIN_PEPPER).
   *
   * NOT survivable to rotate. Changing this value invalidates EVERY staff and admin PIN
   * in the database at once, because the stored lookup values were derived with the old
   * pepper and can never be recomputed from the argon2 hashes. Treat it as permanent; if
   * it ever must change, every PIN has to be reset by hand.
   */
  PIN_PEPPER: z
    .string()
    .min(32, 'PIN_PEPPER must be at least 32 characters — and can never be changed'),

  /** Origin allowed to send credentialed requests. The Nuxt app in development. */
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  /**
   * Stripe — all OPTIONAL so a keyless dev environment still boots; the payment
   * provider throws a clear "Stripe is not configured" the moment a card is attempted.
   * The secret key is server-side ONLY. The publishable key is the one Stripe value the
   * client ever sees, served via GET /api/payments/config.
   */
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_PUBLISHABLE_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
})

export type Env = z.infer<typeof schema>

function load(): Env {
  const result = schema.safeParse(process.env)
  if (result.success) return result.data

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')

  // Deliberately verbose: this is the error a new developer hits first, and
  // "invalid environment" with no detail wastes an afternoon.
  throw new Error(
    `Invalid environment configuration.\n\n${problems}\n\n` +
      'server/.env.example is the template. Generate secrets with:\n' +
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"\n",
  )
}

export const env = load()

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
