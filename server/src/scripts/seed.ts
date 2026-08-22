/**
 * Database seed.
 *
 *   pnpm --filter @huta/server seed           reference data only
 *   pnpm --filter @huta/server seed:legacy    reference data + legacy catalog import
 *
 * Idempotent throughout: keyed on slug for reference data and on `legacyId` for imported
 * records, so re-running never duplicates. That is what lets the same code path serve as
 * a dev seed now and the real cutover import later.
 *
 * The legacy MySQL database is read STRICTLY read-only.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  CANNABINOID_SEED,
  CATEGORY_SEED,
  type Cents,
  DiscountType,
  FLOWER_PRICE_GROUP_SLUG,
  MovementType,
  PromotionScope,
  Role,
  TrackingMode,
  WEIGHT,
  cents,
  slugify,
} from '@huta/shared'

import { prisma } from '../db/client.js'
import { pinLookup, randomToken, sha256 } from '../lib/crypto.js'
import { hashSecret } from '../lib/password.js'
import { matchBrand } from './legacy/brands.js'
import {
  assertAliasesAreSeeded,
  parseCannabinoidColumn,
  parseCannabinoidsFromTitle,
} from './legacy/cannabinoids.js'
import {
  connectLegacy,
  fetchLegacyProducts,
  fetchLegacySuppliers,
  type LegacyProduct,
} from './legacy/connect.js'
import {
  CATEGORY_MAP,
  COUNT_ANOMALIES,
  EXCLUDED_LEGACY_IDS,
  STOCK_OVERRIDES,
  WEIGHT_TRACKED,
  legacyPriceToCents,
  legacySku,
  perUnitPotencyMg,
  productSlug,
  variantLabel,
} from './legacy/map-product.js'
import { ImportReport } from './legacy/report.js'

const report = new ImportReport()

/**
 * Georgia STATE sales tax only, per instruction: 4.00%.
 *
 * Almost every Georgia county adds a local option tax of 3–4% on top, so the real
 * register rate is probably 7–8%. Confirm the combined rate per location before go-live —
 * it is one field on Store.
 */
const GA_STATE_TAX_BPS = 400

const STORES = [
  { slug: 'baytree', name: 'Main Store (Baytree)' },
  { slug: 'ashley', name: 'Ashley Location' },
] as const

/** The store legacy inventory lands at. Ashley starts empty, like a new location would. */
const PRIMARY_STORE_SLUG = 'baytree'

// ---------------------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------------------

async function seedCategories(): Promise<void> {
  let sortOrder = 0
  for (const parent of CATEGORY_SEED) {
    // `?? null` rather than a conditional spread: an admin who clears a default should not
    // have the next seed run silently restore it, and leaving the key out would do exactly
    // that. The seed is the source of truth for THIS column.
    const parentReorder = parent.reorderBase ?? null
    const created = await prisma.category.upsert({
      where: { slug: parent.slug },
      update: { name: parent.name, sortOrder, defaultReorderBase: parentReorder },
      create: {
        slug: parent.slug,
        name: parent.name,
        sortOrder,
        defaultReorderBase: parentReorder,
      },
    })
    sortOrder += 1
    report.count('categories')

    for (const child of parent.children ?? []) {
      const childReorder = child.reorderBase ?? null
      await prisma.category.upsert({
        where: { slug: child.slug },
        update: {
          name: child.name,
          parentId: created.id,
          sortOrder,
          defaultReorderBase: childReorder,
        },
        create: {
          slug: child.slug,
          name: child.name,
          parentId: created.id,
          sortOrder,
          defaultReorderBase: childReorder,
        },
      })
      sortOrder += 1
      report.count('categories')
    }
  }
}

async function seedCannabinoids(): Promise<void> {
  let sortOrder = 0
  for (const c of CANNABINOID_SEED) {
    await prisma.cannabinoid.upsert({
      where: { slug: c.slug },
      update: { name: c.name, sortOrder },
      create: { slug: c.slug, name: c.name, sortOrder },
    })
    sortOrder += 1
    report.count('cannabinoids')
  }
}

