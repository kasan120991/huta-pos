import {
  type Cents,
  DiscountType,
  PromotionScope,
  TrackingMode,
  applyBps,
  clampToZero,
  subCents,
  unsafe,
} from '@huta/shared'
import type {
  AppliedPromotion,
  PromotionStrategy,
  RejectedPromotion,
} from '@huta/shared/schemas'

/**
 * Which promotions apply to a line, and what they take off.
 *
 * Separated from `pricing.service.ts` because this is the part with a policy in it, and a
 * policy deserves its own tests. The service decides the BASE amount; this decides what
 * comes off it.
 *
 * Two steps, in this order, because they are not interchangeable:
 *
 *   1. `selectOverride` — an OVERRIDE_PRICE_PER_GRAM replaces the RATE, so the service has
 *      to recompute the line's gross before anything is subtracted from it.
 *   2. `resolveDiscounts` — percent and amount promotions, against that recomputed gross.
 *
 * Running them the other way round would apply a percentage to the pre-override price and
 * then throw that number away.
 */

export interface PromotionCandidate {
  readonly id: string
  readonly name: string
  readonly scopeType: PromotionScope
  readonly discountType: DiscountType
  readonly value: number
  readonly stackable: boolean
}

/**
 * Narrower scope wins. A promotion on one variant beats one on its product, which beats
 * one on its category, which beats one on its price group.
 */
const SCOPE_RANK: Record<PromotionScope, number> = {
  [PromotionScope.VARIANT]: 4,
  [PromotionScope.PRODUCT]: 3,
  [PromotionScope.CATEGORY]: 2,
  [PromotionScope.PRICE_GROUP]: 1,
}

/**
 * Order promotions for sequential application: narrowest scope first, then larger value,
 * then id.
 *
 * Deterministic ordering matters beyond tidiness — with percentages applied to a running
 * total, a different order is a different total, and a cart that re-prices to a different
 * number on refresh is a bug a customer will find.
 */
function inApplicationOrder(promotions: readonly PromotionCandidate[]): PromotionCandidate[] {
  return [...promotions].sort(
    (a, b) =>
      SCOPE_RANK[b.scopeType] - SCOPE_RANK[a.scopeType] ||
      b.value - a.value ||
      a.id.localeCompare(b.id),
  )
}

// --- step 1: the rate override ---------------------------------------------------------

export interface OverrideSelection {
  readonly override: PromotionCandidate | null
  readonly rejected: readonly RejectedPromotion[]
  /** The candidates left for step 2. */
  readonly remaining: readonly PromotionCandidate[]
}

export function selectOverride(
  candidates: readonly PromotionCandidate[],
  trackingMode: TrackingMode,
): OverrideSelection {
  const rejected: RejectedPromotion[] = []
  const overrides: PromotionCandidate[] = []
  const remaining: PromotionCandidate[] = []

  for (const candidate of candidates) {
    if (candidate.discountType !== DiscountType.OVERRIDE_PRICE_PER_GRAM) {
      remaining.push(candidate)
      continue
    }
    // A rate replacement is meaningless on a discrete item. Reported rather than silently
    // ignored — an admin who set one up needs to know it did nothing.
    if (trackingMode !== TrackingMode.WEIGHT) {
      rejected.push({
        promotionId: candidate.id,
        name: candidate.name,
        reason: 'not-applicable-to-tracking-mode',
      })
      continue
    }
    overrides.push(candidate)
  }

  // Two rate replacements have no meaningful combination, stackable or not: the narrowest
  // simply wins and the rest are reported.
  const ordered = inApplicationOrder(overrides)
  for (const loser of ordered.slice(1)) {
    rejected.push({ promotionId: loser.id, name: loser.name, reason: 'lost-to-better-outcome' })
  }

  return { override: ordered[0] ?? null, rejected, remaining }
}

// --- step 2: percent and amount discounts ----------------------------------------------

