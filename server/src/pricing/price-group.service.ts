import {
  MG_PER_GRAM,
  derivePerGramRate,
  extendPerGram,
  extendTier,
  slugify,
  unsafe,
} from '@huta/shared'
import type { PriceGroupRow, PriceLadderRow } from '@huta/shared/schemas'
import type { PriceTierLike } from '@huta/shared'

import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError } from '../errors/index.js'
import { tierFor } from './pricing.service.js'

/**
 * Price group and tier administration.
 *
 * Edits here move money on every weight-tracked variant that prices through the group,
 * which is the whole point — "one edit moves every strain" — and also why the read returns
 * `variantCount` so the blast radius is visible before anyone changes a number.
 */

const GROUP_SHAPE = {
  id: true,
  name: true,
  slug: true,
  basePricePerGramCents: true,
  active: true,
  tiers: {
    select: { id: true, minQuantityBase: true, totalPriceCents: true },
    orderBy: { minQuantityBase: 'asc' as const },
  },
  _count: { select: { variants: true } },
  variants: {
    where: { active: true },
    select: { id: true, label: true, product: { select: { name: true } } },
    orderBy: { sku: 'asc' as const },
    take: 25,
  },
} as const

type GroupRow = {
  id: string
  name: string
  slug: string
  basePricePerGramCents: number
  active: boolean
  tiers: Array<{ id: string; minQuantityBase: number; totalPriceCents: number }>
  _count: { variants: number }
  variants: Array<{ id: string; label: string | null; product: { name: string } }>
}

function toRow(group: GroupRow): PriceGroupRow {
  return {
    id: group.id,
    name: group.name,
    slug: group.slug,
    basePricePerGramCents: group.basePricePerGramCents,
    active: group.active,
    variantCount: group._count.variants,
    variants: group.variants.map((v) => ({
      id: v.id,
      productName: v.product.name,
      label: v.label,
    })),
    tiers: group.tiers.map((tier) => ({
      id: tier.id,
      minQuantityBase: tier.minQuantityBase,
      totalPriceCents: tier.totalPriceCents,
      // Derived for display so an admin can see what "$30 for an eighth" means per gram.
      // NOT what gets charged — see extendTier, which deliberately does not round-trip.
      derivedPerGramCents: derivePerGramRate(
        unsafe.cents(tier.totalPriceCents),
        unsafe.baseQuantity(tier.minQuantityBase),
      ),
    })),
  }
}

export async function listPriceGroups(): Promise<PriceGroupRow[]> {
  const groups = (await prisma.priceGroup.findMany({
    select: GROUP_SHAPE,
    orderBy: { name: 'asc' },
  })) as GroupRow[]
  return groups.map(toRow)
}

export async function createPriceGroup(input: {
  name: string
  basePricePerGramCents: number
  active?: boolean | undefined
}): Promise<PriceGroupRow> {
  const slug = slugify(input.name)
  const existing = await prisma.priceGroup.findUnique({ where: { slug }, select: { id: true } })
  if (existing) throw new ConflictError(`A price group named "${input.name}" already exists.`)

  const created = (await prisma.priceGroup.create({
    data: {
      name: input.name,
      slug,
      basePricePerGramCents: input.basePricePerGramCents,
      ...(input.active === undefined ? {} : { active: input.active }),
    },
    select: GROUP_SHAPE,
  })) as GroupRow
  return toRow(created)
}

export async function updatePriceGroup(
  id: string,
  input: {
    name?: string | undefined
    basePricePerGramCents?: number | undefined
    active?: boolean | undefined
  },
): Promise<PriceGroupRow> {
  await mustExist(id)

  // The slug is deliberately NOT regenerated on rename. It is the stable key the seed
  // script and FLOWER_PRICE_GROUP_SLUG key on, so renaming "Flower" to "House Flower"
  // must not silently detach it from the seed.
  const updated = (await prisma.priceGroup.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.basePricePerGramCents === undefined
        ? {}
        : { basePricePerGramCents: input.basePricePerGramCents }),
      ...(input.active === undefined ? {} : { active: input.active }),
    },
    select: GROUP_SHAPE,
  })) as GroupRow
  return toRow(updated)
}

async function mustExist(id: string): Promise<void> {
  const found = await prisma.priceGroup.findUnique({ where: { id }, select: { id: true } })
  if (!found) throw new NotFoundError('That price group does not exist.')
}

export async function createTier(
  priceGroupId: string,
  input: { minQuantityBase: number; totalPriceCents: number },
): Promise<PriceGroupRow> {
  await mustExist(priceGroupId)

  const clash = await prisma.priceTier.findUnique({
    where: {
      priceGroupId_minQuantityBase: {
        priceGroupId,
        minQuantityBase: input.minQuantityBase,
      },
    },
    select: { id: true },
  })
  if (clash) {
    throw new ConflictError('This group already has a tier at that weight.')
  }

  await prisma.priceTier.create({ data: { priceGroupId, ...input } })
  return reload(priceGroupId)
}