/**
 * Two flower price groups: Regular Flower sells at $10/g and Moonrock at $15/g. The
 * price-group design exists precisely so different quality tiers price independently
 * while each stays a one-edit change.
 *
 * Tier prices are PLACEHOLDERS pending the real numbers.
 */
async function seedPriceGroups(): Promise<void> {
  const groups = [
    {
      slug: 'flower',
      name: 'Flower',
      basePricePerGramCents: 1000,
      tiers: [
        { minQuantityBase: WEIGHT.EIGHTH, totalPriceCents: 3000 },
        { minQuantityBase: WEIGHT.QUARTER, totalPriceCents: 5500 },
        { minQuantityBase: WEIGHT.OUNCE, totalPriceCents: 20_000 },
      ],
    },
    {
      slug: 'premium-flower',
      name: 'Premium Flower',
      basePricePerGramCents: 1500,
      tiers: [
        { minQuantityBase: WEIGHT.EIGHTH, totalPriceCents: 4500 },
        { minQuantityBase: WEIGHT.QUARTER, totalPriceCents: 8500 },
        { minQuantityBase: WEIGHT.OUNCE, totalPriceCents: 30_000 },
      ],
    },
  ]

  for (const group of groups) {
    const saved = await prisma.priceGroup.upsert({
      where: { slug: group.slug },
      update: { name: group.name, basePricePerGramCents: group.basePricePerGramCents },
      create: {
        slug: group.slug,
        name: group.name,
        basePricePerGramCents: group.basePricePerGramCents,
      },
    })
    report.count('price groups')

    for (const tier of group.tiers) {
      await prisma.priceTier.upsert({
        where: {
          priceGroupId_minQuantityBase: {
            priceGroupId: saved.id,
            minQuantityBase: tier.minQuantityBase,
          },
        },
        update: { totalPriceCents: tier.totalPriceCents },
        create: {
          priceGroupId: saved.id,
          minQuantityBase: tier.minQuantityBase,
          totalPriceCents: tier.totalPriceCents,
        },
      })
      report.count('price tiers')
    }
  }
}

/**
 * Demo promotions, so `PricingService` has something real to resolve in development.
 *
 * DEV FIXTURES, like the terminal tokens below — clearly named so nobody mistakes them for
 * real campaigns, and keyed on fixed ids so re-running the seed updates rather than
 * duplicates them. Promotion has no natural unique key to upsert on.
 *
 * Only seeded alongside the legacy catalog, because without products there is nothing for
 * a product-scoped promotion to point at.
 */
async function seedDemoPromotions(): Promise<void> {
  // A flower strain to hang the strain-level promo on — the capability Kasan asked for in
  // the opening brief ("promo pricing on strains").
  const strain = await prisma.product.findFirst({
    where: { variants: { some: { trackingMode: TrackingMode.WEIGHT } } },
    select: {
      id: true,
      name: true,
      variants: { select: { priceGroupId: true }, take: 1 },
    },
    orderBy: { name: 'asc' },
  })

  // Deliberately the group that strain actually prices through, rather than
  // FLOWER_PRICE_GROUP_SLUG. The two demo promotions have to land on the SAME product or
  // they demonstrate nothing — the whole point is watching the best-outcome comparison
  // choose between them.
  const groupId =
    strain?.variants[0]?.priceGroupId ??
    (
      await prisma.priceGroup.findUnique({
        where: { slug: FLOWER_PRICE_GROUP_SLUG },
        select: { id: true },
      })
    )?.id

  if (!groupId || !strain) return
  const flowerGroup = { id: groupId }

  const startsAt = new Date(Date.now() - 60 * 60 * 1000)

  // The update branch sets EVERY defining field, not just the volatile ones. An update
  // narrower than its create silently preserves stale targeting: this promotion kept
  // pointing at the wrong price group across a re-seed until it was caught by hand.
  const strainPromo = {
    name: `DEMO — 15% off ${strain.name}`,
    scopeType: PromotionScope.PRODUCT,
    productId: strain.id,
    priceGroupId: null,
    variantId: null,
    categoryId: null,
    discountType: DiscountType.PERCENT_OFF,
    value: 1500,
    startsAt,
    endsAt: null,
    stackable: false,
    active: true,
  }
  await prisma.promotion.upsert({
    where: { id: 'seed-demo-strain-promo' },
    update: strainPromo,
    create: { id: 'seed-demo-strain-promo', ...strainPromo },
  })
  report.count('promotions')

  const groupPromo = {
    name: 'DEMO — $5 off flower by the group',
    scopeType: PromotionScope.PRICE_GROUP,
    priceGroupId: flowerGroup.id,
    productId: null,
    variantId: null,
    categoryId: null,
    discountType: DiscountType.AMOUNT_OFF,
    value: 500,
    startsAt,
    endsAt: null,
    // Stackable, so the best-outcome comparison has both candidates to weigh.
    stackable: true,
    active: true,
  }
  await prisma.promotion.upsert({
    where: { id: 'seed-demo-flower-group-promo' },
    update: groupPromo,
    create: { id: 'seed-demo-flower-group-promo', ...groupPromo },
  })
  report.count('promotions')
}

