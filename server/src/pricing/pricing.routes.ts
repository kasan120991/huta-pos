import { DISCOUNT_TYPE_VALUES, DiscountType, MAX_BPS } from '@huta/shared'
import { Router } from 'express'
import { z } from 'zod'

import { assertCan, scopeStoreId } from '../auth/permissions.js'
import { isAdmin } from '../auth/principal.js'
import { ForbiddenError } from '../errors/index.js'
import { requireAdmin, requireAuth, requirePrincipal } from '../middleware/authenticate.js'
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedQuery,
} from '../middleware/validate.js'
import {
  LADDER_DEFAULT_WEIGHTS,
  createPriceGroup,
  createTier,
  deleteTier,
  listPriceGroups,
  priceLadder,
  updatePriceGroup,
  upsertTier,
} from './price-group.service.js'
import { quote } from './pricing.service.js'

/**
 * Pricing routes. HTTP translation only.
 *
 * The quote endpoint is `requireAuth` — a register has to be able to price a cart, and
 * the payload carries no cost. Price-group administration is `requireAdmin` plus
 * `pricing.manage`, per the permission matrix.
 */

export const pricingRouter: Router = Router()

/**
 * A manual discount. `OVERRIDE_PRICE_PER_GRAM` is deliberately excluded: it is a pricing
 * RULE an admin configures on a promotion, not something a cashier types at the counter.
 */
export const manualDiscount = z
  .object({
    discountType: z.enum([DiscountType.PERCENT_OFF, DiscountType.AMOUNT_OFF]),
    value: z.number().int().min(0),
    reason: z.string().trim().max(120).optional(),
  })
  .refine((d) => d.discountType !== DiscountType.PERCENT_OFF || d.value <= MAX_BPS, {
    message: 'A percentage discount cannot exceed 100%.',
    path: ['value'],
  })

const quoteBody = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.cuid(),
        quantityBase: z.number().int().positive(),
        manualDiscount: manualDiscount.optional(),
      }),
    )
    .min(1)
    .max(200),
  storeId: z.cuid().optional(),
  orderDiscount: manualDiscount.optional(),
  at: z.iso.datetime().optional(),
})

/**
 * Price a cart.
 *
 * A POST because the request carries a body, not because it changes anything — quoting is
 * a pure read. It therefore still passes through `csrfProtection` like any other POST,
 * which is fine: the register holds a CSRF token from the moment staff attach.
 */
pricingRouter.post('/quote', requireAuth, validateBody(quoteBody), async (req, res) => {
  const principal = requirePrincipal(req)
  const body = req.body as z.infer<typeof quoteBody>

  // The single chokepoint for store scoping. An admin must name a store, which is correct
  // here rather than inconvenient: promotions are store-scoped, so a quote with no store
  // is a quote that silently ignores every store-scoped promotion.
  const storeId = scopeStoreId(principal, body.storeId)

  // Back-dating a quote explains a past receipt or previews a scheduled promotion. Staff
  // have no reason to price at another instant, and letting them would let a register
  // quietly ring yesterday's promotion.
  if (body.at !== undefined && !isAdmin(principal)) {
    throw new ForbiddenError('Only an admin may price at another date.')
  }

  res.json(
    await quote({
      storeId,
      lines: body.lines,
      orderDiscount: body.orderDiscount,
      at: body.at === undefined ? undefined : new Date(body.at),
    }),
  )
})

// --- price group administration --------------------------------------------------------

pricingRouter.get('/groups', requireAdmin, async (req, res) => {
  assertCan(requirePrincipal(req), 'pricing.manage')
  res.json({ groups: await listPriceGroups() })
})

const groupBody = z.object({
  name: z.string().trim().min(1).max(60),
  basePricePerGramCents: z.number().int().min(0),
  active: z.boolean().optional(),
})

pricingRouter.post('/groups', requireAdmin, validateBody(groupBody), async (req, res) => {
  assertCan(requirePrincipal(req), 'pricing.manage')
  res.status(201).json(await createPriceGroup(req.body as z.infer<typeof groupBody>))
})

const groupParam = z.object({ id: z.cuid() })

pricingRouter.patch(
  '/groups/:id',
  requireAdmin,
  validateParams(groupParam),
  validateBody(groupBody.partial()),
  async (req, res) => {
    assertCan(requirePrincipal(req), 'pricing.manage')
    res.json(
      await updatePriceGroup(
        req.params['id'] as string,
        req.body as Partial<z.infer<typeof groupBody>>,
      ),
    )
  },
)

/**
 * The group's price list. `weights` is a comma-separated list of BASE units (3500 == 3.5g);
 * omitted, it falls back to the weights a flower list always shows.
 *
 * A GET because it is a pure read of configuration — unlike /quote, which needs a body.
 */
const ladderQuery = z.object({
  weights: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'weights must be a comma-separated list of base units')
    .optional(),
})

pricingRouter.get(
  '/groups/:id/ladder',
  requireAdmin,
  validateParams(groupParam),
  validateQuery(ladderQuery),
  async (req, res) => {
    assertCan(requirePrincipal(req), 'pricing.manage')
    const q = validatedQuery<z.infer<typeof ladderQuery>>(req)
    const weights = q.weights
      ? q.weights.split(',').map(Number).filter((n) => n > 0).slice(0, 24)
      : LADDER_DEFAULT_WEIGHTS
    res.json({ rows: await priceLadder(req.params['id'] as string, weights) })
  },
)

const tierBody = z.object({
  /** Base units. 3500 == 3.5g. Must be positive — the DB CHECK agrees. */
  minQuantityBase: z.number().int().positive(),
  totalPriceCents: z.number().int().min(0),
})

pricingRouter.post(
  '/groups/:id/tiers',
  requireAdmin,
  validateParams(groupParam),
  validateBody(tierBody),
  async (req, res) => {
    assertCan(requirePrincipal(req), 'pricing.manage')
    res
      .status(201)
      .json(await createTier(req.params['id'] as string, req.body as z.infer<typeof tierBody>))
  },
)

const tierParam = z.object({ id: z.cuid(), tierId: z.cuid() })

pricingRouter.put(
  '/groups/:id/tiers/:tierId',
  requireAdmin,
  validateParams(tierParam),
  validateBody(tierBody),
  async (req, res) => {
    assertCan(requirePrincipal(req), 'pricing.manage')
    res.json(
      await upsertTier(
        req.params['id'] as string,
        req.params['tierId'] as string,
        req.body as z.infer<typeof tierBody>,
      ),
    )
  },
)

pricingRouter.delete(
  '/groups/:id/tiers/:tierId',
  requireAdmin,
  validateParams(tierParam),
  async (req, res) => {
    assertCan(requirePrincipal(req), 'pricing.manage')
    await deleteTier(req.params['id'] as string, req.params['tierId'] as string)
    res.status(204).end()
  },
)

export { DISCOUNT_TYPE_VALUES }
