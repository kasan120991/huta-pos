import { describe, expect, it } from 'vitest'

import {
  CANNABINOID_SEED,
  CANNABINOID_SLUGS,
  CATEGORY_LEAF_SLUGS,
  CATEGORY_SEED,
} from '../src/reference.js'
import {
  zBaseQuantity,
  zBps,
  zCents,
  zCuid,
  zDollarsInput,
  zGramsInput,
  zNonNegativeCents,
  zPin,
  zPositiveBaseQuantity,
} from '../src/schemas/primitives.js'

describe('numeric primitives', () => {
  it('zCents accepts integers and rejects everything else', () => {
    expect(zCents.parse(0)).toBe(0)
    expect(zCents.parse(-1)).toBe(-1)
    expect(zCents.safeParse(1.5).success).toBe(false)
    expect(zCents.safeParse('100').success).toBe(false)
    expect(zCents.safeParse(Number.NaN).success).toBe(false)
    expect(zCents.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
  })

  it('zNonNegativeCents rejects negatives', () => {
    expect(zNonNegativeCents.safeParse(-1).success).toBe(false)
    expect(zNonNegativeCents.parse(0)).toBe(0)
  })

  it('zBaseQuantity and zPositiveBaseQuantity', () => {
    expect(zBaseQuantity.parse(-500)).toBe(-500)
    expect(zPositiveBaseQuantity.safeParse(0).success).toBe(false)
    expect(zPositiveBaseQuantity.parse(3500)).toBe(3500)
  })

  it('zBps is bounded to [0, 10000]', () => {
    expect(zBps.parse(0)).toBe(0)
    expect(zBps.parse(10_000)).toBe(10_000)
    expect(zBps.safeParse(-1).success).toBe(false)
    expect(zBps.safeParse(10_001).success).toBe(false)
  })
})

describe('zPin', () => {
  it.each(['1234', '12345', '123456'])('accepts %s', (pin) => {
    expect(zPin.parse(pin)).toBe(pin)
  })

  it.each(['123', '1234567', '12a4', '', '１２３４'])('rejects %s', (pin) => {
    expect(zPin.safeParse(pin).success).toBe(false)
  })
})

describe('zCuid', () => {
  // schema.prisma uses @default(cuid()), which is cuid v1: 'c' + 24 chars.
  it('accepts a cuid v1', () => {
    expect(zCuid.safeParse('cjld2cyuq0000t3rmniod1foy').success).toBe(true)
  })

  it('rejects arbitrary strings', () => {
    expect(zCuid.safeParse('not-an-id').success).toBe(false)
    expect(zCuid.safeParse('').success).toBe(false)
  })
})

describe('string input transforms', () => {
  it('zGramsInput emits base milligrams', () => {
    expect(zGramsInput.parse('3.5')).toBe(3500)
    expect(zGramsInput.parse('0.01')).toBe(10)
  })

  it('surfaces the human-readable message rather than "Invalid input"', () => {
    const result = zGramsInput.safeParse('3.4567')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/two decimal places/)
    }
  })

  it('zDollarsInput emits cents', () => {
    expect(zDollarsInput.parse('19.99')).toBe(1999)
    expect(zDollarsInput.safeParse('1.005').success).toBe(false)
  })
})

describe('reference seed data', () => {
  it('has 16 category leaves matching the legacy catalog', () => {
    expect(CATEGORY_LEAF_SLUGS).toHaveLength(16)
    expect(new Set(CATEGORY_LEAF_SLUGS).size).toBe(16)
  })

  it('includes flower as a leaf', () => {
    expect(CATEGORY_LEAF_SLUGS).toContain('flower')
  })

  it('has unique slugs across parents and leaves', () => {
    const all = CATEGORY_SEED.flatMap((c) => [c.slug, ...(c.children ?? []).map((x) => x.slug)])
    expect(new Set(all).size).toBe(all.length)
  })

  it('seeds 19 cannabinoids with unique slugs and no Isolate', () => {
    expect(CANNABINOID_SEED).toHaveLength(19)
    expect(new Set(CANNABINOID_SLUGS).size).toBe(19)
    expect(CANNABINOID_SLUGS).not.toContain('isolate')
  })

  it('includes the cannabinoids that existed only in legacy product titles', () => {
    for (const slug of ['thc-a', 'thc-h', 'thc-x', 'hhc-o', 'hhc-p', 'hxy-11', 'phc', 'delta-11', 'cbc']) {
      expect(CANNABINOID_SLUGS).toContain(slug)
    }
  })
})
