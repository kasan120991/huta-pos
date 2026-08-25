import type {
  SaleHistoryRow,
  SalesDayTotals,
  SalesHistoryQuery,
  SalesPage,
  SalesTotals,
} from '@huta/shared/schemas'

import { assertCan } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { resolveMoneyStores } from '../auth/store-scope.js'
import { prisma } from '../db/client.js'
import { dayKey, dayRange, hourKey, scopeTimezone } from '../lib/business-day.js'
import { NotFoundError } from '../errors/index.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * Transaction history — the browsable read over past sales.
 *
 * Deliberately NOT part of refund.service.ts, which owns refund mechanics and whose
 * `resolveStoreId` demands an attached terminal. That requirement is correct THERE — money
 * goes back out of a drawer — and putting a desk-reachable list beside it would invite
 * someone to relax it. `listRecentSales` also stays: it answers a narrower question for the
 * register (latest 50 at this terminal's store) and its payload has no store column because
 * it cannot span stores.
 *
 * Nothing here selects cost. The list has no reason to carry it, so there is no per-field
 * stripping to get subtly wrong — `getSale` remains the one place `unitCostCents` is
 * decided, at its Prisma select.
 */

/**
 * Store scoping moved to `auth/store-scope.ts` on 2026-08-22, when the drawer list needed
 * the identical rule. Two independently derived money-scope resolvers drift, and the one
 * that drifts open is a money one. This alias keeps the call sites below reading naturally.
 */
const resolveHistoryStores = (principal: Principal, storeId: string | undefined) =>
  resolveMoneyStores(principal, storeId, 'sale.ring')

/**
 * The Sale predicate, built ONCE and reused by the list, the counts and the day buckets.
 *
 * `omitCashier` exists for the filter-options query: computing the cashier dropdown over a
 * set that already has the cashier filter applied collapses it to the one cashier picked,
 * with no way back to the others.
 */
function saleWhere(
  storeIds: readonly string[],
  filter: SalesHistoryQuery,
  timeZone: string,
  opts: { omitCashier?: boolean, omitDate?: boolean } = {},
): Prisma.SaleWhereInput {
  const range = opts.omitDate === true ? undefined : dayRange(filter.from, filter.to, timeZone)
  return {
    storeId: { in: [...storeIds] },
    ...(filter.number !== undefined ? { number: filter.number } : {}),
    ...(filter.cashierId !== undefined && opts.omitCashier !== true
      ? { cashierId: filter.cashierId }
      : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    // One drawer's sales. `omitDate` does not apply — a shift is already a bounded span,
    // and the drawer list passes no range alongside it.
    ...(filter.shiftId !== undefined ? { shiftId: filter.shiftId } : {}),
    // "Was this paid by card" is a fact about SUCCEEDED payments — a failed card attempt
    // must not make a sale match the Card filter.
    ...(filter.method !== undefined
      ? { payments: { some: { method: filter.method, status: 'SUCCEEDED' } } }
      : {}),
    ...(range ? { createdAt: range } : {}),
  }
}

/* ————— the list ————— */

export async function listSales(
  principal: Principal,
  filter: SalesHistoryQuery,
  paging: { page: number, pageSize: number },
): Promise<SalesPage> {
  const stores = await resolveHistoryStores(principal, filter.storeId)
  const timeZone = scopeTimezone(stores)
  const storeById = new Map(stores.map((s) => [s.id, s.name]))
  const where = saleWhere(stores.map((s) => s.id), filter, timeZone)

  const [total, sales] = await Promise.all([
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      // The `id` tiebreak is load-bearing, not decoration: sales committed in the same
      // transaction share a createdAt, and an unstable sort under OFFSET paging shows a row
      // twice on one page and never on the next.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (paging.page - 1) * paging.pageSize,
      take: paging.pageSize,
      select: {
        id: true,
        number: true,
        storeId: true,
        cashierId: true,
        createdAt: true,
        totalCents: true,
        status: true,
        cashier: { select: { firstName: true, lastName: true } },
        payments: { where: { status: 'SUCCEEDED' }, select: { method: true } },
        _count: { select: { lines: true } },
        // SUCCEEDED only: a FAILED card refund leaves the record and the restock standing,
        // but no money moved, so it must not read as refunded here.
        refunds: { where: { status: 'SUCCEEDED' }, select: { amountCents: true } },
      },
    }),
  ])

  const rows: SaleHistoryRow[] = sales.map((sale) => ({
    id: sale.id,
    number: sale.number,
    storeId: sale.storeId,
    storeName: storeById.get(sale.storeId) ?? '',
    cashierId: sale.cashierId,
    createdAt: sale.createdAt.toISOString(),
    totalCents: sale.totalCents,
    status: sale.status,
    cashierName: `${sale.cashier.firstName} ${sale.cashier.lastName}`.trim(),
    paymentMethods: [...new Set(sale.payments.map((p) => p.method))],
    lineCount: sale._count.lines,
    refundedCents: sale.refunds.reduce((sum, r) => sum + r.amountCents, 0),
  }))

  return {
    sales: rows,
    stores: stores.map((s) => ({ id: s.id, name: s.name })),
    total,
    page: paging.page,
    pageSize: paging.pageSize,
    pageCount: Math.max(1, Math.ceil(total / paging.pageSize)),
  }
}

