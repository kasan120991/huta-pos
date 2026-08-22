import { Router } from 'express'
import { z } from 'zod'

import { SALE_STATUS_VALUES } from '@huta/shared'
import type {
  CheckoutInput,
  RefundInput,
  RefundQuoteInput,
  SaleIntentInput,
  SalesHistoryQuery,
  VoidInput,
} from '@huta/shared/schemas'

import {
  requireAdmin,
  requireAuth,
  requirePerson,
  requirePrincipal,
} from '../middleware/authenticate.js'
import { validateBody, validateParams, validateQuery, validatedQuery } from '../middleware/validate.js'
import { manualDiscount } from '../pricing/pricing.routes.js'
import {
  listRecentSales,
  refundQuote,
  refundSale,
  retryCardRefund,
  voidSale,
} from './refund.service.js'
import { listSales, salesTotals } from './history.service.js'
import { cancelSaleIntent, checkout, createSaleIntent, getSale } from './sales.service.js'

/**
 * Sales routes. HTTP translation only.
 *
 * There is NO storeId anywhere in the checkout body — the store comes from the
 * principal's terminal, never from the client. `requirePerson` keeps a bare terminal
 * out; the service additionally requires terminal attachment, so an unattached admin at
 * a desk cannot ring a sale either.
 */

export const salesRouter: Router = Router()

const checkoutLines = z
  .array(
    z.object({
      variantId: z.cuid(),
      /** Base units: items for EACH, milligrams for WEIGHT. The client converts grams. */
      quantityBase: z.number().int().positive(),
      manualDiscount: manualDiscount.optional(),
    }),
  )
  .min(1)
  .max(200)

const tender = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), tenderedCents: z.number().int().min(0) }),
  // A Stripe id, not a cuid — the amount is NEVER in the body; it lives on the intent.
  z.object({ method: z.literal('CARD'), paymentIntentId: z.string().min(1).max(255) }),
])

const checkoutBody = z.object({
  lines: checkoutLines,
  orderDiscount: manualDiscount.optional(),
  ageVerified: z.boolean(),
  // Empty is legal only for a $0 sale — the service enforces that against its own quote.
  tenders: z
    .array(tender)
    .max(2)
    .refine(
      (tenders) => new Set(tenders.map((t) => t.method)).size === tenders.length,
      'At most one tender per method.',
    ),
})

salesRouter.post('/', requireAuth, requirePerson, validateBody(checkoutBody), async (req, res) => {
  const principal = requirePrincipal(req)
  const body = req.body as z.infer<typeof checkoutBody>
  res.status(201).json(await checkout(principal, body as CheckoutInput))
})

const intentBody = z.object({
  lines: checkoutLines,
  orderDiscount: manualDiscount.optional(),
  cashCents: z.number().int().min(0),
})

salesRouter.post(
  '/intent',
  requireAuth,
  requirePerson,
  validateBody(intentBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof intentBody>
    res.status(201).json(await createSaleIntent(principal, body as SaleIntentInput))
  },
)

const intentParam = z.object({ id: z.string().min(1).max(255) })

salesRouter.post(
  '/intent/:id/cancel',
  requireAuth,
  requirePerson,
  validateParams(intentParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    await cancelSaleIntent(principal, req.params['id'] as string)
    res.status(204).end()
  },
)

const idParam = z.object({ id: z.cuid() })

// BEFORE '/:id' — otherwise 'recent' would be parsed as a sale id and 400 on the cuid.
const recentQuery = z.object({ number: z.coerce.number().int().positive().optional() })

/**
 * Transaction history. Shared by /admin/sales and /register/history so the two surfaces
 * cannot disagree about what happened.
 *
 * `from`/`to` are business DAYS (`YYYY-MM-DD`), not instants: "what did we take on the
 * 20th" is a question about the store's calendar, so the server resolves them against
 * `Store.timezone`. Both ends are inclusive of the whole local day.
 *
 * NOT `requireAdmin` — a cashier may read their own store's history, exactly as they can
 * today via /recent. The capability layer decides: own store needs `sale.ring`, anything
 * wider needs `report.view`, which is admin-only. See history.service.ts.
 */
const historyQuery = z.object({
  storeId: z.cuid().optional(),
  cashierId: z.cuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(SALE_STATUS_VALUES as [string, ...string[]]).optional(),
  method: z.enum(['CASH', 'CARD']).optional(),
  number: z.coerce.number().int().positive().optional(),
})

const historyPageQuery = historyQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

salesRouter.get(
  '/',
  requireAuth,
  requirePerson,
  validateQuery(historyPageQuery),
  async (req, res) => {
    const q = validatedQuery<z.infer<typeof historyPageQuery>>(req)
    const { page, pageSize, ...filter } = q
    res.json(
      await listSales(requirePrincipal(req), filter as SalesHistoryQuery, { page, pageSize }),
    )
  },
)

// BEFORE '/:id', same reason as '/recent'.
salesRouter.get(
  '/totals',
  requireAuth,
  requirePerson,
  validateQuery(historyQuery),
  async (req, res) => {
    const q = validatedQuery<z.infer<typeof historyQuery>>(req)
    res.json(await salesTotals(requirePrincipal(req), q as SalesHistoryQuery))
  },
)

salesRouter.get(
  '/recent',
  requireAuth,
  requirePerson,
  validateQuery(recentQuery),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const query = validatedQuery<z.infer<typeof recentQuery>>(req)
    res.json(await listRecentSales(principal, query))
  },
)

salesRouter.get('/:id', requireAuth, requirePerson, validateParams(idParam), async (req, res) => {
  const principal = requirePrincipal(req)
  res.json(await getSale(principal, req.params['id'] as string))
})

const refundBody = z.object({
  lines: z
    .array(
      z.object({
        saleLineId: z.cuid(),
        quantityBase: z.number().int().positive(),
        restock: z.boolean(),
      }),
    )
    .min(1)
    .max(200),
  method: z.enum(['CASH', 'CARD']),
  reason: z.string().max(500).optional(),
  stepUpGrantId: z.cuid().optional(),
})

salesRouter.post(
  '/:id/refunds',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(refundBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof refundBody>
    res.status(201).json(await refundSale(principal, req.params['id'] as string, body as RefundInput))
  },
)

const refundQuoteBody = z.object({
  lines: z
    .array(z.object({ saleLineId: z.cuid(), quantityBase: z.number().int().positive() }))
    .min(1)
    .max(200),
})

salesRouter.post(
  '/:id/refund-quote',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(refundQuoteBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof refundQuoteBody>
    res.json(await refundQuote(principal, req.params['id'] as string, body as RefundQuoteInput))
  },
)

const voidBody = z.object({
  reason: z.string().min(1).max(500),
  stepUpGrantId: z.cuid().optional(),
})

salesRouter.post(
  '/:id/void',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(voidBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof voidBody>
    res.status(201).json(await voidSale(principal, req.params['id'] as string, body as VoidInput))
  },
)

salesRouter.post(
  '/refunds/:id/retry-card',
  requireAuth,
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json(await retryCardRefund(principal, req.params['id'] as string))
  },
)
