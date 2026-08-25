import { Router } from 'express'
import { z } from 'zod'

import { UnauthorizedError } from '../errors/index.js'
import { requireAdmin, requirePrincipal } from '../middleware/authenticate.js'
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js'
import {
  commitRun,
  getRun,
  listPeriods,
  listRuns,
  payLinesForUser,
  previewRun,
  reverseRun,
} from './payroll.service.js'
import { recordPayout, reversePayout } from './payout.service.js'
import { listWageRates, setWageRate } from './wage.service.js'

/**
 * Payroll — wages, gross pay runs, and payouts.
 *
 * Every route is `requireAdmin` plus a `user.manage` check in the service, belt and braces,
 * exactly as `/timeclock/entries` is. Handlers hold no business logic.
 *
 * Wage routes live here rather than on `auth.routes.ts` because that file is already long and
 * every money-shaped people route belongs together.
 */
export const payrollRouter: Router = Router()

const idParam = z.object({ id: z.cuid() })
const userIdParam = z.object({ userId: z.cuid() })
const sundayDate = z.iso.date()

/** An acting person, not a bare terminal — every write here is attributed. */
function actorId(req: Parameters<typeof requirePrincipal>[0]): string {
  const principal = requirePrincipal(req)
  if (principal.userId === null) {
    throw new UnauthorizedError('Payroll needs an acting user.')
  }
  return principal.userId
}

/* ————— periods and runs ————— */

payrollRouter.get('/periods', requireAdmin, async (req, res) => {
  res.json({ periods: await listPeriods(requirePrincipal(req)) })
})

payrollRouter.get(
  '/preview',
  requireAdmin,
  validateQuery(z.object({ periodStart: sundayDate })),
  async (req, res) => {
    const query = req.query as unknown as { periodStart: string }
    res.json(await previewRun(requirePrincipal(req), query.periodStart))
  },
)

payrollRouter.get('/runs', requireAdmin, async (req, res) => {
  res.json({ runs: await listRuns(requirePrincipal(req)) })
})

payrollRouter.get('/runs/:id', requireAdmin, validateParams(idParam), async (req, res) => {
  res.json(await getRun(requirePrincipal(req), req.params['id'] as string))
})

payrollRouter.post(
  '/runs',
  requireAdmin,
  validateBody(z.object({ periodStart: sundayDate, note: z.string().trim().max(500).optional() })),
  async (req, res) => {
    const body = req.body as { periodStart: string, note?: string }
    res
      .status(201)
      .json(await commitRun(requirePrincipal(req), body.periodStart, body.note, actorId(req)))
  },
)

payrollRouter.post(
  '/runs/:id/reverse',
  requireAdmin,
  validateParams(idParam),
  validateBody(z.object({ note: z.string().trim().min(1).max(300) })),
  async (req, res) => {
    const body = req.body as { note: string }
    res.json(
      await reverseRun(requirePrincipal(req), req.params['id'] as string, body.note, actorId(req)),
    )
  },
)

/* ————— payouts ————— */

const payoutSchema = z
  .object({
    method: z.enum(['CASH', 'CHECK', 'BANK']),
    amountCents: z.number().int().positive(),
    reference: z.string().trim().max(120).optional(),
    note: z.string().trim().max(300).optional(),
    /** Required for CASH — which till the notes leave. */
    storeId: z.cuid().optional(),
  })
  .refine((v) => v.method !== 'CASH' || v.storeId !== undefined, {
    message: 'Say which till the cash comes out of.',
    path: ['storeId'],
  })

payrollRouter.post(
  '/lines/:id/payouts',
  requireAdmin,
  validateParams(idParam),
  validateBody(payoutSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof payoutSchema>
    res
      .status(201)
      .json(await recordPayout(requirePrincipal(req), req.params['id'] as string, body, actorId(req)))
  },
)

payrollRouter.post(
  '/payouts/:id/reverse',
  requireAdmin,
  validateParams(idParam),
  validateBody(
    z.object({ note: z.string().trim().min(1).max(300), storeId: z.cuid().optional() }),
  ),
  async (req, res) => {
    const body = req.body as { note: string, storeId?: string }
    res.json(
      await reversePayout(
        requirePrincipal(req),
        req.params['id'] as string,
        body.note,
        actorId(req),
        body.storeId,
      ),
    )
  },
)

/** One person's pay across every run — the staff page's Pay tab. */
payrollRouter.get(
  '/people/:userId',
  requireAdmin,
  validateParams(userIdParam),
  async (req, res) => {
    res.json(await payLinesForUser(requirePrincipal(req), req.params['userId'] as string))
  },
)

/* ————— wages ————— */

payrollRouter.get(
  '/wages/:userId',
  requireAdmin,
  validateParams(userIdParam),
  async (req, res) => {
    res.json({
      rates: await listWageRates(requirePrincipal(req), req.params['userId'] as string),
    })
  },
)

payrollRouter.post(
  '/wages/:userId',
  requireAdmin,
  validateParams(userIdParam),
  validateBody(
    z.object({
      ratePerHourCents: z.number().int().positive(),
      /** Any date — the service snaps it back to the Sunday of that week. */
      effectiveFrom: z.iso.date(),
      note: z.string().trim().max(300).optional(),
    }),
  ),
  async (req, res) => {
    const body = req.body as { ratePerHourCents: number, effectiveFrom: string, note?: string }
    res
      .status(201)
      .json(
        await setWageRate(
          requirePrincipal(req),
          req.params['userId'] as string,
          body,
          actorId(req),
        ),
      )
  },
)
