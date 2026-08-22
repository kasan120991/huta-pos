import { env } from '../config/env.js'
import { StripeProvider } from './stripe.provider.js'

/**
 * Every card interaction goes through this interface — the house rule so Stripe
 * Terminal can replace Stripe Elements later without touching sale or refund logic, and
 * so tests swap in a fake instead of stubbing the Stripe SDK.
 *
 * Resolution follows the emitter's injection pattern: `setPaymentProvider` is the test
 * hook, and the default constructs a StripeProvider lazily when a secret key is
 * configured — a keyless dev environment still boots and rings cash, and the first card
 * attempt gets a clear "Stripe is not configured" instead of a crash at import time.
 */

export interface IntentInfo {
  readonly id: string
  /** Stripe's own status string, e.g. 'succeeded', 'requires_payment_method'. */
  readonly status: string
  readonly amountCents: number
  readonly currency: string
  readonly cardBrand: string | null
  readonly cardLast4: string | null
  readonly metadata: Record<string, string>
}

export interface WebhookEvent {
  readonly id: string
  readonly type: string
  readonly payload: unknown
}

export interface PaymentProvider {
  createIntent(input: {
    amountCents: number
    metadata: Record<string, string>
  }): Promise<{ id: string; clientSecret: string }>
  retrieveIntent(id: string): Promise<IntentInfo>
  /** Best-effort — an already-canceled or already-succeeded intent is not an error here. */
  cancelIntent(id: string): Promise<void>
  refund(input: {
    paymentIntentId: string
    amountCents: number
  }): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }>
  /** Throws on a bad signature. */
  verifyWebhook(rawBody: Buffer, signature: string): WebhookEvent
}

let injected: PaymentProvider | null = null
let stripeDefault: PaymentProvider | null = null

/** Test hook (and future Terminal switch). Pass null to restore the default. */
export function setPaymentProvider(next: PaymentProvider | null): void {
  injected = next
}

export function getPaymentProvider(): PaymentProvider {
  if (injected) return injected
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error(
      'Stripe is not configured. Set STRIPE_SECRET_KEY (and STRIPE_PUBLISHABLE_KEY) in server/.env to take card payments.',
    )
  }
  stripeDefault ??= new StripeProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
  return stripeDefault
}
