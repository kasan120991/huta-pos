import { PurchaseOrderStatus, slugify } from '@huta/shared'
import type { SupplierActivity, SupplierInput, SupplierRow } from '@huta/shared/schemas'

import { canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError } from '../errors/index.js'

/**
 * Supplier records.
 *
 * The permission matrix grants staff "view supplier records — contact info only".
 * The commercial terms — account number, payment terms, minimum order, internal notes —
 * are what we negotiated, not what a rep tells anyone who asks, and they are the fields a
 * supplier's competitor would most like to see.
 *
 * As in the catalog, that is decided by choosing the Prisma `select` rather than by
 * fetching everything and deleting keys on the way out. A delete-on-exit approach is one
 * forgotten code path away from leaking.
 */

/** Contact details every principal may see. */
const PUBLIC_SHAPE = {
  id: true,
  name: true,
  slug: true,
  contactName: true,
  phone: true,
  email: true,
  website: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  licenseNumber: true,
  active: true,
  _count: { select: { products: true } },
} as const

/** Commercial terms. Admin only. */
const TERMS_SHAPE = {
  accountNumber: true,
  paymentTerms: true,
  minimumOrderCents: true,
  notes: true,
} as const

/**
 * The ONE place supplier commercial terms are decided. Everything downstream simply never
 * receives them.
 *
 * Gated on `cost.view` rather than a bare admin check: payment terms and minimum order are
 * purchasing economics, which is the same thing `cost.view` already governs, and reusing it
 * means there is one capability to reason about rather than two that must be kept in step.
 */
function supplierSelect(principal: Principal) {
  return {
    ...PUBLIC_SHAPE,
    ...(canSeeCost(principal) ? TERMS_SHAPE : {}),
  }
}

type Row = {
  id: string
  name: string
  slug: string
  contactName: string | null
  phone: string | null
  email: string | null
  website: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  licenseNumber: string | null
  active: boolean
  _count: { products: number }
  accountNumber?: string | null
  paymentTerms?: string | null
  minimumOrderCents?: number | null
  notes?: string | null
}

function toRow(row: Row): SupplierRow {
  const { _count, ...rest } = row
  return { ...rest, productCount: _count.products }
}

export interface SupplierFilter {
  /** Inactive suppliers drop out of pickers but keep all of their history. */
  readonly includeInactive?: boolean
  readonly search?: string | undefined
}

export async function listSuppliers(
  principal: Principal,
  filter: SupplierFilter = {},
): Promise<SupplierRow[]> {
  const search = filter.search?.trim()

  const rows = await prisma.supplier.findMany({
    where: {
      ...(filter.includeInactive ? {} : { active: true }),
      ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
    },
    select: supplierSelect(principal),
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })

  return rows.map((row) => toRow(row as unknown as Row))
}

export async function getSupplier(principal: Principal, id: string): Promise<SupplierRow> {
  const row = await prisma.supplier.findUnique({
    where: { id },
    select: supplierSelect(principal),
  })
  if (!row) throw new NotFoundError('That supplier does not exist.')
  return toRow(row as unknown as Row)
}

/**
 * A distinct slug per supplier name.
 *
 * Two distributors can trade under names that slugify identically, and the column is
 * unique, so a collision must be reported rather than allowed to surface as a raw Prisma
 * error the middleware would flatten to "Something went wrong."
 */
async function assertSlugFree(slug: string, exceptId?: string): Promise<void> {
  const clash = await prisma.supplier.findUnique({ where: { slug }, select: { id: true } })
  if (clash && clash.id !== exceptId) {
    throw new ConflictError('A supplier with a very similar name already exists.')
  }
}

export async function createSupplier(
  principal: Principal,
  input: SupplierInput,
): Promise<SupplierRow> {
  const name = input.name.trim()
  if (name.length === 0) throw new ConflictError('A supplier needs a name.')

  const slug = slugify(name)
  await assertSlugFree(slug)

  const created = await prisma.supplier.create({
    data: { ...writable(input), name, slug },
    select: supplierSelect(principal),
  })
  return toRow(created as unknown as Row)
}

export async function updateSupplier(
  principal: Principal,
  id: string,
  input: Partial<SupplierInput>,
): Promise<SupplierRow> {
  const existing = await prisma.supplier.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new NotFoundError('That supplier does not exist.')

  const name = input.name?.trim()
  if (name !== undefined && name.length === 0) throw new ConflictError('A supplier needs a name.')

  // The slug follows the name so a renamed supplier's URL stays meaningful. It is not a
  // stable key — nothing references a supplier by slug — so moving it is safe.
  const slug = name === undefined ? undefined : slugify(name)
  if (slug !== undefined) await assertSlugFree(slug, id)

  const updated = await prisma.supplier.update({
    where: { id },
    data: {
      ...writable(input),
      ...(name === undefined ? {} : { name }),
      ...(slug === undefined ? {} : { slug }),
    },
    select: supplierSelect(principal),
  })
  return toRow(updated as unknown as Row)
}

