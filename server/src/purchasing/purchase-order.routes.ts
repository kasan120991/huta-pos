import { Router } from 'express'
import { z } from 'zod'

import { assertCan, scopeStoreId } from '../auth/permissions.js'
import { isAdmin } from '../auth/principal.js'
import { ForbiddenError } from '../errors/index.js'
import { requireAdmin, requirePrincipal } from '../middleware/authenticate.js'
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedQuery,
} from '../middleware/validate.js'
import {
  cancelOrder,
  closeShort,
  createOrder,
  getOrder,
  listOrders,
  placeOrder,
  updateDraft,
} from './purchase-order.service.js'

export const purchaseOrderRouter: Router = Router()

const idParam = z.object({ id: z.cuid() })

const listQuery = z.object({
  storeId: z.cuid().optional(),
  supplierId: z.cuid().optional(),
  outstandingOnly: z.coerce.boolean().optional(),
})

/**
 * Every route here is admin-only: `requireAdmin` for the coarse gate plus an in-handler
 * `assertCan(principal, 'purchaseOrder.manage')`, belt and braces, as pricing does. Staff
 * hold neither capability — they receive deliveries, they do not place orders.
 */
purchaseOrderRouter.get('/', requireAdmin, validateQuery(listQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'purchaseOrder.manage')

  const query = validatedQuery<z.infer<typeof listQuery>>(req)
  res.json({
    orders: await listOrders(principal, {
      storeId: query.storeId,
      supplierId: query.supplierId,
      outstandingOnly: query.outstandingOnly,
    }),
  })
})

purchaseOrderRouter.get('/:id', requireAdmin, validateParams(idParam), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'purchaseOrder.manage')
  res.json(await getOrder(principal, req.params['id'] as string))
})

const lineSchema = z.object({
  variantId: z.cuid(),
  /** Base units: items for EACH, milligrams for WEIGHT. Flower is ordered by weight here. */
  quantityBase: z.number().int().positive(),
  unitCostCents: z.number().int().nonnegative().optional(),
})

const orderBody = z.object({
  storeId: z.cuid().optional(),
  supplierId: z.cuid(),
  expectedAt: z.iso.datetime().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(lineSchema).min(1).max(200),
})

purchaseOrderRouter.post('/', requireAdmin, validateBody(orderBody), async (req, res) => {
  const principal = requirePrincipal(req)
  const body = req.body as z.infer<typeof orderBody>

  // An admin has no home store, so `scopeStoreId` requires them to name one — which is
  // correct here: an order is placed FOR a store and the destination is not optional.
  const storeId = scopeStoreId(principal, body.storeId)
  assertCan(principal, 'purchaseOrder.manage', { storeId })

  if (principal.userId === null) throw new ForbiddenError('An order needs an acting user.')

  res.status(201).json(
    await createOrder(principal, {
      storeId,
      userId: principal.userId,
      supplierId: body.supplierId,
      expectedAt: body.expectedAt,
      notes: body.notes,
      lines: body.lines,
    }),
  )
})

const draftBody = orderBody.partial().omit({ storeId: true })

purchaseOrderRouter.patch(
  '/:id',
  requireAdmin,
  validateParams(idParam),
  validateBody(draftBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'purchaseOrder.manage')
    res.json(
      await updateDraft(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof draftBody>,
      ),
    )
  },
)

purchaseOrderRouter.post(
  '/:id/place',
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'purchaseOrder.manage')
    if (principal.userId === null) throw new ForbiddenError('Placing an order needs an acting user.')

    res.json(await placeOrder(principal, req.params['id'] as string, principal.userId))
  },
)

purchaseOrderRouter.post(
  '/:id/cancel',
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'purchaseOrder.manage')
    res.json(await cancelOrder(principal, req.params['id'] as string))
  },
)

/** Declare a partially received order finished. This is what turns a shortfall into a variance. */
purchaseOrderRouter.post(
  '/:id/close-short',
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'purchaseOrder.manage')
    if (!isAdmin(principal)) throw new ForbiddenError('Only an admin may close an order.')

    res.json(await closeShort(principal, req.params['id'] as string))
  },
)