/* ————— the totals ————— */

/**
 * Period totals, over the SAME filters as the list.
 *
 * The arithmetic is `closeShift`'s, generalised from one drawer to a date range:
 * money in is SUCCEEDED payments, money out is SUCCEEDED refunds, net is the difference.
 *
 * A **voided sale nets to zero on its own**, because the void wrote reversing Refund rows —
 * the payment counts, the refund subtracts, exactly as the drawer reckons it. `voidedCount`
 * is reported separately rather than deducted: a void is a fact, not an absence.
 *
 * ⚠️ **Refunds are dated by the REFUND, not by the sale it reverses** — the same rule
 * `Refund.shiftId` follows, so these figures reconcile against the shift close. The cost is
 * that a refund of an older sale appears in a day whose sale rows do not contain it; the
 * screen must therefore label the figure "refunds paid out", not "refunds on these sales".
 *
 * Summing `Refund.amountCents` also sidesteps the trap that a void writes TWO refund rows
 * for a split sale with lines on the FIRST only: every row carries money, lines do not. And
 * never expose a refund COUNT — a split void is two rows and "2 refunds" misdescribes one
 * event.
 */
export async function salesTotals(
  principal: Principal,
  filter: SalesHistoryQuery,
): Promise<SalesTotals> {
  const stores = await resolveHistoryStores(principal, filter.storeId)
  const timeZone = scopeTimezone(stores)
  const storeIds = stores.map((s) => s.id)
  const where = saleWhere(storeIds, filter, timeZone)
  const range = dayRange(filter.from, filter.to, timeZone)

  /**
   * Refunds split their two questions deliberately:
   *
   *   * WHICH refunds — every sale-level filter (store, cashier, method, status) applies, so
   *     filtering the table to Card does not leave a refunds figure that includes money
   *     given back on cash sales. Net would otherwise subtract one population from another.
   *   * WHEN — the REFUND's own date, never the sale's. That is what keeps a refund issued
   *     today against last week's sale counted today, the same rule `Refund.shiftId`
   *     follows, so these figures still reconcile against a shift close.
   *
   * Hence `omitDate` on the sale predicate: the range belongs on the refund.
   */
  const refundWhere: Prisma.RefundWhereInput = {
    status: 'SUCCEEDED',
    sale: saleWhere(storeIds, filter, timeZone, { omitDate: true }),
    ...(range ? { createdAt: range } : {}),
  }

  // SEQUENTIAL, not Promise.all — `cashFigures` in shift.service.ts explains why: the client
  // may be a transaction holding a single connection, and pg does not multiplex it.
  const saleCount = await prisma.sale.count({ where })
  const voidedCount = await prisma.sale.count({ where: { ...where, status: 'VOIDED' } })

  const byMethod = await prisma.payment.groupBy({
    by: ['method'],
    where: { status: 'SUCCEEDED', sale: where },
    _sum: { amountCents: true },
  })
  const cashCents = byMethod.find((r) => r.method === 'CASH')?._sum.amountCents ?? 0
  const cardCents = byMethod.find((r) => r.method === 'CARD')?._sum.amountCents ?? 0
  const grossCents = cashCents + cardCents

  const refundAgg = await prisma.refund.aggregate({
    where: refundWhere,
    _sum: { amountCents: true },
  })
  const refundsCents = refundAgg._sum.amountCents ?? 0

  const days = await dayTotals(where, refundWhere, timeZone)
  const cashiers = await cashierOptions(storeIds, filter, timeZone)

  return {
    timezone: timeZone,
    cashiers,
    saleCount,
    voidedCount,
    grossCents,
    cashCents,
    cardCents,
    refundsCents,
    netCents: grossCents - refundsCents,
    days,
  }
}