export async function upsertTier(
  priceGroupId: string,
  tierId: string,
  input: { minQuantityBase: number; totalPriceCents: number },
): Promise<PriceGroupRow> {
  const tier = await prisma.priceTier.findUnique({
    where: { id: tierId },
    select: { id: true, priceGroupId: true },
  })
  if (!tier || tier.priceGroupId !== priceGroupId) {
    throw new NotFoundError('That tier does not exist on this price group.')
  }

  const clash = await prisma.priceTier.findUnique({
    where: {
      priceGroupId_minQuantityBase: { priceGroupId, minQuantityBase: input.minQuantityBase },
    },
    select: { id: true },
  })
  if (clash && clash.id !== tierId) {
    throw new ConflictError('This group already has a tier at that weight.')
  }

  await prisma.priceTier.update({ where: { id: tierId }, data: input })
  return reload(priceGroupId)
}

export async function deleteTier(priceGroupId: string, tierId: string): Promise<void> {
  const tier = await prisma.priceTier.findUnique({
    where: { id: tierId },
    select: { id: true, priceGroupId: true, saleLines: { select: { id: true }, take: 1 } },
  })
  if (!tier || tier.priceGroupId !== priceGroupId) {
    throw new NotFoundError('That tier does not exist on this price group.')
  }
  if (tier.saleLines.length > 0) {
    // House rule: prices are snapshotted onto historical records, and a sale line points at
    // the tier that priced it. Deleting one would break the explanation of a past receipt.
    throw new ConflictError(
      'That tier has already priced a sale and cannot be deleted. Edit it instead.',
    )
  }

  await prisma.priceTier.delete({ where: { id: tierId } })
}

async function reload(id: string): Promise<PriceGroupRow> {
  const group = (await prisma.priceGroup.findUnique({
    where: { id },
    select: GROUP_SHAPE,
  })) as GroupRow | null
  if (!group) throw new NotFoundError('That price group does not exist.')
  return toRow(group)
}


/**
 * What the group's ladder charges at a set of weights — the price list the counter reads.
 *
 * Deliberately NOT the quote endpoint. Three reasons the price list must not go through it:
 * quoting needs a variant, and a group with no variants yet still has a price list; quoting
 * applies promotions, so a list built from it would show today's promo rather than the
 * shelf price; and quoting is store-scoped, so the same group would print different lists
 * at two stores. This answers the narrower question — what does the LADDER say — and it
 * still runs the same `tierFor` + `extendTier` the register runs, so the two cannot drift.
 */
export async function priceLadder(
  id: string,
  weightsBase: readonly number[],
): Promise<PriceLadderRow[]> {
  const group = await prisma.priceGroup.findUnique({
    where: { id },
    select: {
      basePricePerGramCents: true,
      tiers: {
        select: { id: true, minQuantityBase: true, totalPriceCents: true },
        orderBy: { minQuantityBase: 'asc' },
      },
    },
  })
  if (!group) throw new NotFoundError('That price group does not exist.')

  const base = group.basePricePerGramCents
  const sorted = [...new Set(weightsBase)].sort((a, b) => a - b)

  return sorted.map((quantityBase) => {
    const qty = unsafe.baseQuantity(quantityBase)
    const tier = tierFor(group.tiers, quantityBase)

    if (!tier) {
      return {
        quantityBase,
        totalCents: extendPerGram(unsafe.centsPerGram(base), qty),
        perGramCents: base,
        tierId: null,
        isTierThreshold: false,
        savingBps: 0,
      }
    }

    const tierLike: PriceTierLike = {
      minQuantityBase: unsafe.baseQuantity(tier.minQuantityBase),
      totalPriceCents: unsafe.cents(tier.totalPriceCents),
    }
    // The DESCRIPTIVE rate, the same figure the sale line snapshots. Never multiply it
    // back to get the total — extendTier does not round-trip. See shared/src/pricing.ts.
    const perGramCents = derivePerGramRate(
      unsafe.cents(tier.totalPriceCents),
      unsafe.baseQuantity(tier.minQuantityBase),
    )
    return {
      quantityBase,
      totalCents: extendTier(tierLike, qty),
      perGramCents,
      tierId: tier.id,
      isTierThreshold: quantityBase === tier.minQuantityBase,
      // How much cheaper this tier's rate is than the base rate, in basis points.
      // Computed here so the screen renders a number rather than deriving one.
      savingBps: base === 0 ? 0 : Math.round(((base - perGramCents) / base) * 10_000),
    }
  })
}

/** The weights a price list shows even when no tier sits at them. 1g, 3.5g, 7g, 14g, 28g. */
export const LADDER_DEFAULT_WEIGHTS: readonly number[] = [
  1 * MG_PER_GRAM,
  3.5 * MG_PER_GRAM,
  7 * MG_PER_GRAM,
  14 * MG_PER_GRAM,
  28 * MG_PER_GRAM,
]
