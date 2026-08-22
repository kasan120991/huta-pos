import type { Principal } from '../auth/principal.js'
import { assertCan } from '../auth/permissions.js'
import { prisma } from '../db/client.js'

/**
 * What a person has actually done — the Overview and Activity tabs on the Staff page.
 *
 * A FIXED, SMALL number of queries. Never one per row, and never called from the staff
 * INDEX: ten people times six aggregates is sixty queries for a page that shows a table.
 *
 * Honest about cost, because two of these fields are on unindexed columns and it matters
 * which ones grow:
 *
 *   CHEAP, indexed
 *     Sale.cashierId          `@@index([cashierId, createdAt])` — the headline figure
 *     AuditLog.userId         `@@index([userId, createdAt])` — already the activity feed
 *     Shift.openedById        indexed by the migration that ships with this
 *     Refund.refundedById     ditto
 *
 *   CHEAP IN PRACTICE, not by index
 *     CashMovement.userId     a few hundred rows for the life of the business; a seq scan
 *                             here is nothing and an index would be cargo cult
 *
 *   THE ONE THAT MATTERS
 *     InventoryMovement.userId  the largest table in the system — every sale line writes a
 *                             row. Indexed by the same migration; without it this would be
 *                             a full scan on a table that reaches six figures in two years.
 */
export interface ActivityRange {
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/**
 * A date filter on whatever column carries the time for that model — `createdAt` for most,
 * `openedAt` / `closedAt` for a Shift. Half-open, like everywhere else that buckets by day:
 * a `lte` against midnight drops everything after 00:00 on the end date.
 */
function rangeOn(field: string, range: ActivityRange): Record<string, unknown> {
  if (!range.from && !range.to) return {}
  return {
    [field]: {
      ...(range.from ? { gte: new Date(`${range.from}T00:00:00`) } : {}),
      ...(range.to
        ? { lt: new Date(new Date(`${range.to}T00:00:00`).getTime() + 86_400_000) }
        : {}),
    },
  }
}

export async function activityFor(principal: Principal, userId: string, range: ActivityRange) {
  assertCan(principal, 'user.manage')
  const when = rangeOn('createdAt', range)

  // Six queries, fired together. Not a transaction — nothing here writes, and a read-only
  // snapshot across counters buys nothing anyone would notice.
  const [sales, shiftsOpened, shiftsClosed, refundsIssued, refundsApproved, movements, cashMoves]
    = await Promise.all([
      prisma.sale.aggregate({
        where: { cashierId: userId, ...when },
        _count: { _all: true },
        _sum: { totalCents: true },
      }),
      // A drawer is dated by when it was OPENED and when it was CLOSED — different columns,
      // and a shift opened Monday and closed Tuesday genuinely belongs to both days.
      prisma.shift.count({ where: { openedById: userId, ...rangeOn('openedAt', range) } }),
      prisma.shift.count({ where: { closedById: userId, ...rangeOn('closedAt', range) } }),
      prisma.refund.count({ where: { refundedById: userId, ...when } }),
      prisma.refund.count({ where: { approvedById: userId, ...when } }),
      prisma.inventoryMovement.count({ where: { userId, ...when } }),
      prisma.cashMovement.count({ where: { userId, ...when } }),
    ])

  const saleCount = sales._count._all
  const grossCents = sales._sum.totalCents ?? 0

  return {
    saleCount,
    grossCents,
    /**
     * Null rather than zero when there are no sales — an average over nothing is not zero,
     * it is unanswerable. The suppliers scorecard established that a figure like this
     * travels with its sample size, because an average over two and one over two hundred
     * are different claims a bare number cannot distinguish.
     */
    averageSaleCents: saleCount > 0 ? Math.round(grossCents / saleCount) : null,
    drawersOpened: shiftsOpened,
    drawersClosed: shiftsClosed,
    refundsIssued,
    refundsApproved,
    stockMovements: movements,
    cashMovements: cashMoves,
  }
}

/**
 * The admin-write feed for one person, straight off `AuditLog @@index([userId, createdAt])`.
 *
 * This was already the per-person activity record — every catalogue, receiving, reconcile,
 * terminal and staff write lands there with action, entity and a changed-keys diff. It
 * needed a reader, not a new table.
 */
export async function activityFeed(principal: Principal, userId: string, take = 50) {
  assertCan(principal, 'user.manage')
  const rows = await prisma.auditLog.findMany({
    where: { userId },
    select: { id: true, action: true, entityType: true, entityId: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    at: r.createdAt.toISOString(),
  }))
}
