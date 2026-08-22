import { Router } from 'express'
import { z } from 'zod'

import { CASH_MOVEMENT_TYPE_VALUES } from '@huta/shared'

import { scopeStoreId } from '../auth/permissions.js'
import { requireAuth, requirePerson, requirePrincipal } from '../middleware/authenticate.js'
import { validateBody, validateParams, validateQuery, validatedQuery } from '../middleware/validate.js'
import {
  addCashMovement,
  closeShift,
  currentShift,
  getShift,
  listCashMovements,
  openShift,
} from './shift.service.js'

/**
 * Shift routes. HTTP translation only — arithmetic and locking live in the service.
 *
 * Everything requires a PERSON: a bare terminal has no one to hold accountable for a
 * drawer. Store scoping goes through `scopeStoreId` — staff are pinned to their store,
 * an admin must name one.
 */

export const shiftRouter: Router = Router()

const storeQuery = z.object({ storeId: z.cuid().optional() })
const idParam = z.object({ id: z.cuid() })

shiftRouter.get('/current', requireAuth, requirePerson, validateQuery(storeQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  const query = validatedQuery<z.infer<typeof storeQuery>>(req)
  const storeId = scopeStoreId(principal, query.storeId)
  res.json({ shift: await currentShift(principal, storeId) })
})

const openBody = z.object({
  openingCashCents: z.number().int().min(0),
  storeId: z.cuid().optional(),
})

shiftRouter.post('/open', requireAuth, requirePerson, validateBody(openBody), async (req, res) => {
  const principal = requirePrincipal(req)
  const body = req.body as z.infer<typeof openBody>
  const storeId = scopeStoreId(principal, body.storeId)
  res.status(201).json(await openShift(principal, storeId, { openingCashCents: body.openingCashCents }))
})

const closeBody = z.object({
  countedCashCents: z.number().int().min(0),
  notes: z.string().trim().max(2000).optional(),
})

shiftRouter.post(
  '/:id/close',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(closeBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof closeBody>
    res.json(await closeShift(principal, req.params['id'] as string, body))
  },
)

const movementBody = z.object({
  type: z.enum(CASH_MOVEMENT_TYPE_VALUES as [string, ...string[]]),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(1).max(200),
})

shiftRouter.post(
  '/:id/movements',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  validateBody(movementBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof movementBody>
    res.status(201).json(
      await addCashMovement(principal, req.params['id'] as string, {
        type: body.type as (typeof CASH_MOVEMENT_TYPE_VALUES)[number],
        amountCents: body.amountCents,
        reason: body.reason,
      }),
    )
  },
)

shiftRouter.get(
  '/:id/movements',
  requireAuth,
  requirePerson,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    res.json({ movements: await listCashMovements(principal, req.params['id'] as string) })
  },
)

shiftRouter.get('/:id', requireAuth, requirePerson, validateParams(idParam), async (req, res) => {
  const principal = requirePrincipal(req)
  res.json(await getShift(principal, req.params['id'] as string))
})
