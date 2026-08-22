import { TrackingMode, slugify } from '@huta/shared'
import type {
  CannabinoidLinkInput,
  ProductImageInput,
  ProductPatchInput,
  VariantCreateInput,
  VariantPatchInput,
} from '@huta/shared/schemas'

import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors/index.js'
import { uniqueProductSlug } from './product-slug.js'

/**
 * Catalog writes — the editor's server half.
 *
 * Rules that hold for every function here:
 *
 *   * Callers are already behind `requireAdmin` + `assertCan('catalog.manage')`; nothing
 *     here re-checks roles, only referential validity.
 *   * Pre-checks exist to give a useful message. The unique indexes and CHECK constraints
 *     remain the backstop against races — a violation slipping past a pre-check is caught
 *     by the database, not silently accepted.
 *   * Nothing is deleted. Products and variants deactivate; movements, sale lines and
 *     receipts keep their references forever.
 *   * Every write lands one AuditLog row carrying only the CHANGED keys — an audit that
 *     echoes the whole row buries the one field that moved.
 */

/** The keys of `patch` that are actually present, projected out of `row` for the audit. */
function changedKeys(row: object, patch: object): Record<string, unknown> {
  const rowRecord = row as Record<string, unknown>
  const patchRecord = patch as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(patchRecord)) {
    if (patchRecord[key] !== undefined) out[key] = rowRecord[key] ?? null
  }
  return out
}

/** Drop `undefined` keys so a partial patch never writes `undefined` into Prisma `data`. */
function stripUndefined(patch: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

async function audit(
  principal: Principal,
  action: string,
  entityType: string,
  entityId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: principal.userId,
      action,
      entityType,
      entityId,
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
    },
  })
}

// --- product -------------------------------------------------------------------------------

/** The wire shape lives in @huta/shared — client and server import the same contract. */
export type ProductPatch = ProductPatchInput

export async function updateProduct(principal: Principal, id: string, patch: ProductPatch) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      categoryId: true,
      brandId: true,
      primarySupplierId: true,
      coaUrl: true,
      strainType: true,
      terpeneProfile: true,
      nose: true,
      active: true,
    },
  })
  if (!product) throw new NotFoundError('That product does not exist.')

  if (patch.categoryId !== undefined && patch.categoryId !== product.categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: patch.categoryId },
      select: { active: true },
    })
    if (!category || !category.active) throw new NotFoundError('That category does not exist.')
  }
  if (patch.brandId != null && patch.brandId !== product.brandId) {
    const brand = await prisma.brand.findUnique({
      where: { id: patch.brandId },
      select: { id: true },
    })
    if (!brand) throw new NotFoundError('That brand does not exist.')
  }
  if (patch.primarySupplierId != null && patch.primarySupplierId !== product.primarySupplierId) {
    const supplier = await prisma.supplier.findUnique({
      where: { id: patch.primarySupplierId },
      select: { id: true },
    })
    if (!supplier) throw new NotFoundError('That supplier does not exist.')
  }

  const data = stripUndefined({
    ...patch,
    // An empty COA field means "no COA", which is null — never the empty string.
    ...(patch.coaUrl !== undefined ? { coaUrl: patch.coaUrl || null } : {}),
  })
  if (patch.name !== undefined && patch.name !== product.name) {
    data['slug'] = await uniqueProductSlug(patch.name, id)
  }

  const updated = await prisma.product.update({
    where: { id },
    data,
    select: { id: true, name: true, slug: true, active: true },
  })

  await audit(
    principal,
    'catalog.product.update',
    'Product',
    id,
    changedKeys(product, patch),
    changedKeys({ ...updated, ...data }, patch),
  )
  return updated
}