/** The text columns a client may set, all normalised the same way. */
const TEXT_FIELDS = [
  'contactName',
  'phone',
  'email',
  'website',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'accountNumber',
  'paymentTerms',
  'licenseNumber',
  'notes',
] as const

interface WritableFields {
  contactName?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  accountNumber?: string | null
  paymentTerms?: string | null
  licenseNumber?: string | null
  notes?: string | null
  minimumOrderCents?: number | null
  active?: boolean
}

/**
 * Normalise the editable fields.
 *
 * Empty strings become null so a cleared input does not persist as `""`, which would sort
 * and render differently from "never filled in" while meaning the same thing. Built by
 * assignment rather than conditional spreads so that under `exactOptionalPropertyTypes` an
 * absent key stays absent instead of becoming an explicit `undefined` Prisma will reject.
 *
 * `name` and `slug` are the callers' business, which is why they are not here.
 */
function writable(input: Partial<SupplierInput>): WritableFields {
  const out: WritableFields = {}

  for (const field of TEXT_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    out[field] = value === null ? null : value.trim() || null
  }

  if (input.minimumOrderCents !== undefined) out.minimumOrderCents = input.minimumOrderCents
  if (input.active !== undefined) out.active = input.active

  return out
}

// --- activity ----------------------------------------------------------------------------

/**
 * Whole days from placing an order to a delivery landing against it, floored — the same
 * arithmetic `purchase-order.service.ts` already reports per order. Same-day is 0, not a
 * fraction; nobody buying stock cares about the hours.
 */
function wholeDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

/** Null rather than 0 for an empty sample: "no orders yet" is not "instant". */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, n) => sum + n, 0) / values.length
}

/**
 * How this supplier actually behaves — operational only, and admin-only with it.
 *
 * Phase 7b wrote `firstReceiptAt` and `fullyReceivedAt` onto every purchase order and added
 * `@@index([supplierId, orderedAt])` for exactly this query. Nothing has ever read either.
 *
 * The rule that matters, straight out of House rule: an order placed with no receipt and no
 * cancellation is **outstanding, and is counted separately rather than folded into the
 * average**. Averaging it in as though it had arrived today would make the slowest suppliers
 * — the ones still owing stock — look the fastest, which is precisely backwards.
 *
 * DRAFTs are excluded from every figure. A draft has no number and was never placed with
 * anyone; counting it as an order would credit a supplier with business they never got.
 */
export async function supplierActivity(id: string): Promise<SupplierActivity> {
  const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true } })
  if (!supplier) throw new NotFoundError('That supplier does not exist.')

  const [orders, receiptCount, lastReceipt] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { supplierId: id, status: { not: PurchaseOrderStatus.DRAFT } },
      select: {
        status: true,
        orderedAt: true,
        firstReceiptAt: true,
        fullyReceivedAt: true,
      },
    }),
    prisma.receipt.count({ where: { supplierId: id } }),
    prisma.receipt.findFirst({
      where: { supplierId: id },
      select: { receivedAt: true },
      orderBy: { receivedAt: 'desc' },
    }),
  ])

  const firstDays: number[] = []
  const fullDays: number[] = []
  let outstandingCount = 0
  let cancelledCount = 0

  for (const order of orders) {
    if (order.status === PurchaseOrderStatus.CANCELLED) {
      cancelledCount += 1
      // A cancelled order is neither outstanding nor a lead time. It may still carry a
      // firstReceiptAt if it was cancelled after a partial delivery, and that figure is
      // deliberately dropped: the order never completed, so it measures nothing.
      continue
    }
    if (order.status !== PurchaseOrderStatus.RECEIVED) outstandingCount += 1
    if (order.firstReceiptAt) firstDays.push(wholeDays(order.orderedAt, order.firstReceiptAt))
    if (order.fullyReceivedAt) fullDays.push(wholeDays(order.orderedAt, order.fullyReceivedAt))
  }

  return {
    supplierId: id,
    ordersPlaced: orders.length,
    outstandingCount,
    cancelledCount,
    receiptCount,
    lastReceivedAt: lastReceipt?.receivedAt.toISOString() ?? null,
    avgDaysToFirstReceipt: mean(firstDays),
    firstReceiptSample: firstDays.length,
    avgDaysToFullReceipt: mean(fullDays),
    fullReceiptSample: fullDays.length,
  }
}
