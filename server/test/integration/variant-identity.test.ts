import { Role, TrackingMode } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import {
  createVariant,
  setProductCannabinoids,
  setVariantCannabinoids,
  updateVariant,
} from '../../src/catalog/catalog-admin.service.js'
import { getProduct } from '../../src/catalog/catalog.service.js'
import {
  bearsCannabinoids,
  resolveSupplierId,
  resolveVariantCannabinoids,
  resolveVariantIdentity,
} from '../../src/catalog/variant-identity.js'
import { prisma } from '../../src/db/client.js'
import { AgeVerificationRequiredError, NotFoundError } from '../../src/errors/index.js'
import { checkout } from '../../src/sales/sales.service.js'
import { openShift } from '../../src/sales/shift.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  giveStock,
  makeAdmin,
  makeCannabinoid,
  makeCategory,
  makePriceGroup,
  makeStaff,
  makeStore,
  makeSupplier,
  makeTerminal,
  makeWeightProduct,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Strain identity on the VARIANT — the 2026-08-21 decision that strains are variants of
 * one flower Product rather than Products of their own.
 *
 * The shape under test is one `Regular Flower` product with two strain variants, which is
 * exactly what the real catalog holds. What must hold: each strain answers with its own
 * facts where it has them, inherits the shelf's where it does not, attributes its sales to
 * its OWN supplier, and trips the 21+ gate on its own potency links.
 */

let store: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let category: { id: string }
let priceGroup: { id: string }

beforeEach(async () => {
  await resetDatabase()
  store = await makeStore('Store A', 'store-a')
  const adminUser = await makeAdmin()
  const terminal = await makeTerminal(store.id, 'identity-test-device-token')
  admin = {
    kind: 'admin',
    userId: adminUser.id,
    role: Role.ADMIN,
    storeId: null,
    terminalId: terminal.id,
  }
  const staffUser = await makeStaff(store.id, '4321')
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: store.id,
    terminalId: terminal.id,
  }
  category = await makeCategory('Flower', 'flower')
  priceGroup = await makePriceGroup('Flower', 'flower-group', 1000)
})

/** One flower product ("the shelf") carrying its own identity, plus a bare second variant. */
async function shelfWithTwoStrains() {
  const product = await makeWeightProduct({
    name: 'Regular Flower',
    categoryId: category.id,
    priceGroupId: priceGroup.id,
  })
  const inheriting = product.variants[0]!
  await prisma.productVariant.update({
    where: { id: inheriting.id },
    data: { label: 'Blue Dream' },
  })
  await prisma.product.update({
    where: { id: product.id },
    data: {
      strainType: 'HYBRID',
      terpeneProfile: 'shelf terpenes',
      nose: 'shelf nose',
      coaUrl: 'https://example.test/shelf-coa.pdf',
      description: 'The flower shelf.',
    },
  })
  const owning = await createVariant(admin, product.id, {
    sku: 'PURPLE-HAZE',
    trackingMode: TrackingMode.WEIGHT,
    label: 'Purple Haze',
    priceGroupId: priceGroup.id,
    strainType: 'SATIVA',
    nose: 'grape, pine',
    coaUrl: 'https://example.test/ph-coa.pdf',
  })
  return { product, inheriting, owning }
}

