import { Router } from 'express'
import { z } from 'zod'

import {
  ADJUSTMENT_REASON_CODES,
  STOCK_FILTERS,
  STRAIN_TYPE_VALUES,
  type TrackingMode,
} from '@huta/shared'

import { assertCan } from '../auth/permissions.js'
import { ForbiddenError } from '../errors/index.js'
import { requireAdmin, requireAuth, requirePrincipal } from '../middleware/authenticate.js'
import { validateBody, validateParams, validateQuery, validatedQuery } from '../middleware/validate.js'
import { adjustStock, levelsForVariant, movementsForVariant } from '../inventory/inventory.service.js'
import {
  reconcileSheet,
  reconcileWeights,
  weightVarianceForVariant,
} from '../inventory/reconcile.service.js'
import { getProduct, listProducts, reference, summary } from './catalog.service.js'
import {
  createBrand,
  createProduct,
  createVariant,
  setProductCannabinoids,
  setVariantCannabinoids,
  setProductImages,
  updateProduct,
  updateVariant,
} from './catalog-admin.service.js'
import { productInsights } from './insights.service.js'

/**
 * Catalog and inventory routes. HTTP translation only.
 *
 * Reads are gated on `requireAuth` alone: everyone authenticated needs the catalog —
 * admins browse it, staff sell from it, and a register displays it. Cost is stripped
 * separately by `canSeeCost`, so there is nothing sensitive left to gate on.
 */

export const catalogRouter: Router = Router()

/**
 * Repeated keys (`?categories=a&categories=b`) arrive as a string OR an array depending
 * on how many were sent — normalise both to an array before anything downstream cares.
 */
const idList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))

const listQuery = z.object({
  categories: idList,
  cannabinoids: idList,
  search: z.string().trim().max(100).optional(),
  // Products bought from one supplier. Not an authorisation input — a supplier is global,
  // so narrowing to one reveals nothing a principal could not already list.
  supplierId: z.cuid().optional(),
  // Which store's numbers to show. Never trusted as authorisation — the service checks
  // `inventory.view.other` before honouring anything but the principal's own store.
  storeId: z.cuid().optional(),
  stock: z.enum(STOCK_FILTERS).default('all'),
  // Admin-only reach into inactive products; the service forces 'true' for anyone else.
  active: z.enum(['true', 'false', 'all']).default('true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

catalogRouter.get('/products', requireAuth, validateQuery(listQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  // `validatedQuery`, not `req.query` — the raw query is untouched strings, so coerced
  // numbers and defaults only exist in the parsed value.
  const q = validatedQuery<z.infer<typeof listQuery>>(req)

  res.json(
    await listProducts(principal, {
      categoryIds: q.categories,
      cannabinoidIds: q.cannabinoids,
      search: q.search,
      supplierId: q.supplierId,
      storeId: q.storeId,
      stock: q.stock,
      active: q.active,
      page: q.page,
      pageSize: q.pageSize,
    }),
  )
})

const idParam = z.object({ id: z.cuid() })
const storeQuery = z.object({ storeId: z.cuid().optional() })

catalogRouter.get(
  '/products/:id',
  requireAuth,
  validateParams(idParam),
  validateQuery(storeQuery),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const q = validatedQuery<z.infer<typeof storeQuery>>(req)
    res.json(await getProduct(principal, req.params['id'] as string, q.storeId))
  },
)

/**
 * Product economics — value at cost, blended margin, loss rate, per-store cost detail.
 *
 * The WHOLE endpoint is cost-derived, so it gates on `cost.view` up front rather than
 * stripping fields; a staff client simply never calls it and renders without the numbers.
 */
catalogRouter.get(
  '/products/:id/insights',
  requireAdmin,
  validateParams(idParam),
  validateQuery(storeQuery),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'cost.view')
    const q = validatedQuery<z.infer<typeof storeQuery>>(req)
    res.json(await productInsights(principal, req.params['id'] as string, q.storeId))
  },
)

catalogRouter.get('/reference', requireAuth, async (_req, res) => {
  res.json(await reference())
})

/**
 * Counts for the filter rail's stock chips and the header's product count.
 *
 * `requireAuth` alone, with no cost gating, because the payload is counts only — see the
 * note on `summary()`. If a money figure is ever added here it needs a capability check
 * and a staff-payload test, not a UI condition.
 */
catalogRouter.get('/summary', requireAuth, validateQuery(storeQuery), async (req, res) => {
  const principal = requirePrincipal(req)
  const q = validatedQuery<z.infer<typeof storeQuery>>(req)
  res.json(await summary(principal, q.storeId))
})

// --- catalog writes (the product editor's server half) -----------------------------------
//
// All admin-only: `requireAdmin` + `assertCan('catalog.manage')`. No DELETE routes by
// design — movements, sale lines and receipts reference these rows forever; deactivating
// removes them from selling surfaces while keeping history answerable.

