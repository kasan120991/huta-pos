import type { Stripe } from '@stripe/stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import type { PaymentsConfig } from '@huta/shared/schemas'
import { apiFetch } from '~/composables/useApi'

/**
 * Stripe.js, lazily. The publishable key comes from the server (`/payments/config`) so
 * the app needs no Stripe environment of its own; a null key means Stripe is not
 * configured and the register disables the Card tender instead of failing at charge
 * time. Both promises are module-level so the config is fetched and Stripe.js loaded at
 * most once per session.
 */

let configPromise: Promise<PaymentsConfig> | null = null
let stripePromise: Promise<Stripe | null> | null = null

export function paymentsConfig(): Promise<PaymentsConfig> {
  configPromise ??= apiFetch<PaymentsConfig>('/payments/config')
  return configPromise
}

export async function getStripe(): Promise<Stripe | null> {
  const config = await paymentsConfig()
  if (!config.publishableKey) return null
  stripePromise ??= loadStripe(config.publishableKey)
  return stripePromise
}