describe('the resolver', () => {
  it('falls back field by field, not all at once', () => {
    const resolved = resolveVariantIdentity(
      { strainType: 'SATIVA', nose: 'grape', terpeneProfile: null, coaUrl: null, description: null },
      {
        strainType: 'HYBRID',
        nose: 'shelf nose',
        terpeneProfile: 'shelf terps',
        coaUrl: 'https://shelf.test/coa',
        description: 'shelf blurb',
      },
    )

    expect(resolved.strainType).toBe('SATIVA')
    expect(resolved.nose).toBe('grape')
    // The two it does NOT set still come from the shelf — this is the whole point.
    expect(resolved.terpeneProfile).toBe('shelf terps')
    expect(resolved.description).toBe('shelf blurb')
    expect(resolved.sources).toEqual({
      strainType: 'variant',
      nose: 'variant',
      terpeneProfile: 'product',
      coaUrl: 'product',
      description: 'product',
    })
  })

  it('treats an empty string as unset, so a blank box never blanks an inherited value', () => {
    const resolved = resolveVariantIdentity(
      { coaUrl: '', nose: '', strainType: null, terpeneProfile: null, description: null },
      { coaUrl: 'https://shelf.test/coa', nose: 'shelf nose' },
    )
    expect(resolved.coaUrl).toBe('https://shelf.test/coa')
    expect(resolved.nose).toBe('shelf nose')
    expect(resolved.sources.coaUrl).toBe('product')
  })

  it('handles a product with nothing recorded without inventing values', () => {
    const resolved = resolveVariantIdentity({}, {})
    expect(resolved.strainType).toBeNull()
    expect(resolved.coaUrl).toBeNull()
    expect(resolved.sources.strainType).toBe('product')
  })

  it('swaps the cannabinoid list ALL or NOTHING, never merging the two', () => {
    const shelf = [
      { mgPerUnit: null, percentBps: 2400, cannabinoid: { id: 'a', name: 'THCa', slug: 'thca' } },
      { mgPerUnit: null, percentBps: 100, cannabinoid: { id: 'b', name: 'CBD', slug: 'cbd' } },
    ]
    const own = [
      { mgPerUnit: null, percentBps: 1900, cannabinoid: { id: 'a', name: 'THCa', slug: 'thca' } },
    ]

    // One link on the variant owns the whole answer — the shelf's CBD does NOT survive.
    const owned = resolveVariantCannabinoids(own, shelf)
    expect(owned.source).toBe('variant')
    expect(owned.links).toHaveLength(1)
    expect(owned.links[0]!.percentBps).toBe(1900)

    const inherited = resolveVariantCannabinoids([], shelf)
    expect(inherited.source).toBe('product')
    expect(inherited.links).toHaveLength(2)
  })

  it('prefers the variant supplier and falls back to the product', () => {
    expect(resolveSupplierId('sup-variant', 'sup-product')).toBe('sup-variant')
    expect(resolveSupplierId(null, 'sup-product')).toBe('sup-product')
    expect(resolveSupplierId(null, null)).toBeNull()
  })

  it('counts a cannabinoid link at EITHER level as age-restricted', () => {
    expect(bearsCannabinoids(0, 0)).toBe(false)
    expect(bearsCannabinoids(1, 0)).toBe(true) // the case the old product-only check missed
    expect(bearsCannabinoids(0, 1)).toBe(true)
  })
})