const productShape = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullish(),
  categoryId: z.cuid(),
  brandId: z.cuid().nullish(),
  primarySupplierId: z.cuid().nullish(),
  coaUrl: z.url().max(500).nullish().or(z.literal('')),
  strainType: z.enum(STRAIN_TYPE_VALUES as [string, ...string[]]).nullish(),
  terpeneProfile: z.string().trim().max(500).nullish(),
  nose: z.string().trim().max(500).nullish(),
  active: z.boolean(),
})

const productBody = productShape.partial()

catalogRouter.patch(
  '/products/:id',
  requireAdmin,
  validateParams(idParam),
  validateBody(productBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'catalog.manage')
    res.json(
      await updateProduct(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof productBody>,
      ),
    )
  },
)

const cannabinoidsBody = z.object({
  links: z
    .array(
      z.object({
        cannabinoidId: z.cuid(),
        // Both may be null: "contains X, potency unrecorded" is legal by the relaxed CHECK.
        mgPerUnit: z.number().int().min(0).nullable(),
        percentBps: z.number().int().min(0).max(10000).nullable(),
      }),
    )
    .max(30),
})

catalogRouter.put(
  '/products/:id/cannabinoids',
  requireAdmin,
  validateParams(idParam),
  validateBody(cannabinoidsBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'catalog.manage')
    const body = req.body as z.infer<typeof cannabinoidsBody>
    res.json(await setProductCannabinoids(principal, req.params['id'] as string, body.links))
  },
)

const imagesBody = z.object({
  images: z
    .array(
      z.object({
        url: z.url().max(500),
        alt: z.string().trim().max(200).nullish(),
      }),
    )
    .max(12),
})

catalogRouter.put(
  '/products/:id/images',
  requireAdmin,
  validateParams(idParam),
  validateBody(imagesBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'catalog.manage')
    const body = req.body as z.infer<typeof imagesBody>
    res.json(await setProductImages(principal, req.params['id'] as string, body.images))
  },
)

/**
 * Strain identity on a VARIANT. Every field is nullable and every null means "inherit the
 * product's" — see catalog/variant-identity.ts. Identical validation to `productShape`'s
 * equivalents on purpose: the same fact should not be allowed at one level and refused at
 * the other.
 */
const variantIdentityShape = {
  strainType: z.enum(STRAIN_TYPE_VALUES as [string, ...string[]]).nullish(),
  terpeneProfile: z.string().trim().max(500).nullish(),
  nose: z.string().trim().max(500).nullish(),
  coaUrl: z.url().max(500).nullish().or(z.literal('')),
  description: z.string().trim().max(5000).nullish(),
  supplierId: z.cuid().nullish(),
}

const variantPatchBody = z
  .object({
    ...variantIdentityShape,
    label: z.string().trim().min(1).max(120).nullish(),
    sku: z.string().trim().min(1).max(64),
    barcode: z.string().trim().min(1).max(64).nullish(),
    priceCents: z.number().int().min(0).nullable(),
    priceGroupId: z.cuid().nullable(),
    taxable: z.boolean(),
    active: z.boolean(),
    minSaleBase: z.number().int().positive().nullable(),
    maxSaleBase: z.number().int().positive().nullable(),
    // trackingMode deliberately absent — changing it re-units every historical quantity.
  })
  .partial()

catalogRouter.patch(
  '/variants/:id',
  requireAdmin,
  validateParams(idParam),
  validateBody(variantPatchBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'catalog.manage')
    res.json(
      await updateVariant(
        principal,
        req.params['id'] as string,
        req.body as z.infer<typeof variantPatchBody>,
      ),
    )
  },
)

catalogRouter.put(
  '/variants/:id/cannabinoids',
  requireAdmin,
  validateParams(idParam),
  validateBody(cannabinoidsBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'catalog.manage')
    const body = req.body as z.infer<typeof cannabinoidsBody>
    res.json(await setVariantCannabinoids(principal, req.params['id'] as string, body.links))
  },
)

const variantCreateBody = z.object({
  ...variantIdentityShape,
  sku: z.string().trim().min(1).max(64),
  trackingMode: z.enum(['EACH', 'WEIGHT']),
  label: z.string().trim().min(1).max(120).nullish(),
  barcode: z.string().trim().min(1).max(64).nullish(),
  priceCents: z.number().int().min(0).nullish(),
  priceGroupId: z.cuid().nullish(),
  taxable: z.boolean().optional(),
  active: z.boolean().optional(),
  minSaleBase: z.number().int().positive().nullish(),
  maxSaleBase: z.number().int().positive().nullish(),
})

catalogRouter.post(
  '/products/:id/variants',
  requireAdmin,
  validateParams(idParam),
  validateBody(variantCreateBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'catalog.manage')
    const body = req.body as z.infer<typeof variantCreateBody>
    res.status(201).json(
      await createVariant(principal, req.params['id'] as string, {
        ...body,
        trackingMode: body.trackingMode as TrackingMode,
      }),
    )
  },
)

/**
 * Create a product with its required first variant. The variant schema is the same one
 * `POST /products/:id/variants` validates, so the two births cannot drift.
 */
