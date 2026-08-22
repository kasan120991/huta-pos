import { Router } from 'express'

import type { PaymentsConfig } from '@huta/shared/schemas'

import { env } from '../config/env.js'

/**
 * The publishable key is, by definition, the one Stripe value the client may see. Null
 * tells the register Stripe is not configured, and it disables the Card tender.
 */
export const paymentsRouter: Router = Router()

paymentsRouter.get('/config', (_req, res) => {
  const config: PaymentsConfig = { publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null }
  res.json(config)
})
