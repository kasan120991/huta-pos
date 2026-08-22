import {
  DiscountType,
  MovementType,
  PromotionScope,
  Role,
  TrackingMode,
} from '@huta/shared'

import { prisma } from '../../src/db/client.js'
import { pinLookup, sha256 } from '../../src/lib/crypto.js'
import { hashSecret } from '../../src/lib/password.js'

/**
 * Test fixtures. Deliberately minimal — each test builds only what it asserts on, so a
 * failure points at one thing rather than a shared world.
 */

/** Cached after the first lookup — the table list does not change during a run. */
let resetStatement: string | null = null

/**
 * Wipe every table except the migration history.
 *
 * A single statement of CTE DELETEs, not TRUNCATE. Three versions of this now, each fixing
 * the last:
 *
 *  1. A loop of 41 separate `TRUNCATE … CASCADE` calls — **9.5s** per reset, because each
 *     takes an ACCESS EXCLUSIVE lock on its table plus everything reachable through the
 *     schema's 82 foreign keys, re-locking most of the database 41 times.
 *  2. One combined `TRUNCATE a, b, c … CASCADE` — **1.3s**. One lock acquisition, but
 *     TRUNCATE still does file-level work and an fsync per relation, and that floor does
 *     not move. At 143 integration tests it was 183 seconds of pure setup, which was the
 *     entire suite runtime and what pushed `beforeEach` past its hook timeout.
 *  3. This: `WITH d1 AS (DELETE FROM …), d2 AS (DELETE FROM …) SELECT 1` — **73ms**.
 *
 * DELETE beats TRUNCATE here precisely because the tables are tiny: it stays in row space
 * and touches no files. Every delete lives in ONE statement, so they share a snapshot and
 * foreign keys are checked once at statement end — no ordering to maintain, and no
 * DEFERRABLE constraints needed, which matters because Prisma does not declare any.
 *
 * `RESTART IDENTITY` is not missed: every primary key in this schema is a `cuid()`, so
 * there are no sequences to reset. Measured — it made no difference to TRUNCATE either.
 */