describe('product detail', () => {
  it('ships each variant its resolved identity, per field', async () => {
    const { product, inheriting, owning } = await shelfWithTwoStrains()

    const detail = await getProduct(admin, product.id)
    const blueDream = detail.variants.find((v) => v.id === inheriting.id)!
    const purpleHaze = detail.variants.find((v) => v.id === owning.id)!

    // Inherits everything — it recorded nothing of its own.
    expect(blueDream.identity).toMatchObject({
      strainType: 'HYBRID',
      nose: 'shelf nose',
      coaUrl: 'https://example.test/shelf-coa.pdf',
    })
    expect(blueDream.identity!.sources.strainType).toBe('product')

    // Owns three, inherits the rest.
    expect(purpleHaze.identity).toMatchObject({
      strainType: 'SATIVA',
      nose: 'grape, pine',
      coaUrl: 'https://example.test/ph-coa.pdf',
      terpeneProfile: 'shelf terpenes',
    })
    expect(purpleHaze.identity!.sources).toMatchObject({
      strainType: 'variant',
      nose: 'variant',
      coaUrl: 'variant',
      terpeneProfile: 'product',
    })
  })

  it('never exposes the un-inherited raw columns alongside the resolved answer', async () => {
    const { product, inheriting } = await shelfWithTwoStrains()
    const detail = await getProduct(admin, product.id)
    const blueDream = detail.variants.find((v) => v.id === inheriting.id)!

    // A caller reaching for variant.strainType would get null and render "no strain type"
    // for a variant that plainly has one. The key must not be there to reach for.
    expect(blueDream).not.toHaveProperty('strainType')
    expect(blueDream).not.toHaveProperty('coaUrl')
    expect(blueDream).not.toHaveProperty('cannabinoids')
  })

  it('resolves potency all-or-nothing through the real payload', async () => {
    const { product, inheriting, owning } = await shelfWithTwoStrains()
    const thca = await makeCannabinoid('THCa', 'thca')
    const cbd = await makeCannabinoid('CBD', 'cbd')

    await setProductCannabinoids(admin, product.id, [
      { cannabinoidId: thca.id, mgPerUnit: null, percentBps: 2400 },
      { cannabinoidId: cbd.id, mgPerUnit: null, percentBps: 100 },
    ])
    await setVariantCannabinoids(admin, owning.id, [
      { cannabinoidId: thca.id, mgPerUnit: null, percentBps: 1900 },
    ])

    const detail = await getProduct(admin, product.id)
    const blueDream = detail.variants.find((v) => v.id === inheriting.id)!
    const purpleHaze = detail.variants.find((v) => v.id === owning.id)!

    expect(blueDream.identity!.cannabinoidSource).toBe('product')
    expect(blueDream.identity!.cannabinoids).toHaveLength(2)

    expect(purpleHaze.identity!.cannabinoidSource).toBe('variant')
    expect(purpleHaze.identity!.cannabinoids).toHaveLength(1)
    expect(purpleHaze.identity!.cannabinoids[0]!.percentBps).toBe(1900)
  })

  it('reports the variant supplier when set and the shelf\'s otherwise', async () => {
    const { product, inheriting, owning } = await shelfWithTwoStrains()
    const shelfSupplier = await makeSupplier('Shelf Distribution')
    const strainSupplier = await makeSupplier('Strain Farms', { slug: 'strain-farms' })

    await prisma.product.update({
      where: { id: product.id },
      data: { primarySupplierId: shelfSupplier.id },
    })
    await updateVariant(admin, owning.id, { supplierId: strainSupplier.id })

    const detail = await getProduct(admin, product.id)
    const blueDream = detail.variants.find((v) => v.id === inheriting.id)!
    const purpleHaze = detail.variants.find((v) => v.id === owning.id)!

    expect(blueDream.identity!.supplier).toMatchObject({ name: 'Shelf Distribution' })
    expect(blueDream.identity!.supplierSource).toBe('product')
    expect(purpleHaze.identity!.supplier).toMatchObject({ name: 'Strain Farms' })
    expect(purpleHaze.identity!.supplierSource).toBe('variant')
  })

  it('still strips cost from a staff detail payload, in both directions', async () => {
    const { product, owning } = await shelfWithTwoStrains()
    await giveStock(store.id, owning.id, 14_000, 60_00)

    const staffDetail = await getProduct(staff, product.id)
    expect(findCostKeys(staffDetail)).toEqual([])

    // Not vacuous: the same read as admin DOES carry cost.
    const adminDetail = await getProduct(admin, product.id)
    expect(findCostKeys(adminDetail).length).toBeGreaterThan(0)
  })
})