export interface ProductCreateInput {
  readonly name: string
  readonly categoryId: string
  readonly description?: string | null | undefined
  readonly brandId?: string | null | undefined
  readonly primarySupplierId?: string | null | undefined
  readonly coaUrl?: string | null | undefined
  readonly strainType?: string | null | undefined
  readonly terpeneProfile?: string | null | undefined
  readonly nose?: string | null | undefined
  readonly active?: boolean | undefined
  readonly variant: VariantCreateInput
}

/**
 * Create a product WITH its first variant, atomically.
 *
 * The variant is required, not optional: a product with no variant cannot be priced,
 * stocked, or sold, so a variantless create would only ever manufacture dead weight.
 * The nested create is one implicit transaction — same pattern as receiving's
 * quick-product, which stays deliberately separate (its rescue path creates INACTIVE
 * at zero price; this is deliberate admin creation and defaults active).
 */
export async function createProduct(principal: Principal, input: ProductCreateInput) {
  const category = await prisma.category.findUnique({
    where: { id: input.categoryId },
    select: { active: true },
  })
  if (!category || !category.active) throw new NotFoundError('That category does not exist.')

  if (input.brandId != null) {
    const brand = await prisma.brand.findUnique({
      where: { id: input.brandId },
      select: { id: true },
    })
    if (!brand) throw new NotFoundError('That brand does not exist.')
  }
  if (input.primarySupplierId != null) {
    const supplier = await prisma.supplier.findUnique({
      where: { id: input.primarySupplierId },
      select: { id: true },
    })
    if (!supplier) throw new NotFoundError('That supplier does not exist.')
  }

  const variant = input.variant
  const priceCents = variant.priceCents ?? null
  const priceGroupId = variant.priceGroupId ?? null
  assertPricingShape(variant.trackingMode, priceCents, priceGroupId)

  const minSaleBase = variant.minSaleBase ?? null
  const maxSaleBase = variant.maxSaleBase ?? null
  if (minSaleBase !== null && maxSaleBase !== null && minSaleBase > maxSaleBase) {
    throw new ValidationError('Minimum sale quantity cannot exceed the maximum.')
  }

  if (priceGroupId !== null) {
    const group = await prisma.priceGroup.findUnique({
      where: { id: priceGroupId },
      select: { id: true },
    })
    if (!group) throw new NotFoundError('That price group does not exist.')
  }
  await assertVariantUniqueness(variant.sku, variant.barcode ?? null, null, null)

  const slug = await uniqueProductSlug(input.name)

  const created = await prisma.product.create({
    data: {
      name: input.name,
      slug,
      categoryId: input.categoryId,
      description: input.description ?? null,
      brandId: input.brandId ?? null,
      primarySupplierId: input.primarySupplierId ?? null,
      // An empty COA field means "no COA", which is null — never the empty string.
      coaUrl: input.coaUrl || null,
      strainType: (input.strainType ?? null) as
        | NonNullable<Prisma.ProductUncheckedCreateInput['strainType']>
        | null,
      terpeneProfile: input.terpeneProfile ?? null,
      nose: input.nose ?? null,
      active: input.active ?? true,
      variants: {
        create: {
          sku: variant.sku,
          trackingMode: variant.trackingMode,
          label: variant.label ?? null,
          barcode: variant.barcode ?? null,
          priceCents,
          priceGroupId,
          taxable: variant.taxable ?? true,
          active: variant.active ?? true,
          minSaleBase,
          maxSaleBase,
          // No costCents — receiving owns cost. A hand-typed cost here would masquerade
          // as a paid price in every margin the basis feeds.
        },
      },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      active: true,
      variants: { select: { id: true, sku: true, trackingMode: true, active: true } },
    },
  })
  const createdVariant = created.variants[0]!

  // Two rows: the product's own birth record, and a variant-create row in the SAME shape
  // `createVariant` writes — so a variant's audit history reads uniformly whether it was
  // born with the product or added later.
  await audit(principal, 'catalog.product.create', 'Product', created.id, {}, {
    name: created.name,
    slug: created.slug,
    categoryId: input.categoryId,
    active: created.active,
  })
  await audit(principal, 'catalog.variant.create', 'ProductVariant', createdVariant.id,
    {}, { sku: createdVariant.sku, trackingMode: createdVariant.trackingMode })

  return {
    id: created.id,
    name: created.name,
    slug: created.slug,
    active: created.active,
    variant: createdVariant,
  }
}