async function seedStoresAndUsers(): Promise<Array<{ store: string; token: string }>> {
  for (const store of STORES) {
    await prisma.store.upsert({
      where: { slug: store.slug },
      update: { name: store.name, taxRateBps: GA_STATE_TAX_BPS },
      create: {
        slug: store.slug,
        name: store.name,
        taxRateBps: GA_STATE_TAX_BPS,
        timezone: 'America/New_York',
      },
    })
    report.count('stores')
  }

  // DEV CREDENTIALS. Real argon2id hashes — the values are weak on purpose and are
  // written to a gitignored file rather than printed, because the house rules forbid logging
  // PINs and tokens. Admins get a PIN too so they can ring sales at any terminal.
  const ADMIN_PASSWORD = 'huta-dev-admin'

  // An ADMIN must have storeId NULL and an email + password — both enforced by CHECK
  // constraints. `update` carries the auth fields so re-seeding repairs a row that still
  // holds a pre-auth placeholder, rather than leaving it broken forever.
  const adminPin = '9000'
  await prisma.user.upsert({
    where: { email: 'admin@huta.local' },
    update: {
      passwordHash: await hashSecret(ADMIN_PASSWORD),
      pinHash: await hashSecret(adminPin),
      pinLookup: pinLookup(adminPin),
    },
    create: {
      email: 'admin@huta.local',
      passwordHash: await hashSecret(ADMIN_PASSWORD),
      firstName: 'Huta',
      lastName: 'Admin',
      role: Role.ADMIN,
      pinHash: await hashSecret(adminPin),
      pinLookup: pinLookup(adminPin),
    },
  })
  report.count('users')

  // A STAFF member must have a storeId and a PIN, and must NOT have a password — staff
  // exist only at the register.
  const staff = [
    { store: 'baytree', email: 'baytree.staff@huta.local', first: 'Baytree', pin: '1111' },
    { store: 'ashley', email: 'ashley.staff@huta.local', first: 'Ashley', pin: '2222' },
  ]
  const deviceTokens: Array<{ store: string; token: string }> = []

  for (const person of staff) {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: person.store } })
    await prisma.user.upsert({
      where: { email: person.email },
      update: {
        passwordHash: null,
        pinHash: await hashSecret(person.pin),
        pinLookup: pinLookup(person.pin),
      },
      create: {
        email: person.email,
        firstName: person.first,
        lastName: 'Staff',
        role: Role.STAFF,
        storeId: store.id,
        pinHash: await hashSecret(person.pin),
        pinLookup: pinLookup(person.pin),
      },
    })
    report.count('users')

    // Upsert on (storeId, name), NOT on tokenHash. Keying on the token would mean a
    // regenerated token creates a SECOND terminal instead of rotating the first.
    const deviceToken = randomToken(48)
    await prisma.terminal.upsert({
      where: { storeId_name: { storeId: store.id, name: `${store.name} Register 1` } },
      update: { tokenHash: sha256(deviceToken), active: true },
      create: {
        storeId: store.id,
        name: `${store.name} Register 1`,
        tokenHash: sha256(deviceToken),
      },
    })
    deviceTokens.push({ store: store.name, token: deviceToken })
    report.count('terminals')

    await prisma.storeCounter.upsert({
      where: { storeId_name: { storeId: store.id, name: 'sale_number' } },
      update: {},
      create: { storeId: store.id, name: 'sale_number' },
    })
  }

  return deviceTokens
}

