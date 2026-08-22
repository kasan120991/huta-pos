import { slugify } from '@huta/shared'

import { prisma } from '../db/client.js'
import { ConflictError } from '../errors/index.js'

/**
 * `Product.slug` is unique, and two reps can deliver similarly named goods.
 *
 * `excludeProductId` makes renames idempotent: a product re-saved under its own name finds
 * its own slug and keeps it, rather than acquiring a pointless `-2` suffix.
 */
export async function uniqueProductSlug(name: string, excludeProductId?: string): Promise<string> {
  const base = slugify(name)
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`
    const taken = await prisma.product.findUnique({
      where: { slug: candidate },
      select: { id: true },
    })
    if (!taken || taken.id === excludeProductId) return candidate
  }
  throw new ConflictError('Too many products share that name — give it a more specific one.')
}
