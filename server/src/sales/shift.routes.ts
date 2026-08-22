import { Router } from 'express'
import { z } from 'zod'

import { CASH_MOVEMENT_TYPE_VALUES } from '@huta/shared'

import { scopeStoreId } from '../auth/permissions.js'
import { requireAdmin, requireAuth, requirePerson, requirePrincipal } from '../middleware/authenticate.js'
import { validateBody, validateParams, validateQuery, validatedQuery } from '../middleware/validate.js'
import {
  addCashMovement,
  closeShift,
  currentShift,
  getShift,
  listCashMovements,
  listShifts,
  liveDrawers,
  openShift,
  reviewShift,
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

/**
 * The drawer list. Declared above '/:id' — the file's convention is literals first, and a
 * bare '/' would otherwise be ambiguous to read even where it is not ambiguous to match.
 */
const shiftListQuery = z.object({
  storeId: z.cuid().optional(),
  // `z.iso.date()`, not a hand-rolled regex: the regex this replaced accepted `2026-99-99`.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  userId: z.cuid().optional(),
})

/**
 * `requireAuth, requirePerson` were missing here while every sibling carried them. A bare
 * terminal was already refused one layer down by `assertCan(…, 'shift.manage')`, so nothing
 * leaked — but a money read should not depend on a service check to decide that an
 * unattended register may not ask.
 */
shiftRouter.get(
  '/',
  requireAuth,
  requirePerson,
  validateQuery(shiftListQuery),
  async (req, res) => {
    const filter = validatedQuery<z.infer<typeof shiftListQuery>>(req)
    res.json(await listShifts(requirePrincipal(req), filter))
  },
)

/**
 * Live till balances across every store in scope. Declared with the other literals, above
 * '/:id'. Serves `/admin/drawers` today and the dashboard when it is built.
 */
shiftRouter.get(
  '/live',
  requireAuth,
  requirePerson,
  validateQuery(storeQuery),
  async (req, res) => {
    const query = validatedQuery<z.infer<typeof storeQuery>>(req)
    res.json({ drawers: await liveDrawers(requirePrincipal(req), query.storeId) })
  },
)

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

const reviewBody = z.object({ note: z.string().trim().min(1).max(500) })

/**
 * Explain a variance. Admin only — staff hold `shift.manage` because they open and close
 * drawers, which is not the authority to pronounce on a shortfall. Re-posting amends.
 */
shiftRouter.post(
  '/:id/review',
  requireAuth,
  requireAdmin,
  validateParams(idParam),
  validateBody(reviewBody),
  async (req, res) => {
    const body = req.body as z.infer<typeof reviewBody>
    res.json(await reviewShift(requirePrincipal(req), req.params['id'] as string, body.note))
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