const productCreateBody = productShape
  .extend({
    active: z.boolean().optional(),
    variant: variantCreateBody,
  })

catalogRouter.post('/products', requireAdmin, validateBody(productCreateBody), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'catalog.manage')
  const body = req.body as z.infer<typeof productCreateBody>
  res.status(201).json(
    await createProduct(principal, {
      ...body,
      variant: { ...body.variant, trackingMode: body.variant.trackingMode as TrackingMode },
    }),
  )
})

const brandBody = z.object({ name: z.string().trim().min(1).max(160) })

catalogRouter.post('/brands', requireAdmin, validateBody(brandBody), async (req, res) => {
  const principal = requirePrincipal(req)
  assertCan(principal, 'catalog.manage')
  const body = req.body as z.infer<typeof brandBody>
  res.status(201).json(await createBrand(principal, body.name))
})

// --- inventory ---------------------------------------------------------------------------

export const inventoryRouter: Router = Router()

const variantParam = z.object({ variantId: z.cuid() })

/**
 * Stock for one variant across every store.
 *
 * Deliberately not routed through `scopeStoreId`: that helper throws for an admin who
 * names no store, which is correct for a store-scoped query but wrong here — this IS the
 * cross-store breakdown. `inventory.view.other` is the capability that permits it.
 */
inventoryRouter.get(
  '/levels/:variantId',
  requireAuth,
  validateParams(variantParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'inventory.view.other')
    res.json({ levels: await levelsForVariant(principal, req.params['variantId'] as string) })
  },
)

inventoryRouter.get(
  '/movements/:variantId',
  requireAuth,
  validateParams(variantParam),
  validateQuery(storeQuery),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'inventory.view.own')
    const q = validatedQuery<z.infer<typeof storeQuery>>(req)
    res.json({
      movements: await movementsForVariant(principal, req.params['variantId'] as string, q.storeId),
    })
  },
)

/**
 * The counting sheet for a weight reconciliation session: every weight-tracked variant the
 * store actually holds, with what the system thinks is there.
 */
inventoryRouter.get(
  '/reconcile/:storeId',
  requireAdmin,
  validateParams(z.object({ storeId: z.cuid() })),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const storeId = req.params['storeId'] as string
    assertCan(principal, 'inventory.reconcileWeight', { storeId })
    res.json({ rows: await reconcileSheet(principal, storeId) })
  },
)

const reconcileBody = z.object({
  storeId: z.cuid(),
  counts: z
    .array(
      z.object({
        variantId: z.cuid(),
        /** Milligrams. A variant that was NOT counted is absent, never sent as 0. */
        countedBase: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
  reasonCode: z.enum(ADJUSTMENT_REASON_CODES as [string, ...string[]]).optional(),
  note: z.string().trim().max(500).optional(),
})

inventoryRouter.post(
  '/reconcile',
  requireAdmin,
  validateBody(reconcileBody),
  async (req, res) => {
    const principal = requirePrincipal(req)
    const body = req.body as z.infer<typeof reconcileBody>

    assertCan(principal, 'inventory.reconcileWeight', { storeId: body.storeId })
    if (principal.userId === null) {
      throw new ForbiddenError('A reconciliation needs an acting user.')
    }

    res.json(
      await reconcileWeights(principal, {
        storeId: body.storeId,
        userId: principal.userId,
        counts: body.counts,
        reasonCode: body.reasonCode,
        note: body.note,
      }),
    )
  },
)

/** Cumulative weight variance for one variant, per store. */
inventoryRouter.get(
  '/variance/:variantId',
  requireAdmin,
  validateParams(variantParam),
  async (req, res) => {
    const principal = requirePrincipal(req)
    assertCan(principal, 'cost.view')
    res.json({
      variance: await weightVarianceForVariant(principal, req.params['variantId'] as string),
    })
  },
)

const adjustBody = z.object({
  storeId: z.cuid(),
  variantId: z.cuid(),
  /** Base units: items for EACH, milligrams for WEIGHT. The client converts grams. */
  countedBase: z.number().int().min(0),
  // A code from the shared list, not free text — that is what makes "how much did we
  // lose to damage" a query rather than a reading exercise.
  reasonCode: z.enum(ADJUSTMENT_REASON_CODES as [string, ...string[]]),
  note: z.string().trim().max(500).optional(),
})

inventoryRouter.post('/adjust', requireAdmin, validateBody(adjustBody), async (req, res) => {
  const principal = requirePrincipal(req)
  const body = req.body as z.infer<typeof adjustBody>

  assertCan(principal, 'inventory.adjust', { storeId: body.storeId })
  if (principal.userId === null) throw new Error('An adjustment needs an acting user.')

  res.json(
    await adjustStock({
      storeId: body.storeId,
      variantId: body.variantId,
      countedBase: body.countedBase,
      reasonCode: body.reasonCode,
      note: body.note,
      userId: principal.userId,
    }),
  )
})