export interface DiscountOutcome {
  readonly applied: readonly AppliedPromotion[]
  readonly rejected: readonly RejectedPromotion[]
  readonly strategy: PromotionStrategy
  readonly discountCents: Cents
}

/** What one promotion takes off a running amount. Never drives the amount below zero. */
function discountFor(promotion: PromotionCandidate, running: Cents): Cents {
  switch (promotion.discountType) {
    case DiscountType.PERCENT_OFF:
      return applyBps(running, unsafe.bps(promotion.value))
    case DiscountType.AMOUNT_OFF:
      // Capped at what is left, so two $20 promotions on a $30 line take $30, not $40.
      return promotion.value > running ? running : unsafe.cents(promotion.value)
    case DiscountType.OVERRIDE_PRICE_PER_GRAM:
      return unsafe.cents(0)
  }
}

function runSequentially(
  promotions: readonly PromotionCandidate[],
  base: Cents,
): { applied: AppliedPromotion[]; total: Cents } {
  const applied: AppliedPromotion[] = []
  let running = base

  for (const promotion of promotions) {
    const discount = discountFor(promotion, running)
    if (discount <= 0) continue
    running = clampToZero(subCents(running, discount))
    applied.push({
      promotionId: promotion.id,
      name: promotion.name,
      scopeType: promotion.scopeType,
      discountType: promotion.discountType,
      value: promotion.value,
      discountCents: discount,
    })
  }

  return { applied, total: running }
}

/**
 * Pick the outcome that costs the customer least.
 *
 * The house rules says only stackable promotions combine and otherwise the single best-scoped
 * one applies — which leaves open what happens when both kinds match. Kasan chose: compute
 * the best non-stackable ALONE and all stackables COMBINED, then charge the lower. The
 * losing candidate is reported rather than dropped, because a real promotion that quietly
 * did not apply is a question staff will be asked at the counter.
 */
export function resolveDiscounts(
  candidates: readonly PromotionCandidate[],
  base: Cents,
): DiscountOutcome {
  const rejected: RejectedPromotion[] = []

  const nonStackables = inApplicationOrder(candidates.filter((p) => !p.stackable))
  const stackables = inApplicationOrder(candidates.filter((p) => p.stackable))

  // Only the narrowest non-stackable is ever in contention; the rest lost on scope.
  for (const loser of nonStackables.slice(1)) {
    rejected.push({ promotionId: loser.id, name: loser.name, reason: 'lost-to-better-outcome' })
  }

  const best = nonStackables[0]
  const singleRun = best ? runSequentially([best], base) : null
  const stackedRun = stackables.length > 0 ? runSequentially(stackables, base) : null

  if (singleRun && stackedRun) {
    // The comparison itself. Ties go to the single promotion: fewer moving parts on the
    // receipt for the same money.
    if (singleRun.total <= stackedRun.total) {
      for (const loser of stackables) {
        rejected.push({ promotionId: loser.id, name: loser.name, reason: 'lost-to-better-outcome' })
      }
      return finish('single-non-stackable', singleRun, base, rejected)
    }
    rejected.push({ promotionId: best!.id, name: best!.name, reason: 'lost-to-better-outcome' })
    return finish('stacked', stackedRun, base, rejected)
  }

  if (singleRun) return finish('single-non-stackable', singleRun, base, rejected)
  if (stackedRun) return finish('stacked', stackedRun, base, rejected)

  return { applied: [], rejected, strategy: 'none', discountCents: unsafe.cents(0) }
}

function finish(
  strategy: PromotionStrategy,
  run: { applied: AppliedPromotion[]; total: Cents },
  base: Cents,
  rejected: RejectedPromotion[],
): DiscountOutcome {
  return {
    applied: run.applied,
    rejected,
    strategy: run.applied.length === 0 ? 'none' : strategy,
    discountCents: clampToZero(subCents(base, run.total)),
  }
}
