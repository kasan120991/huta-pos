import type { Request, Response } from 'express'

import { prisma } from '../db/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import { getPaymentProvider } from './provider.js'

/**
 * Stripe webhook — deliberately minimal. Sale completion is NEVER webhook-driven
 * (checkout verifies the intent synchronously); this endpoint exists to (a) record every
 * event in StripeEvent, which is what makes an orphaned charge findable after a crash,
 * and (b) reconcile refund lifecycle updates onto Refund.status.
 *
 * Mounted with express.raw BEFORE the global JSON parser — signature verification needs
 * the exact bytes. Idempotency: StripeEvent's primary key is the event id, so a retry
 * dies on P2002 and is answered 200 without re-applying anything.
 */

const REFUND_STATUS: Record<string, 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'CANCELLED'> = {
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  pending: 'PENDING',
  canceled: 'CANCELLED',
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature']
  if (typeof signature !== 'string') {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Missing signature.' } })
    return
  }

  let event
  try {
    event = getPaymentProvider().verifyWebhook(req.body as Buffer, signature)
  } catch {
    // Bad signature or unconfigured secret — nothing is recorded from an unverified body.
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Bad signature.' } })
    return
  }

  try {
    await prisma.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        payload: event.payload as Prisma.InputJsonValue,
      },
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      // Stripe retried an event we already hold. Acknowledge, change nothing.
      res.json({ received: true, duplicate: true })
      return
    }
    throw error
  }

  if (event.type === 'refund.updated' || event.type === 'refund.failed') {
    const object = event.payload as { id?: string; status?: string }
    const status = object.status ? REFUND_STATUS[object.status] : undefined
    if (object.id && status) {
      // updateMany, not update: a refund Stripe knows about but we don't (issued from
      // their dashboard directly) simply matches zero rows.
      await prisma.refund.updateMany({
        where: { stripeRefundId: object.id },
        data: { status },
      })
    }
  }

  res.json({ received: true })
}