// --- cannabinoid links ---------------------------------------------------------------------

export type { CannabinoidLinkInput }

export async function setProductCannabinoids(
  principal: Principal,
  productId: string,
  links: readonly CannabinoidLinkInput[],
) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
  if (!product) throw new NotFoundError('That product does not exist.')

  const ids = links.map((l) => l.cannabinoidId)
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('A cannabinoid can only be linked once per product.')
  }
  const known = await prisma.cannabinoid.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  if (known.length !== ids.length) throw new NotFoundError('That cannabinoid does not exist.')

  const before = await prisma.productCannabinoid.findMany({
    where: { productId },
    select: { cannabinoidId: true, mgPerUnit: true, percentBps: true },
  })

  await prisma.$transaction([
    prisma.productCannabinoid.deleteMany({ where: { productId } }),
    prisma.productCannabinoid.createMany({
      data: links.map((l) => ({
        productId,
        cannabinoidId: l.cannabinoidId,
        mgPerUnit: l.mgPerUnit,
        percentBps: l.percentBps,
      })),
    }),
  ])

  await audit(principal, 'catalog.product.cannabinoids', 'Product', productId,
    { links: before }, { links })
  return { count: links.length }
}

/**
 * The same full-array replace, one level down.
 *
 * A variant with zero links INHERITS the product's list (all-or-nothing — see
 * variant-identity.ts), so posting an empty array here is the documented way to hand a
 * strain back to the shelf's potency rather than a way to say "contains nothing".
 */
export async function setVariantCannabinoids(
  principal: Principal,
  variantId: string,
  links: readonly CannabinoidLinkInput[],
) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true },
  })
  if (!variant) throw new NotFoundError('That variant does not exist.')

  const ids = links.map((l) => l.cannabinoidId)
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('A cannabinoid can only be linked once per variant.')
  }
  const known = await prisma.cannabinoid.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  if (known.length !== ids.length) throw new NotFoundError('That cannabinoid does not exist.')

  const before = await prisma.variantCannabinoid.findMany({
    where: { variantId },
    select: { cannabinoidId: true, mgPerUnit: true, percentBps: true },
  })

  await prisma.$transaction([
    prisma.variantCannabinoid.deleteMany({ where: { variantId } }),
    prisma.variantCannabinoid.createMany({
      data: links.map((l) => ({
        variantId,
        cannabinoidId: l.cannabinoidId,
        mgPerUnit: l.mgPerUnit,
        percentBps: l.percentBps,
      })),
    }),
  ])

  await audit(principal, 'catalog.variant.cannabinoids', 'ProductVariant', variantId,
    { links: before }, { links })
  return { count: links.length }
}

// --- images --------------------------------------------------------------------------------

export type ImageInput = ProductImageInput

export async function setProductImages(
  principal: Principal,
  productId: string,
  images: readonly ImageInput[],
) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
  if (!product) throw new NotFoundError('That product does not exist.')

  const before = await prisma.productImage.findMany({
    where: { productId },
    select: { url: true, alt: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  })

  await prisma.$transaction([
    prisma.productImage.deleteMany({ where: { productId } }),
    prisma.productImage.createMany({
      data: images.map((image, index) => ({
        productId,
        url: image.url,
        alt: image.alt ?? null,
        // The array order IS the display order — sortOrder is derived, never sent.
        sortOrder: index,
      })),
    }),
  ])

  await audit(principal, 'catalog.product.images', 'Product', productId,
    { images: before.map((i) => i.url) }, { images: images.map((i) => i.url) })
  return { count: images.length }
}

