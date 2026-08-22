import { Router } from 'express'
import { z } from 'zod'

import { TRANSFER_STATUS_VALUES } from '@huta/shared'

import { requireAdmin, requireAuth, requirePerson, requirePrincipal } from '../middleware/authenticate.js'
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedQuery,
} from '../middleware/validate.js'
import {
  acceptTransfer,
  cancelTransfer,
  createTransfer,
  declineTransfer,
  directMove,
  getTransfer,
  listTransfers,
  receiveTransfer,
  shipTransfer,
  transferAvailability,
} from './transfer.service.js'

/**
 * Transfers — Phase 10.
 *
 * Thin by design: store scoping, per-leg capability gating and the status machine all
 * live in the service, where the TransferRequest row lock makes them race-safe. The
 * routes validate shapes and nothing else.
 */
export const transferRouter: Router = Router()

const idParam = z.object({ id: z.cuid() })

const listQuery = z.object({
  storeId: z.cuid().optional(),
  status: z.enum(TRANSFER_STATUS_VALUES).optional(),
})

transferRouter.get('/', requireAuth, validateQuery(listQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  const query = validatedQuery<z.infer<typeof listQuery>>(req)
  res.json({ transfers: await listTransfers(principal, query) })
})

transferRouter.get('/:id', requireAuth, validateParams(idParam), async (req, res) => {
  const principal = requirePrincipal(req)
  res.json(await getTransfer(principal, req.params['id'] as string))
})

/**
 * On hand at the SOURCE store for this transfer's lines — what the fulfilling cashier is
 * about to give away, measured against what is actually on the shelf.
 *
 * Declared BELOW `/:id` is fine (the paths cannot collide), but it stays a separate read
 * rather than a field on the transfer for the reason in the service: a transfer row is
 * history and this is a live number.
 */
transferRouter.get(
  '/:id/availability',
  requireAuth,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json({ availability: await transferAvailability(principal, req.params['id'] as string) })
  },
)

const linesSchema = z
  .array(
    z.object({
      variantId: z.cuid(),
      /** Base units: items for EACH, milligrams for WEIGHT. The client converts grams. */
      quantityBase: z.number().int().positive(),
    }),
  )
  .min(1)
  .max(100)

const createBody = z.object({
  sourceStoreId: z.cuid(),
  requestingStoreId: z.cuid().optional(),
  note: z.string().trim().max(2000).nullish(),
  lines: linesSchema,
})

transferRouter.post('/', requireAuth, requirePerson, validateBody(createBody), async (req, res) => {
  const principal = requirePrincipal(req)
  res.status(201).json(await createTransfer(principal, req.body as z.infer<typeof createBody>))
})

const acceptBody = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.cuid(),
        approvedBase: z.number().int().nonnegative(),
      }),
    )
    .max(100)
    .optional(),
})

transferRouter.post(
  '/:id/accept',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(acceptBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json(
      await acceptTransfer(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof acceptBody>,
      ),
    )
  },
)

const declineBody = z.object({ reason: z.string().trim().min(1).max(500) })

transferRouter.post(
  '/:id/decline',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(declineBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json(
      await declineTransfer(
        principal,
        req.params['id'] as string,
        (req.body as z.infer<typeof declineBody>).reason,
      ),
    )
  },
)

transferRouter.post(
  '/:id/ship',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json(await shipTransfer(principal, req.params['id'] as string))
  },
)

const receiveBody = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.cuid(),
        receivedBase: z.number().int().nonnegative(),
      }),
    )
    .max(100)
    .optional(),
})

transferRouter.post(
  '/:id/receive',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(receiveBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json(
      await receiveTransfer(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof receiveBody>,
      ),
    )
  },
)

const cancelBody = z.object({ reason: z.string().trim().min(1).max(500).nullish() })

transferRouter.post(
  '/:id/cancel',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(cancelBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json(
      await cancelTransfer(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof cancelBody>,
      ),
    )
  },
)

const directBody = z.object({
  fromStoreId: z.cuid(),
  toStoreId: z.cuid(),
  note: z.string().trim().max(2000).nullish(),
  lines: linesSchema,
})

/** Admin-only immediate move — one transaction, recorded as a request born RECEIVED. */
transferRouter.post('/direct', requireAdmin, validateBody(directBody), async (req, res) => {
  const principal = requirePrincipal(req)
  res.status(201).json(await directMove(principal, req.body as z.infer<typeof directBody>))
})