// ---------------------------------------------------------------------------------------
// Legacy import
// ---------------------------------------------------------------------------------------

interface VariantPlan {
  readonly row: LegacyProduct
  readonly brandName: string | null
  readonly cannabinoidSlugs: string[]
}

async function importLegacy(): Promise<void> {
  assertAliasesAreSeeded()

  const connection = await connectLegacy()
  try {
    const suppliers = await fetchLegacySuppliers(connection)
    const products = await fetchLegacyProducts(connection)

    // --- suppliers -------------------------------------------------------------------
    const supplierIdByLegacy = new Map<number, string>()
    for (const s of suppliers) {
      const saved = await prisma.supplier.upsert({
        where: { legacyId: String(s.id) },
        update: {},
        create: {
          legacyId: String(s.id),
          name: s.company,
          slug: slugify(s.company),
          ...(s.website ? { website: s.website } : {}),
          ...(s.contact_name ? { contactName: s.contact_name } : {}),
          ...(s.contact_phone ? { phone: s.contact_phone } : {}),
          ...(s.contact_email ? { email: s.contact_email } : {}),
        },
      })
      supplierIdByLegacy.set(s.id, saved.id)
      report.count('suppliers')
    }

    // --- plan: resolve brand + cannabinoids, group by slug ----------------------------
    const groups = new Map<string, VariantPlan[]>()

    for (const row of products) {
      const excluded = EXCLUDED_LEGACY_IDS.get(row.id)
      if (excluded) {
        report.note('Excluded rows', `#${row.id} ${row.title} — ${excluded}`)
        continue
      }

      const brand = matchBrand(row.title)
      if (!brand) {
        report.note(
          'No brand identified',
          `#${row.id} ${row.title}`,
          'Imported with brandId null. Mostly accessories and house generics.',
        )
      }

      // Column first, then the title with the brand prefix stripped.
      const fromColumn = parseCannabinoidColumn(row.cannabinoids)
      const fromTitle = parseCannabinoidsFromTitle(brand ? brand.remainder : row.title)
      const cannabinoidSlugs = [...new Set([...fromColumn, ...fromTitle])]

      const anomaly = COUNT_ANOMALIES.get(row.id)
      if (anomaly) report.note('Suspect count values', `#${row.id} ${row.title} — ${anomaly}`)

      const slug = productSlug(row.title)
      const existing = groups.get(slug)
      const plan: VariantPlan = {
        row,
        brandName: brand?.brandName ?? null,
        cannabinoidSlugs,
      }
      if (existing) existing.push(plan)
      else groups.set(slug, [plan])
    }

    // --- brands ----------------------------------------------------------------------
    const brandIdByName = new Map<string, string>()
    const brandNames = new Set<string>()
    for (const plans of groups.values()) {
      for (const plan of plans) if (plan.brandName) brandNames.add(plan.brandName)
    }
    for (const name of [...brandNames].sort()) {
      const saved = await prisma.brand.upsert({
        where: { slug: slugify(name) },
        update: {},
        create: { name, slug: slugify(name) },
      })
      brandIdByName.set(name, saved.id)
      report.count('brands')
    }

    // --- lookups ---------------------------------------------------------------------
    const categoryIdBySlug = new Map(
      (await prisma.category.findMany()).map((c) => [c.slug, c.id]),
    )
    const cannabinoidIdBySlug = new Map(
      (await prisma.cannabinoid.findMany()).map((c) => [c.slug, c.id]),
    )
    const priceGroupIdBySlug = new Map(
      (await prisma.priceGroup.findMany()).map((g) => [g.slug, g.id]),
    )
    const primaryStore = await prisma.store.findUniqueOrThrow({
      where: { slug: PRIMARY_STORE_SLUG },
    })

    // --- products and variants -------------------------------------------------------
    for (const [slug, plans] of groups) {
      const first = plans[0]
      if (!first) continue

      const categorySlug = CATEGORY_MAP.get(first.row.category) ?? 'other'
      const categoryId = categoryIdBySlug.get(categorySlug)
      if (!categoryId) throw new Error(`Category slug not seeded: ${categorySlug}`)

      // Union the cannabinoids across the group's variants — they describe the product.
      const unionCannabinoids = [...new Set(plans.flatMap((p) => p.cannabinoidSlugs))]
      const brandName = plans.find((p) => p.brandName)?.brandName ?? null
      const supplierLegacyId = plans.find((p) => p.row.supplier !== null)?.row.supplier ?? null

      const product = await prisma.product.upsert({
        where: { legacyId: String(first.row.id) },
        update: {},
        create: {
          legacyId: String(first.row.id),
          name: first.row.title.trim(),
          slug,
          categoryId,
          ...(brandName && brandIdByName.has(brandName)
            ? { brandId: brandIdByName.get(brandName)! }
            : {}),
          ...(supplierLegacyId !== null && supplierIdByLegacy.has(supplierLegacyId)
            ? { primarySupplierId: supplierIdByLegacy.get(supplierLegacyId)! }
            : {}),
          ...(first.row.description ? { description: first.row.description } : {}),
        },
      })
      report.count('products')

      for (const cannabinoidSlug of unionCannabinoids) {
        const cannabinoidId = cannabinoidIdBySlug.get(cannabinoidSlug)
        if (!cannabinoidId) {
          report.note('Unmapped cannabinoid slug', `${cannabinoidSlug} (product ${slug})`)
          continue
        }
        // Potency stays null unless a variant gives us a real mg figure. Allowed since
        // the relax_potency migration: "contains Delta-8, potency unknown" is legitimate.
        const mg = plans.map((p) => perUnitPotencyMg(p.row)).find((v) => v !== null) ?? null
        await prisma.productCannabinoid.upsert({
          where: { productId_cannabinoidId: { productId: product.id, cannabinoidId } },
          update: {},
          create: {
            productId: product.id,
            cannabinoidId,
            ...(mg === null ? {} : { mgPerUnit: mg }),
          },
        })
        report.count('cannabinoid links')
      }

      // Images (hot-linked third-party URLs; expect some 404s).
      const imageUrl = plans.find((p) => p.row.image)?.row.image
      if (imageUrl) {
        const existingImage = await prisma.productImage.findFirst({
          where: { productId: product.id, url: imageUrl },
        })
        if (!existingImage) {
          await prisma.productImage.create({ data: { productId: product.id, url: imageUrl } })
          report.count('images')
        }
      }

      for (const plan of plans) {
        await createVariant(plan, product.id, priceGroupIdBySlug, primaryStore.id)
      }
    }

    report.note(
      'Suspected duplicate — needs human resolution',
      'Glass Bong: legacy #160 ($80, no supplier) vs #221 ($0, supplier 2)',
      'Different price and supplier, so not auto-merged. Both imported; #221 is inactive.',
    )
  } finally {
    await connection.end()
  }
}

