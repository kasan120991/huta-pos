import Stripe from 'stripe'

import type { IntentInfo, PaymentProvider, WebhookEvent } from './provider.js'

/**
 * The real Stripe implementation, on Elements semantics.
 *
 * `payment_method_types: ['card']` — a register never follows a redirect, so
 * redirect-based methods are excluded outright rather than suppressed client-side.
 * Amounts are the same integer cents used everywhere else; Stripe's `amount` field is
 * already integer minor units, so no conversion happens at this boundary.
 */
export class StripeProvider implements PaymentProvider {
  private readonly stripe: Stripe
  private readonly webhookSecret: string | undefined

  constructor(secretKey: string, webhookSecret: string | undefined) {
    this.stripe = new Stripe(secretKey)
    this.webhookSecret = webhookSecret
  }

  async createIntent(input: {
    amountCents: number
    metadata: Record<string, string>
  }): Promise<{ id: string; clientSecret: string }> {
    const intent = await this.stripe.paymentIntents.create({
      amount: input.amountCents,
      currency: 'usd',
      payment_method_types: ['card'],
      metadata: input.metadata,
    })
    if (!intent.client_secret) {
      // Cannot happen for a card intent created with a secret key, but the type says
      // nullable and a null here must not surface as a client-side undefined.
      throw new Error(`Stripe returned no client secret for intent ${intent.id}.`)
    }
    return { id: intent.id, clientSecret: intent.client_secret }
  }

  async retrieveIntent(id: string): Promise<IntentInfo> {
    const intent = await this.stripe.paymentIntents.retrieve(id, {
      expand: ['latest_charge'],
    })
    const charge =
      intent.latest_charge && typeof intent.latest_charge !== 'string'
        ? intent.latest_charge
        : null
    const card = charge?.payment_method_details?.card ?? null
    return {
      id: intent.id,
      status: intent.status,
      amountCents: intent.amount,
      currency: intent.currency,
      cardBrand: card?.brand ?? null,
      cardLast4: card?.last4 ?? null,
      metadata: intent.metadata ?? {},
    }
  }

  async cancelIntent(id: string): Promise<void> {
    try {
      await this.stripe.paymentIntents.cancel(id)
    } catch {
      // Best-effort by contract: already canceled or already succeeded both mean there
      // is nothing left to cancel, and the caller has no remedy either way.
    }
  }

  async refund(input: {
    paymentIntentId: string
    amountCents: number
  }): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }> {
    const refund = await this.stripe.refunds.create({
      payment_intent: input.paymentIntentId,
      amount: input.amountCents,
    })
    const status =
      refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' ? 'failed' : 'pending'
    return { refundId: refund.id, status }
  }

  verifyWebhook(rawBody: Buffer, signature: string): WebhookEvent {
    if (!this.webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured.')
    }
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    return { id: event.id, type: event.type, payload: event.data.object }
  }
}