// --- variants ------------------------------------------------------------------------------

export type VariantPatch = VariantPatchInput

/**
 * The pricing-mode shape the DB CHECK enforces, asserted here first so the admin gets a
 * sentence instead of a constraint name.
 */
function assertPricingShape(
  trackingMode: TrackingMode,
  priceCents: number | null,
  priceGroupId: string | null,
): void {
  if (trackingMode === TrackingMode.EACH) {
    if (priceGroupId !== null) {
      throw new ValidationError('EACH variants price per item — they cannot join a price group.')
    }
    if (priceCents === null) {
      throw new ValidationError('An EACH variant needs a price.')
    }
  } else {
    if (priceCents !== null) {
      throw new ValidationError(
        'WEIGHT variants price through their price group — edit the group on the Pricing page.',
      )
    }
    if (priceGroupId === null) {
      throw new ValidationError('A WEIGHT variant needs a price group.')
    }
  }
}

/**
 * A variant may name its own supplier, overriding the product's for sale attribution.
 * Only checked when it actually changes — the same shape as the price-group check above,
 * and for the same reason: a useful message ahead of the foreign key.
 */
async function assertSupplierExists(
  next: string | null | undefined,
  current: string | null = null,
): Promise<void> {
  if (next == null || next === current) return
  const supplier = await prisma.supplier.findUnique({ where: { id: next }, select: { id: true } })
  if (!supplier) throw new NotFoundError('That supplier does not exist.')
}

async function assertVariantUniqueness(
  sku: string | undefined,
  barcode: string | null | undefined,
  currentSku: string | null,
  currentBarcode: string | null,
): Promise<void> {
  if (sku !== undefined && sku !== currentSku) {
    const clash = await prisma.productVariant.findUnique({ where: { sku }, select: { id: true } })
    if (clash) throw new ConflictError('That SKU already exists in the catalog.')
  }
  if (barcode != null && barcode !== currentBarcode) {
    const clash = await prisma.productVariant.findUnique({
      where: { barcode },
      select: { id: true },
    })
    if (clash) throw new ConflictError('That barcode already exists in the catalog.')
  }
}

export async function updateVariant(principal: Principal, id: string, patch: VariantPatch) {
  const variant = await prisma.productVariant.findUnique({
    where: { id },
    select: {
      id: true,
      productId: true,
      trackingMode: true,
      label: true,
      sku: true,
      barcode: true,
      priceCents: true,
      priceGroupId: true,
      taxable: true,
      active: true,
      minSaleBase: true,
      maxSaleBase: true,
      strainType: true,
      terpeneProfile: true,
      nose: true,
      coaUrl: true,
      description: true,
      supplierId: true,
    },
  })
  if (!variant) throw new NotFoundError('That variant does not exist.')

  // Judge the row AS IT WILL BE — a patch that omits a field is checked against the
  // current value, exactly as the CHECK constraint will judge the UPDATE.
  const next = { ...variant, ...stripUndefined(patch) } as typeof variant
  assertPricingShape(variant.trackingMode as TrackingMode, next.priceCents, next.priceGroupId)
  if (next.minSaleBase !== null && next.maxSaleBase !== null && next.minSaleBase > next.maxSaleBase) {
    throw new ValidationError('Minimum sale quantity cannot exceed the maximum.')
  }

  if (patch.priceGroupId != null && patch.priceGroupId !== variant.priceGroupId) {
    const group = await prisma.priceGroup.findUnique({
      where: { id: patch.priceGroupId },
      select: { id: true },
    })
    if (!group) throw new NotFoundError('That price group does not exist.')
  }
  await assertSupplierExists(patch.supplierId, variant.supplierId)
  await assertVariantUniqueness(patch.sku, patch.barcode, variant.sku, variant.barcode)

  const updated = await prisma.productVariant.update({
    where: { id },
    // '' is coerced to null for coaUrl exactly as updateProduct does — the editor sends an
    // empty box to mean "no COA", and an empty string would defeat the inherit-on-null rule.
    data: {
      ...stripUndefined(patch),
      ...(patch.coaUrl !== undefined ? { coaUrl: patch.coaUrl || null } : {}),
    },
    select: {
      id: true,
      sku: true,
      barcode: true,
      label: true,
      priceCents: true,
      priceGroupId: true,
      taxable: true,
      active: true,
      minSaleBase: true,
      maxSaleBase: true,
      strainType: true,
      terpeneProfile: true,
      nose: true,
      coaUrl: true,
      description: true,
      supplierId: true,
    },
  })

  await audit(principal, 'catalog.variant.update', 'ProductVariant', id,
    changedKeys(variant, patch), changedKeys(updated, patch))
  return updated
}

