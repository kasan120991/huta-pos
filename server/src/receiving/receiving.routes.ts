import { Router } from 'express'
import { z } from 'zod'

import { assertCan, scopeStoreId } from '../auth/permissions.js'
import { isAdmin } from '../auth/principal.js'
import { ForbiddenError } from '../errors/index.js'
import {
  requireAdmin,
  requireAuth,
  requirePerson,
  requirePrincipal,
} from '../middleware/authenticate.js'
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedQuery,
} from '../middleware/validate.js'
import {
  createReceipt,
  getReceipt,
  listReceipts,
  openOrdersForReceiving,
  quickCreateProduct,
  reviewReceipt,
  setLineCosts,
  varianceForReceipt,
} from './receiving.service.js'

export const receivingRouter: Router = Router()

const idParam = z.object({ id: z.cuid() })

const listQuery = z.object({
  storeId: z.cuid().optional(),
  supplierId: z.cuid().optional(),
  uncostedOnly: z.coerce.boolean().optional(),
  /** The review queue: flagged and not yet signed off. */
  needsReviewOnly: z.coerce.boolean().optional(),
})

const openOrdersQuery = z.object({ storeId: z.cuid().optional() })

/**
 * The open orders a delivery can be received against, for ONE store.
 *
 * `scopeStoreId`, not the admin carve-out `listReceipts` uses: the chooser is per-register
 * and an "all stores" list would offer orders this terminal cannot receive into — the
 * service refuses a cross-store receipt anyway. The payload is cost-free by construction.
 */
receivingRouter.get(
  '/open-orders',
  requireAuth,
  validateQuery(openOrdersQuery),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const query = validatedQuery<z.infer<typeof openOrdersQuery>>(req)
    const storeId = scopeStoreId(principal, query.storeId)
    assertCan(principal, 'inventory.receive', { storeId })
    res.json({ orders: await openOrdersForReceiving(storeId) })
  },
)

/**
 * Delivery history.
 *
 * Store scoping goes through `scopeStoreId`, so a staff member sees their own store's
 * deliveries and cannot reach another store's by naming it. An admin who names no store
 * sees every store, which is why the helper's result is only applied when it is set.
 */
receivingRouter.get('/receipts', requireAuth, validateQuery(listQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'inventory.receive')

  const query = validatedQuery<z.infer<typeof listQuery>>(req)

  // An admin may legitimately ask for all stores; a staff principal is pinned to theirs
  // regardless of what the query says.
  const storeId = isAdmin(principal) ? query.storeId : scopeStoreId(principal, query.storeId)

  res.json({
    receipts: await listReceipts(principal, {
      storeId,
      supplierId: query.supplierId,
      uncostedOnly: query.uncostedOnly,
      needsReviewOnly: query.needsReviewOnly,
    }),
  })
})

/** The ordered-vs-received comparison behind a flagged delivery. */
receivingRouter.get(
  '/receipts/:id/variance',
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'cost.view')
    res.json({ variance: await varianceForReceipt(req.params['id'] as string) })
  },
)

/** Sign off a flagged delivery so it leaves the queue. */
receivingRouter.post(
  '/receipts/:id/review',
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'cost.view')
    if (principal.userId === null) throw new ForbiddenError('A review needs an acting user.')

    res.json(await reviewReceipt(principal, req.params['id'] as string, principal.userId))
  },
)

receivingRouter.get('/receipts/:id', requireAuth, validateParams(idParam), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'inventory.receive')

  const receipt = await getReceipt(principal, req.params['id'] as string)

  // The service reads by id, so scoping has to be checked against the result. Without
  // this a staff member could read any store's delivery by guessing an id.
  if (!isAdmin(principal) && receipt.storeId !== principal.storeId) {
    throw new ForbiddenError('That delivery belongs to another store.')
  }

  res.json(receipt)
})

const receiptBody = z.object({
  storeId: z.cuid().optional(),
  supplierId: z.cuid().nullish(),
  purchaseOrderId: z.cuid().nullish(),
  invoiceNumber: z.string().trim().max(80).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z
    .array(
      z.object({
        variantId: z.cuid(),
        /** Base units: items for EACH, milligrams for WEIGHT. The client converts grams. */
        quantityBase: z.number().int().positive(),
        /** ADMIN-ONLY. The service refuses this from a staff principal rather than dropping it. */
        unitCostCents: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(200),
})

/**
 * Post a delivery.
 *
 * `requirePerson` rather than `requireAdmin`: staff receive, and the permission matrix grants them
 * `inventory.receive` for quantities. A bare terminal with nobody attached cannot —
 * `Receipt.receivedById` is non-nullable, and "which unattended screen received this" is
 * not an audit trail.
 */
receivingRouter.post(
  '/receipts',
  requireAuth,
  requirePerson,
  validateBody(receiptBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof receiptBody>

    const storeId = scopeStoreId(principal, body.storeId)
    assertCan(principal, 'inventory.receive', { storeId })

    if (principal.userId === null) throw new ForbiddenError('A delivery needs an acting user.')

    res.status(201).json(
      await createReceipt(principal, {
        storeId,
        userId: principal.userId,
        supplierId: body.supplierId,
        purchaseOrderId: body.purchaseOrderId,
        invoiceNumber: body.invoiceNumber,
        notes: body.notes,
        lines: body.lines,
      }),
    )
  },
)

const costsBody = z.object({
  costs: z
    .array(
      z.object({
        lineId: z.cuid(),
        unitCostCents: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(200),
})

/** Enter cost on a staff-received delivery. */
receivingRouter.patch(
  '/receipts/:id/costs',
  requireAdmin,
  validateParams(idParam),
  validateBody(costsBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'cost.view')

    if (principal.userId === null) throw new ForbiddenError('Costing needs an acting user.')

    res.json(
      await setLineCosts(
        principal,
        req.params['id'] as string,
        (req.body as z.infer<typeof costsBody>).costs,
        principal.userId,
      ),
    )
  },
)

const quickProductBody = z.object({
  name: z.string().trim().min(1).max(200),
  categoryId: z.cuid(),
  sku: z.string().trim().min(1).max(64),
  barcode: z.string().trim().max(64).optional(),
})

/**
 * Add a catalog entry from the loading dock.
 *
 * Gated on `inventory.receive`, so staff may do it — the result is deliberately inactive
 * and unpriced until an admin reviews it. See the service for why that is the only shape
 * this can take without handing pricing to staff.
 */
receivingRouter.post(
  '/quick-product',
  requireAuth,
  requirePerson,
  validateBody(quickProductBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'inventory.receive')

    const body = req.body as z.infer<typeof quickProductBody>
    res.status(201).json(
      await quickCreateProduct({
        name: body.name,
        categoryId: body.categoryId,
        sku: body.sku,
        barcode: body.barcode,
      }),
    )
  },
)