async function createVariant(
  plan: VariantPlan,
  productId: string,
  priceGroupIdBySlug: Map<string, string>,
  storeId: string,
): Promise<void> {
  const { row } = plan
  const weightGroupSlug = WEIGHT_TRACKED.get(row.id)
  const priceCents = legacyPriceToCents(row.price)
  const costCents = legacyPriceToCents(row.purchase_price)
  const label = variantLabel(row)

  // Zero-price rows are unfinished catalog stubs. Import them inactive so they cannot be
  // rung up by accident, and report them.
  const isZeroPrice = !weightGroupSlug && (priceCents === null || priceCents === 0)
  if (isZeroPrice) {
    report.note(
      'Zero price — imported inactive',
      `#${row.id} ${row.title}`,
      'Unfinished catalog stubs. Price and activate them in admin.',
    )
  }

  // The pricing-mode CHECK constraint: EACH needs priceCents and no group; WEIGHT needs a
  // group and no priceCents.
  const pricing = weightGroupSlug
    ? {
        trackingMode: TrackingMode.WEIGHT,
        priceGroupId: priceGroupIdBySlug.get(weightGroupSlug)!,
      }
    : {
        trackingMode: TrackingMode.EACH,
        priceCents: (priceCents ?? cents(0)) as Cents,
      }

  const variant = await prisma.productVariant.upsert({
    where: { legacyId: String(row.id) },
    update: {},
    create: {
      legacyId: String(row.id),
      productId,
      sku: legacySku(row.id),
      ...(label ? { label } : {}),
      ...pricing,
      ...(costCents === null ? {} : { costCents }),
      active: !isZeroPrice,
    },
  })
  report.count('variants')

  // --- opening stock ---------------------------------------------------------------
  const override = STOCK_OVERRIDES.get(row.id)
  if (override !== undefined) {
    report.note(
      'Stock sentinel clamped to zero',
      `#${row.id} ${row.title} — legacy on_hand ${row.on_hand}`,
      'Sentinel "never runs out" values and oversell drift, not real counts.',
    )
  }
  const rawQuantity = override ?? row.on_hand
  // WEIGHT variants count milligrams; a legacy unit count is meaningless for them.
  const quantityBase = weightGroupSlug ? 0 : Math.max(0, rawQuantity)

  const existingStock = await prisma.stockLevel.findUnique({
    where: { storeId_variantId: { storeId, variantId: variant.id } },
  })
  if (existingStock) return

  await prisma.$transaction(async (tx) => {
    await tx.stockLevel.create({
      data: {
        storeId,
        variantId: variant.id,
        quantityBase,
        ...(row.on_low === null ? {} : { reorderPointBase: row.on_low }),
      },
    })
    // The ledger rule: a stock change and its movement in one transaction. A zero
    // movement would violate InventoryMovement_nonzero_check, so only write one when
    // there is actually stock.
    if (quantityBase > 0) {
      await tx.inventoryMovement.create({
        data: {
          storeId,
          variantId: variant.id,
          type: MovementType.RECEIVE,
          quantityBase,
          balanceAfterBase: quantityBase,
          note: `Legacy import: opening stock from huta-old product #${row.id}`,
        },
      })
    }
  })
  report.count('stock levels')
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const withLegacy = process.argv.includes('--legacy')

  console.log('Seeding reference data…')
  await seedCategories()
  await seedCannabinoids()
  await seedPriceGroups()
  const deviceTokens = await seedStoresAndUsers()

  if (withLegacy) {
    console.log('Importing legacy catalog from huta-old (read-only)…')
    await importLegacy()
    await seedDemoPromotions()
  }

  const rendered = report.render()
  console.log(`\n${rendered}\n`)

  const outDir = path.join(process.cwd(), 'tmp')
  mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'import-report.txt')
  writeFileSync(outFile, rendered, 'utf8')
  console.log(`Report written to ${outFile}`)

  // Credentials go to a gitignored FILE, not to stdout. the house rules forbid logging PINs
  // and tokens, and a device token in a terminal scrollback is a device token in a
  // screenshot.
  const credentialsFile = path.join(outDir, 'dev-credentials.txt')
  writeFileSync(
    credentialsFile,
    [
      'HUTA POS — DEV CREDENTIALS. Not production values. Do not commit.',
      '',
      `admin@huta.local / ${'huta-dev-admin'}   (ADMIN, no store, PIN 9000)`,
      'baytree.staff@huta.local  PIN 1111  (STAFF, Main Store (Baytree))',
      'ashley.staff@huta.local   PIN 2222  (STAFF, Ashley Location)',
      '',
      'Device tokens (send as the huta_dt cookie or X-Device-Token header):',
      ...deviceTokens.map((d) => `  ${d.store}: ${d.token}`),
    ].join('\n'),
    'utf8',
  )

  console.log(
    [
      '',
      `Dev credentials and device tokens written to ${credentialsFile}`,
      'They are deliberately not printed here — the house rules forbid logging PINs and tokens.',
      '',
      `Tax seeded at ${GA_STATE_TAX_BPS / 100}% (Georgia STATE rate only).`,
      'Most GA counties add 3-4% local option tax — confirm the combined rate per store.',
    ].join('\n'),
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