export async function resetDatabase(): Promise<void> {
  if (resetStatement === null) {
    const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
       ORDER BY tablename
    `
    const clauses = rows.map((r, i) => `d${i} AS (DELETE FROM "${r.tablename}")`)
    resetStatement = `WITH ${clauses.join(', ')} SELECT 1`
  }
  await prisma.$executeRawUnsafe(resetStatement)
}

export async function makeStore(name: string, slug: string, timezone?: string) {
  return prisma.store.create({
    data: { name, slug, taxRateBps: 400, ...(timezone ? { timezone } : {}) },
  })
}

export async function makeAdmin(email = 'admin@test.local', password = 'test-password') {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashSecret(password),
      firstName: 'Test',
      lastName: 'Admin',
      role: Role.ADMIN,
    },
  })
}

export async function makeStaff(storeId: string, pin: string, email = 'staff@test.local') {
  return prisma.user.create({
    data: {
      email,
      firstName: 'Test',
      lastName: 'Staff',
      role: Role.STAFF,
      storeId,
      pinHash: await hashSecret(pin),
      pinLookup: pinLookup(pin),
    },
  })
}

export async function makeTerminal(storeId: string, token: string, name = 'Register 1') {
  return prisma.terminal.create({
    data: { storeId, name, tokenHash: sha256(token) },
  })
}

export interface VariantSpec {
  readonly label?: string
  readonly priceCents?: number | null
  readonly costCents?: number
  readonly trackingMode?: TrackingMode
}

export interface ProductSpec {
  readonly name: string
  readonly categoryId: string
  readonly cannabinoidIds?: readonly string[]
  readonly priceCents?: number
  readonly costCents?: number
  /** When given, replaces the single default variant. */
  readonly variants?: readonly VariantSpec[]
  /** ProductImage rows. sortOrder is explicit so a test can pin the orderBy, not insert order. */
  readonly images?: ReadonlyArray<{ readonly url: string; readonly sortOrder?: number }>
}

export async function makeCategory(
  name: string,
  slug: string,
  parentId?: string,
  defaultReorderBase?: number,
) {
  return prisma.category.create({
    data: {
      name,
      slug,
      ...(parentId === undefined ? {} : { parentId }),
      ...(defaultReorderBase === undefined ? {} : { defaultReorderBase }),
    },
  })
}

export async function makeCannabinoid(name: string, slug: string) {
  return prisma.cannabinoid.create({ data: { name, slug } })
}

let skuCounter = 0

/**
 * A price group for WEIGHT variants, created on demand.
 *
 * `ProductVariant_pricing_mode_check` requires a WEIGHT variant to have a `priceGroupId`
 * and no `priceCents` — flower prices through a group, never per item. A test that wants a
 * weight-tracked variant therefore needs a group whether it cares about pricing or not.
 */
async function weightPriceGroup() {
  return prisma.priceGroup.upsert({
    where: { slug: 'test-flower' },
    update: {},
    create: { name: 'Test Flower', slug: 'test-flower', basePricePerGramCents: 1000 },
  })
}

export async function makeProduct(spec: ProductSpec) {
  skuCounter += 1

  const needsGroup = (spec.variants ?? []).some((v) => v.trackingMode === TrackingMode.WEIGHT)
  const priceGroupId = needsGroup ? (await weightPriceGroup()).id : null
  return prisma.product.create({
    data: {
      name: spec.name,
      slug: `${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${skuCounter}`,
      categoryId: spec.categoryId,
      ...(spec.cannabinoidIds && spec.cannabinoidIds.length > 0
        ? {
            cannabinoids: {
              create: spec.cannabinoidIds.map((cannabinoidId) => ({
                cannabinoidId,
                mgPerUnit: 25,
              })),
            },
          }
        : {}),
      ...(spec.images && spec.images.length > 0
        ? {
            images: {
              create: spec.images.map((img, i) => ({
                url: img.url,
                sortOrder: img.sortOrder ?? i,
              })),
            },
          }
        : {}),
      variants: {
        create: (spec.variants ?? [{}]).map((variant, i) => {
          const mode = variant.trackingMode ?? TrackingMode.EACH
          const cost = variant.costCents ?? spec.costCents
          return {
            // Deliberately DESCENDING with the index, so a test whose variants are given in
            // price order gets SKUs in the reverse. Ordering by SKU is the bug being
            // guarded against, and a SKU that agreed with price would hide it.
            sku: `TEST-${skuCounter}-${String(99 - i).padStart(2, '0')}`,
            ...(variant.label === undefined ? {} : { label: variant.label }),
            trackingMode: mode,
            // A WEIGHT variant must have no per-item price and MUST have a price group —
            // the CHECK constraint enforces that it prices through the group instead.
            priceCents:
              mode === TrackingMode.WEIGHT
                ? null
                : variant.priceCents === undefined
                  ? (spec.priceCents ?? 1000)
                  : variant.priceCents,
            ...(mode === TrackingMode.WEIGHT && priceGroupId !== null ? { priceGroupId } : {}),
            ...(cost === undefined ? {} : { costCents: cost }),
          }
        }),
      },
    },
    include: { variants: true },
  })
}

export async function makePriceGroup(
  name: string,
  slug: string,
  basePricePerGramCents: number,
  tiers: ReadonlyArray<{ minQuantityBase: number; totalPriceCents: number }> = [],
) {
  return prisma.priceGroup.create({
    data: {
      name,
      slug,
      basePricePerGramCents,
      tiers: { create: tiers.map((t) => ({ ...t })) },
    },
    include: { tiers: { orderBy: { minQuantityBase: 'asc' } } },
  })
}

/**
 * A weight-tracked product priced through a group.
 *
 * Separate from `makeProduct` because the pricing CHECK constraint requires a WEIGHT
 * variant to carry a `priceGroupId` and no `priceCents` — flower prices through a group,
 * never per item.
 */
export async function makeWeightProduct(spec: {
  name: string
  categoryId: string
  priceGroupId: string
  costCents?: number
}) {
  skuCounter += 1
  return prisma.product.create({
    data: {
      name: spec.name,
      slug: `${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${skuCounter}`,
      categoryId: spec.categoryId,
      variants: {
        create: {
          sku: `WGT-${skuCounter}`,
          trackingMode: TrackingMode.WEIGHT,
          priceCents: null,
          priceGroupId: spec.priceGroupId,
          ...(spec.costCents === undefined ? {} : { costCents: spec.costCents }),
        },
      },
    },
    include: { variants: true },
  })
}

export interface PromotionSpec {
  readonly name: string
  readonly scopeType: PromotionScope
  readonly discountType: DiscountType
  /** Basis points for PERCENT_OFF, cents otherwise. */
  readonly value: number
  readonly stackable?: boolean
  readonly active?: boolean
  readonly startsAt?: Date
  readonly endsAt?: Date | null
  /** Exactly one of these must be set, matching scopeType — the DB CHECK enforces it. */
  readonly variantId?: string
  readonly productId?: string
  readonly categoryId?: string
  readonly priceGroupId?: string
  /** No entries means every store. */
  readonly storeIds?: readonly string[]
}

export async function makePromotion(spec: PromotionSpec) {
  return prisma.promotion.create({
    data: {
      name: spec.name,
      scopeType: spec.scopeType,
      discountType: spec.discountType,
      value: spec.value,
      stackable: spec.stackable ?? false,
      active: spec.active ?? true,
      startsAt: spec.startsAt ?? new Date(Date.now() - 60_000),
      endsAt: spec.endsAt === undefined ? null : spec.endsAt,
      ...(spec.variantId === undefined ? {} : { variantId: spec.variantId }),
      ...(spec.productId === undefined ? {} : { productId: spec.productId }),
      ...(spec.categoryId === undefined ? {} : { categoryId: spec.categoryId }),
      ...(spec.priceGroupId === undefined ? {} : { priceGroupId: spec.priceGroupId }),
      ...(spec.storeIds && spec.storeIds.length > 0
        ? { stores: { create: spec.storeIds.map((storeId) => ({ storeId })) } }
        : {}),
    },
  })
}

/**
 * Stock without going through the service.
 *
 * `costBasisCents` is optional and defaults to absent, so stock seeded this way is
 * UNCOSTED — which is what most tests want, and matches the 144 legacy rows that carry a
 * quantity but no known cost. Pass it when a test needs a pool with a cost already in it.
 */
export async function giveStock(
  storeId: string,
  variantId: string,
  quantityBase: number,
  costBasisCents?: number,
) {
  await prisma.stockLevel.create({
    data: {
      storeId,
      variantId,
      quantityBase,
      ...(costBasisCents === undefined ? {} : { costBasisCents }),
    },
  })
  if (quantityBase > 0) {
    await prisma.inventoryMovement.create({
      data: {
        storeId,
        variantId,
        type: MovementType.RECEIVE,
        quantityBase,
        balanceAfterBase: quantityBase,
        ...(costBasisCents === undefined ? {} : { costBasisAfterCents: costBasisCents }),
      },
    })
  }
}

export async function makeSupplier(
  name = 'Test Distribution',
  overrides: {
    slug?: string
    accountNumber?: string
    paymentTerms?: string
    minimumOrderCents?: number
    notes?: string
    active?: boolean
  } = {},
) {
  return prisma.supplier.create({
    data: {
      name,
      slug: overrides.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      contactName: 'Dana Reyes',
      phone: '555-0142',
      email: 'dana@example.test',
      accountNumber: overrides.accountNumber ?? 'ACCT-9001',
      paymentTerms: overrides.paymentTerms ?? 'Net 30',
      minimumOrderCents: overrides.minimumOrderCents ?? 50_000,
      notes: overrides.notes ?? 'Internal: renegotiate terms in Q3.',
      ...(overrides.active === undefined ? {} : { active: overrides.active }),
    },
  })
}
