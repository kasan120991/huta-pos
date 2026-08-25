import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'

import { authRouter } from './auth/auth.routes.js'
import { catalogRouter, inventoryRouter } from './catalog/catalog.routes.js'
import { allowedOrigins } from './config/origins.js'
import { paymentsRouter } from './payments/payments.routes.js'
import { stripeWebhookHandler } from './payments/webhook.js'
import { pricingRouter } from './pricing/pricing.routes.js'
import { purchaseOrderRouter } from './purchasing/purchase-order.routes.js'
import { receivingRouter } from './receiving/receiving.routes.js'
import { payrollRouter } from './people/payroll.routes.js'
import { timeclockRouter } from './people/timeclock.routes.js'
import { salesRouter } from './sales/sales.routes.js'
import { shiftRouter } from './sales/shift.routes.js'
import { supplierRouter } from './suppliers/supplier.routes.js'
import { transferRouter } from './transfers/transfer.routes.js'
import { authenticate } from './middleware/authenticate.js'
import { csrfProtection } from './middleware/csrf.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { requestId } from './middleware/validate.js'

/**
 * Builds the Express app WITHOUT listening, so tests can mount it with supertest and no
 * port is ever bound in a test run.
 */
export function createApp(): Express {
  const app = express()

  app.disable('x-powered-by')

  // Behind DigitalOcean's load balancer every request otherwise appears to come from one
  // IP, which would make an IP-keyed rate limiter lock out the entire company on the
  // first brute-force attempt. A numeric hop count, never `true` — express-rate-limit
  // refuses to start with a permissive setting, correctly.
  app.set('trust proxy', 1)

  app.use(helmet({ contentSecurityPolicy: false }))

  app.use(
    cors({
      // A strict allowlist, because `credentials: true` makes `origin: '*'` illegal —
      // and cookies are the whole session mechanism here.
      origin: allowedOrigins,
      credentials: true,
    }),
  )

  // BEFORE the JSON parser: Stripe signature verification needs the raw bytes, and a
  // body that has been parsed and re-serialised will never verify. Cookieless, so the
  // CSRF middleware skips it; `authenticate` only populates and never rejects.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler)

  app.use(express.json({ limit: '100kb' }))
  app.use(cookieParser())
  app.use(requestId)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use(authenticate)
  app.use(csrfProtection)

  app.use('/api/auth', authRouter)
  app.use('/api/catalog', catalogRouter)
  app.use('/api/inventory', inventoryRouter)
  app.use('/api/pricing', pricingRouter)
  app.use('/api/suppliers', supplierRouter)
  app.use('/api/purchase-orders', purchaseOrderRouter)
  app.use('/api/receiving', receivingRouter)
  app.use('/api/shifts', shiftRouter)
  app.use('/api/timeclock', timeclockRouter)
  app.use('/api/payroll', payrollRouter)
  app.use('/api/sales', salesRouter)
  app.use('/api/payments', paymentsRouter)
  app.use('/api/transfers', transferRouter)

  // Express 5 / path-to-regexp v8: `app.use('*')` throws at startup. A bare `app.use`
  // is the correct catch-all.
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
