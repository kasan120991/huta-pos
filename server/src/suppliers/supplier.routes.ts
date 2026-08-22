import { Router } from 'express'
import { z } from 'zod'

import { assertCan } from '../auth/permissions.js'
import { requireAdmin, requireAuth, requirePrincipal } from '../middleware/authenticate.js'
import { validateBody, validateParams, validateQuery, validatedQuery } from '../middleware/validate.js'
import {
  createSupplier,
  getSupplier,
  listSuppliers,
  supplierActivity,
  updateSupplier,
} from './supplier.service.js'

export const supplierRouter: Router = Router()

const idParam = z.object({ id: z.cuid() })

const listQuery = z.object({
  search: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().optional(),
})

/**
 * Suppliers are readable by staff — they need a rep's phone number when a delivery is
 * wrong. The commercial terms are stripped in the service, at the `select`.
 */
supplierRouter.get('/', requireAuth, validateQuery(listQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'supplier.view')

  const query = validatedQuery<z.infer<typeof listQuery>>(req)
  res.json({
    suppliers: await listSuppliers(principal, {
      ...(query.includeInactive === undefined ? {} : { includeInactive: query.includeInactive }),
      search: query.search,
    }),
  })
})

supplierRouter.get('/:id', requireAuth, validateParams(idParam), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'supplier.view')
  res.json(await getSupplier(principal, req.params['id'] as string))
})

/**
 * How this supplier behaves — orders, deliveries, lead time. ADMIN-ONLY.
 *
 * `supplier.report`, not `supplier.view`: the permission matrix grants staff supplier
 * records for the contact details and puts lead-time reporting firmly on the admin side.
 * Declared above `/:id` is unnecessary (the paths cannot collide) but it sits beside the
 * reads it belongs with.
 */
supplierRouter.get(
  '/:id/activity',
  requireAdmin,
  validateParams(idParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'supplier.report')
    res.json(await supplierActivity(req.params['id'] as string))
  },
)

const supplierBody = z.object({
  name: z.string().trim().min(1).max(160),
  contactName: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.email().max(160).nullish().or(z.literal('')),
  website: z.string().trim().max(200).nullish(),
  addressLine1: z.string().trim().max(160).nullish(),
  addressLine2: z.string().trim().max(160).nullish(),
  city: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(40).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  accountNumber: z.string().trim().max(80).nullish(),
  paymentTerms: z.string().trim().max(80).nullish(),
  minimumOrderCents: z.number().int().nonnegative().nullish(),
  licenseNumber: z.string().trim().max(80).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  active: z.boolean().optional(),
})

supplierRouter.post('/', requireAdmin, validateBody(supplierBody), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'supplier.report')
  res.status(201).json(await createSupplier(principal, req.body as z.infer<typeof supplierBody>))
})

supplierRouter.patch(
  '/:id',
  requireAdmin,
  validateParams(idParam),
  validateBody(supplierBody.partial()),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'supplier.report')

    // No DELETE route by design. Purchase orders, receipts, batches and sale lines all
    // reference a supplier; deactivating drops it from pickers while keeping every one of
    // those records answerable.
    res.json(
      await updateSupplier(
        principal,
        req.params['id'] as string,
        req.body as Partial<z.infer<typeof supplierBody>>,
      ),
    )
  },
)