describe('sale attribution', () => {
  beforeEach(async () => {
    await openShift(staff, store.id, { openingCashCents: 100_00 })
  })

  it('snapshots each strain to ITS OWN supplier on one sale', async () => {
    const { product, inheriting, owning } = await shelfWithTwoStrains()
    const shelfSupplier = await makeSupplier('Shelf Distribution')
    const strainSupplier = await makeSupplier('Strain Farms', { slug: 'strain-farms' })

    await prisma.product.update({
      where: { id: product.id },
      data: { primarySupplierId: shelfSupplier.id },
    })
    await updateVariant(admin, owning.id, { supplierId: strainSupplier.id })
    await giveStock(store.id, inheriting.id, 28_000, 100_00)
    await giveStock(store.id, owning.id, 28_000, 120_00)

    const receipt = await checkout(admin, {
      lines: [
        { variantId: inheriting.id, quantityBase: 3_500 },
        { variantId: owning.id, quantityBase: 3_500 },
      ],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 200_00 }],
    })

    const lines = await prisma.saleLine.findMany({
      where: { saleId: receipt.id },
      select: { variantId: true, supplierId: true },
    })
    const byVariant = new Map(lines.map((l) => [l.variantId, l.supplierId]))

    // The whole point of the variant-level column: two strains, two suppliers, one shelf.
    expect(byVariant.get(inheriting.id)).toBe(shelfSupplier.id)
    expect(byVariant.get(owning.id)).toBe(strainSupplier.id)
  })
})

describe('age verification', () => {
  beforeEach(async () => {
    await openShift(staff, store.id, { openingCashCents: 100_00 })
  })

  it('trips on a VARIANT-level cannabinoid link when the product carries none', async () => {
    const { owning } = await shelfWithTwoStrains()
    const thca = await makeCannabinoid('THCa', 'thca')
    await setVariantCannabinoids(admin, owning.id, [
      { cannabinoidId: thca.id, mgPerUnit: null, percentBps: 2400 },
    ])
    await giveStock(store.id, owning.id, 28_000, 100_00)

    // Before variant links existed this checked the PRODUCT only, so this sale would have
    // completed with no 21+ record at all. That is a compliance record, not a prompt.
    await expect(
      checkout(admin, {
        lines: [{ variantId: owning.id, quantityBase: 3_500 }],
        ageVerified: false,
        tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
      }),
    ).rejects.toThrow(AgeVerificationRequiredError)

    const ok = await checkout(admin, {
      lines: [{ variantId: owning.id, quantityBase: 3_500 }],
      ageVerified: true,
      tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
    })
    expect(ok.ageVerified).toBe(true)
  })
})

describe('variant identity writes', () => {
  it('refuses a supplier that does not exist, ahead of the foreign key', async () => {
    const { owning } = await shelfWithTwoStrains()
    await expect(
      updateVariant(admin, owning.id, { supplierId: 'cmsu3a2fk001ctdr8p8isddzj' }),
    ).rejects.toThrow(NotFoundError)
  })

  it('hands a strain back to the shelf when its links are cleared', async () => {
    const { product, owning } = await shelfWithTwoStrains()
    const thca = await makeCannabinoid('THCa', 'thca')
    await setProductCannabinoids(admin, product.id, [
      { cannabinoidId: thca.id, mgPerUnit: null, percentBps: 2400 },
    ])
    await setVariantCannabinoids(admin, owning.id, [
      { cannabinoidId: thca.id, mgPerUnit: null, percentBps: 1900 },
    ])

    await setVariantCannabinoids(admin, owning.id, [])

    const detail = await getProduct(admin, product.id)
    const purpleHaze = detail.variants.find((v) => v.id === owning.id)!
    // An empty array means "inherit", NOT "contains nothing" — documented, and the only
    // way a strain can be handed back to the shelf's potency.
    expect(purpleHaze.identity!.cannabinoidSource).toBe('product')
    expect(purpleHaze.identity!.cannabinoids[0]!.percentBps).toBe(2400)
  })

  it('records only the changed keys on the audit row', async () => {
    const { owning } = await shelfWithTwoStrains()
    await updateVariant(admin, owning.id, { nose: 'citrus' })

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: owning.id, action: 'catalog.variant.update' },
      orderBy: { createdAt: 'desc' },
    })
    expect(Object.keys(entry!.after as object)).toEqual(['nose'])
    expect((entry!.before as { nose: string }).nose).toBe('grape, pine')
  })
})
