/**
 * Zod primitives.
 *
 * These are the building blocks endpoint schemas compose from. There are deliberately NO
 * request/response schemas here yet — those are speculative until the endpoints they
 * describe exist, and arrive with their phase.
 *
 * Kept behind the `@huta/shared/schemas` subpath so the root entry stays dependency-free
 * and Zod never lands in the register bundle by accident.
 */

import { z } from 'zod'

import { type BaseQuantity, type Bps, type Cents, unsafe } from '../brand.js'
import { parseDollarsToCents } from '../money.js'
import { parseGramsToBase } from '../quantity.js'

/**
 * Note the input/output asymmetry these create: `z.infer<typeof zGramsInput>` is
 * `BaseQuantity` (the output) while the wire shape is `string`. When building client-side
 * request types later, reach for `z.input<>`, not `z.infer<>`.
 */

export const zCents = z.int().transform((n): Cents => unsafe.cents(n))
export const zNonNegativeCents = z
  .int()
  .nonnegative()
  .transform((n): Cents => unsafe.cents(n))

export const zBaseQuantity = z.int().transform((n): BaseQuantity => unsafe.baseQuantity(n))
export const zPositiveBaseQuantity = z
  .int()
  .positive()
  .transform((n): BaseQuantity => unsafe.baseQuantity(n))

export const zBps = z
  .int()
  .min(0)
  .max(10_000)
  .transform((n): Bps => unsafe.bps(n))

export const zPin = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits.')

/**
 * cuid v1 — `schema.prisma` uses `@default(cuid())`, which is v1 (25 chars, leading `c`).
 * `z.cuid2()` is a different format and would reject every ID in the database.
 */
export const zCuid = z.cuid()

/** Accepts the register's typed grams and emits base milligrams. */
export const zGramsInput = z.string().transform((value, ctx) => {
  const result = parseGramsToBase(value)
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.message })
    return z.NEVER
  }
  return result.value
})

/** Accepts a typed dollar amount and emits cents. */
export const zDollarsInput = z.string().transform((value, ctx) => {
  const result = parseDollarsToCents(value)
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.message })
    return z.NEVER
  }
  return result.value
})