/**
 * The per-day breakdown, folded in TypeScript from two flat reads.
 *
 * Not SQL: a `date_trunc` group-by has to name a timezone inside the query, and Postgres
 * returns `bigint` for `SUM`/`COUNT`, which the pg adapter hands back as a BigInt that
 * `JSON.stringify` throws on. Folding here keeps the timezone decision visible and the
 * numbers plain — the same choice `insights.service.ts` makes for the same kind of reason.
 */
async function dayTotals(
  where: Prisma.SaleWhereInput,
  refundWhere: Prisma.RefundWhereInput,
  timeZone: string,
): Promise<SalesDayTotals[]> {
  const sales = await prisma.sale.findMany({
    where,
    select: {
      createdAt: true,
      payments: { where: { status: 'SUCCEEDED' }, select: { amountCents: true } },
    },
  })
  const refunds = await prisma.refund.findMany({
    where: refundWhere,
    select: { createdAt: true, amountCents: true },
  })

  const byDay = new Map<
    string,
    { saleCount: number, grossCents: number, refundsCents: number, hours: number[] }
  >()
  const bucket = (at: Date) => {
    const key = dayKey(at, timeZone)
    let row = byDay.get(key)
    if (!row) {
      row = { saleCount: 0, grossCents: 0, refundsCents: 0, hours: Array<number>(24).fill(0) }
      byDay.set(key, row)
    }
    return row
  }

  for (const sale of sales) {
    const row = bucket(sale.createdAt)
    row.saleCount += 1
    const taken = sale.payments.reduce((sum, p) => sum + p.amountCents, 0)
    row.grossCents += taken
    // Free: the same rows are already in hand for the day figure, so the shape costs no
    // extra query — only one more key.
    const hour = hourKey(sale.createdAt, timeZone)
    row.hours[hour] = (row.hours[hour] ?? 0) + taken
  }
  // Refunds bucket by their OWN date, so a day can legitimately show money out against no
  // sale of its own — see the warning on salesTotals.
  for (const refund of refunds) bucket(refund.createdAt).refundsCents += refund.amountCents

  return [...byDay.entries()]
    .map(([day, row]) => ({
      day,
      saleCount: row.saleCount,
      grossCents: row.grossCents,
      refundsCents: row.refundsCents,
      netCents: row.grossCents - row.refundsCents,
      hours: row.hours,
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1))
}

/** Who rang a sale in this scope — the filter's own options, minus the cashier filter. */
async function cashierOptions(
  storeIds: readonly string[],
  filter: SalesHistoryQuery,
  timeZone: string,
): Promise<Array<{ id: string, name: string }>> {
  const rows = await prisma.sale.findMany({
    where: saleWhere(storeIds, filter, timeZone, { omitCashier: true }),
    distinct: ['cashierId'],
    select: { cashierId: true, cashier: { select: { firstName: true, lastName: true } } },
  })
  return rows
    .map((r) => ({
      id: r.cashierId,
      name: `${r.cashier.firstName} ${r.cashier.lastName}`.trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