export type { VariantCreateInput }

export async function createVariant(
  principal: Principal,
  productId: string,
  input: VariantCreateInput,
) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
  if (!product) throw new NotFoundError('That product does not exist.')

  const priceCents = input.priceCents ?? null
  const priceGroupId = input.priceGroupId ?? null
  assertPricingShape(input.trackingMode, priceCents, priceGroupId)

  const minSaleBase = input.minSaleBase ?? null
  const maxSaleBase = input.maxSaleBase ?? null
  if (minSaleBase !== null && maxSaleBase !== null && minSaleBase > maxSaleBase) {
    throw new ValidationError('Minimum sale quantity cannot exceed the maximum.')
  }

  if (priceGroupId !== null) {
    const group = await prisma.priceGroup.findUnique({
      where: { id: priceGroupId },
      select: { id: true },
    })
    if (!group) throw new NotFoundError('That price group does not exist.')
  }
  await assertSupplierExists(input.supplierId)
  await assertVariantUniqueness(input.sku, input.barcode ?? null, null, null)

  const created = await prisma.productVariant.create({
    data: {
      productId,
      sku: input.sku,
      trackingMode: input.trackingMode,
      label: input.label ?? null,
      barcode: input.barcode ?? null,
      priceCents,
      priceGroupId,
      taxable: input.taxable ?? true,
      active: input.active ?? true,
      minSaleBase,
      maxSaleBase,
      // Strain identity. Every one defaults to null = "inherit the product's", so a
      // packaged-goods variant created without them behaves exactly as before.
      // Same cast as createProduct: the wire type is a plain string (shared/ has no
      // @types dependency on the generated client), the column is the enum.
      strainType: (input.strainType ?? null) as
        | NonNullable<Prisma.ProductVariantUncheckedCreateInput['strainType']>
        | null,
      terpeneProfile: input.terpeneProfile ?? null,
      nose: input.nose ?? null,
      coaUrl: input.coaUrl || null,
      description: input.description ?? null,
      supplierId: input.supplierId ?? null,
      // No costCents — receiving owns cost. A hand-typed cost here would masquerade as a
      // paid price in every margin the basis feeds.
    },
    select: { id: true, sku: true, trackingMode: true, active: true },
  })

  await audit(principal, 'catalog.variant.create', 'ProductVariant', created.id,
    {}, { sku: created.sku, trackingMode: created.trackingMode })
  return created
}

// --- brands --------------------------------------------------------------------------------

export async function createBrand(principal: Principal, name: string) {
  const base = slugify(name)
  let slug = base
  for (let suffix = 0; suffix < 50; suffix += 1) {
    slug = suffix === 0 ? base : `${base}-${suffix + 1}`
    const taken = await prisma.brand.findUnique({ where: { slug }, select: { id: true } })
    if (!taken) break
    if (suffix === 49) throw new ConflictError('Too many brands share that name.')
  }

  const brand = await prisma.brand.create({
    data: { name, slug },
    select: { id: true, name: true },
  })
  await audit(principal, 'catalog.brand.create', 'Brand', brand.id, {}, { name })
  return brand
}
