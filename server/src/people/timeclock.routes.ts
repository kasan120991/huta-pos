import { Router } from 'express'
import { z } from 'zod'

import { UnauthorizedError } from '../errors/index.js'
import { requireAdmin, requirePrincipal } from '../middleware/authenticate.js'
import { validateBody, validateParams } from '../middleware/validate.js'
import {
  clockIn,
  clockOut,
  correctEntry,
  currentEntry,
  listEntries,
  voidEntry,
} from './timeclock.service.js'

/**
 * The timeclock.
 *
 * Two audiences on one router: a person punching their own clock at a register, and an
 * admin fixing the record on the Staff page. The punch routes carry no capability check
 * because the subject IS the caller — `principal.userId` is the only record they can reach.
 */
export const timeclockRouter: Router = Router()

/** What the register's clock button reads. Null when they are not on the clock. */
timeclockRouter.get('/current', async (req, res) => {
  res.json({ entry: await currentEntry(requirePrincipal(req)) })
})

timeclockRouter.post('/clock-in', async (req, res) => {
  res.status(201).json(await clockIn(requirePrincipal(req)))
})

timeclockRouter.post('/clock-out', async (req, res) => {
  res.json(await clockOut(requirePrincipal(req)))
})

// --- admin ------------------------------------------------------------------------------

const entryFilter = z.object({
  userId: z.cuid().optional(),
  /** Business days, `YYYY-MM-DD`. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

timeclockRouter.get('/entries', requireAdmin, async (req, res) => {
  const filter = entryFilter.parse(req.query)
  res.json(await listEntries(requirePrincipal(req), filter))
})

const idParam = z.object({ id: z.cuid() })

const correctionSchema = z.object({
  clockedOutAt: z.string().min(1),
  /** Required — a changed timesheet without a reason is not an audit trail. */
  note: z.string().trim().min(1).max(300),
})

timeclockRouter.patch(
  '/entries/:id',
  requireAdmin,
  validateParams(idParam),
  validateBody(correctionSchema),
  async (req, res) => {
    const principal = requirePrincipal(req)
    if (principal.userId === null) throw new UnauthorizedError()
    res.json(
      await correctEntry(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof correctionSchema>,
        principal.userId,
      ),
    )
  },
)

const voidSchema = z.object({ note: z.string().trim().min(1).max(300) })

timeclockRouter.post(
  '/entries/:id/void',
  requireAdmin,
  validateParams(idParam),
  validateBody(voidSchema),
  async (req, res) => {
    const principal = requirePrincipal(req)
    if (principal.userId === null) throw new UnauthorizedError()
    const { note } = req.body as z.infer<typeof voidSchema>
    res.json(await voidEntry(principal, req.params['id'] as string, note, principal.userId))
  },
)
