import type { IntentInfo, PaymentProvider, WebhookEvent } from './provider.js'

/**
 * In-memory provider for tests (via `setPaymentProvider`) and keyless development.
 *
 * Intents are created `requires_payment_method` and flipped by `succeed()` — the same
 * two-step shape as the real flow, so a test that forgets to "confirm" fails the same
 * way an unconfirmed card would. Refund calls are logged so tests can assert the
 * auto-refund-on-rollback path actually fired.
 */
export class FakePaymentProvider implements PaymentProvider {
  private seq = 0
  private readonly intents = new Map<
    string,
    { status: string; amountCents: number; metadata: Record<string, string> }
  >()
  /** Every refund() call, in order — assertable. */
  readonly refunds: Array<{ paymentIntentId: string; amountCents: number; refundId: string }> = []
  private failRefunds = 0

  async createIntent(input: {
    amountCents: number
    metadata: Record<string, string>
  }): Promise<{ id: string; clientSecret: string }> {
    const id = `pi_fake_${++this.seq}`
    this.intents.set(id, {
      status: 'requires_payment_method',
      amountCents: input.amountCents,
      metadata: input.metadata,
    })
    return { id, clientSecret: `${id}_secret` }
  }

  /** The test's stand-in for the customer confirming with Elements. */
  succeed(id: string): void {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`FakePaymentProvider: no such intent ${id}`)
    intent.status = 'succeeded'
  }

  /** The next `count` refund() calls report failure (default 1). */
  failNextRefund(count = 1): void {
    this.failRefunds = count
  }

  async retrieveIntent(id: string): Promise<IntentInfo> {
    const intent = this.intents.get(id)
    if (!intent) throw new Error(`FakePaymentProvider: no such intent ${id}`)
    return {
      id,
      status: intent.status,
      amountCents: intent.amountCents,
      currency: 'usd',
      cardBrand: 'visa',
      cardLast4: '4242',
      metadata: intent.metadata,
    }
  }

  async cancelIntent(id: string): Promise<void> {
    const intent = this.intents.get(id)
    if (intent && intent.status !== 'succeeded') intent.status = 'canceled'
  }

  async refund(input: {
    paymentIntentId: string
    amountCents: number
  }): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }> {
    const refundId = `re_fake_${this.refunds.length + 1}`
    this.refunds.push({ ...input, refundId })
    if (this.failRefunds > 0) {
      this.failRefunds -= 1
      return { refundId, status: 'failed' }
    }
    return { refundId, status: 'succeeded' }
  }

  verifyWebhook(rawBody: Buffer, signature: string): WebhookEvent {
    if (signature !== 'test-signature') throw new Error('Bad test signature.')
    return JSON.parse(rawBody.toString('utf8')) as WebhookEvent
  }
}
