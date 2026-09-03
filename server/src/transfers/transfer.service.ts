import { MovementType, TransferStatus, divRoundHalfUp } from '@huta/shared'
import type {
  DirectMoveInput,
  TransferAcceptInput,
  TransferAvailabilityRow,
  TransferCancelInput,
  TransferCreateInput,
  TransferLineInput,
  TransferReceiveInput,
  TransferRow,
} from '@huta/shared/schemas'

import { assertCan, canSeeCost, scopeStoreId } from '../auth/permissions.js'
import { type Principal, isAdmin } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/index.js'
import type { Prisma } from '../generated/prisma/client.js'
import { applyMovement } from '../inventory/inventory.service.js'
import { emitToAdmin, emitToStore } from '../realtime/emitter.js'

/**
 * Transfers — Phase 10. Request → source fulfills → destination confirms.
 *
 * The lifecycle is PENDING → ACCEPTED → IN_TRANSIT → RECEIVED, with DECLINED and
 * CANCELLED as exits. Two structural rules carry everything else:
 *
 *   - **Every transition locks the TransferRequest row FOR UPDATE first.** Two staff
 *     tapping Ship at once must resolve to exactly one set of TRANSFER_OUT movements —
 *     the loser's transaction blocks on the lock, re-reads a status that is no longer
 *     ACCEPTED, and fails cleanly. Double-ship is impossible by construction, not by UI.
 *
 *   - **In-transit stock belongs to NEITHER store.** The source is relieved at ship, the
 *     destination gains at receive — different transactions at different times. The value
 *     in transit lives on `TransferRequestLine.shippedCostCents` (the exact share the
 *     source's basis relieved), and the receive leg adds EXACTLY that (proportionally,
 *     for a short receipt) via `costTotalCents`, so cents are conserved across stores.
 *
 * Per-leg gating: request/cancel → `transfer.request` at the REQUESTING store;
 * accept/decline/ship → `transfer.fulfill` at the SOURCE store; receive →
 * `transfer.confirmReceipt` at the REQUESTING store. Staff hold all three capabilities,
 * but each only at their own store — so a request's two sides are two different people.
 *
 * A shortfall at receive writes NO movement anywhere: the source already relieved the
 * full approved quantity at ship, and the destination never got the missing goods. The
 * loss is visible on the line (received < approved) — a future shrinkage report must
 * UNION transfer lines with SHRINKAGE movements, because this loss is in neither.
 */

type Db = Prisma.TransactionClient

// --- serialization -----------------------------------------------------------------------

function lineSelect(showCost: boolean) {
  return {
    id: true,
    quantityRequestedBase: true,
    quantityApprovedBase: true,
    quantityReceivedBase: true,
    // The ONE place transfer-line cost is decided.
    ...(showCost ? { shippedCostCents: true } : {}),
    variant: {
      select: {
        id: true,
        sku: true,
        label: true,
        trackingMode: true,
        product: { select: { name: true } },
      },
    },
  }
}

function transferSelect(showCost: boolean) {
  return {
    id: true,
    status: true,
    requestingStoreId: true,
    sourceStoreId: true,
    declineReason: true,
    note: true,
    createdAt: true,
    acceptedAt: true,
    shippedAt: true,
    receivedAt: true,
    requestingStore: { select: { name: true } },
    sourceStore: { select: { name: true } },
    requestedBy: { select: { firstName: true, lastName: true } },
    acceptedBy: { select: { firstName: true, lastName: true } },
    shippedBy: { select: { firstName: true, lastName: true } },
    receivedBy: { select: { firstName: true, lastName: true } },
    lines: { select: lineSelect(showCost), orderBy: { id: 'asc' as const } },
  }
}

type PersonName = { firstName: string; lastName: string } | null

type TransferQueryRow = {
  id: string
  status: string
  requestingStoreId: string
  sourceStoreId: string
  declineReason: string | null
  note: string | null
  createdAt: Date
  acceptedAt: Date | null
  shippedAt: Date | null
  receivedAt: Date | null
  requestingStore: { name: string }
  sourceStore: { name: string }
  requestedBy: PersonName
  acceptedBy: PersonName
  shippedBy: PersonName
  receivedBy: PersonName
  lines: Array<{
    id: string
    quantityRequestedBase: number
    quantityApprovedBase: number | null
    quantityReceivedBase: number | null
    shippedCostCents?: number | null
    variant: {
      id: string
      sku: string
      label: string | null
      trackingMode: string
      product: { name: string }
    }
  }>
}

const fullName = (person: PersonName): string | null =>
  person ? `${person.firstName} ${person.lastName}`.trim() : null

function toTransferRow(row: TransferQueryRow, showCost: boolean): TransferRow {
  return {
    id: row.id,
    status: row.status as TransferStatus,
    requestingStoreId: row.requestingStoreId,
    requestingStoreName: row.requestingStore.name,
    sourceStoreId: row.sourceStoreId,
    sourceStoreName: row.sourceStore.name,
    // `requestedBy` is ON DELETE RESTRICT so it is always present; "Unknown" would only
    // appear if that ever changed, and it beats crashing a history screen.
    requestedByName: fullName(row.requestedBy) ?? 'Unknown',
    acceptedByName: fullName(row.acceptedBy),
    shippedByName: fullName(row.shippedBy),
    receivedByName: fullName(row.receivedBy),
    note: row.note,
    reason: row.declineReason,
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    lines: row.lines.map((line) => ({
      id: line.id,
      variantId: line.variant.id,
      productName: line.variant.product.name,
      label: line.variant.label,
      sku: line.variant.sku,
      trackingMode: line.variant.trackingMode as TransferRow['lines'][number]['trackingMode'],
      requestedBase: line.quantityRequestedBase,
      approvedBase: line.quantityApprovedBase,
      receivedBase: line.quantityReceivedBase,
      ...(showCost ? { shippedCostCents: line.shippedCostCents ?? null } : {}),
    })),
  }
}

// --- shared plumbing ---------------------------------------------------------------------

/**
 * Lock the request row so this transition serializes against every other, then return
 * what the transition needs to decide. FOR UPDATE on the parent row is the whole
 * concurrency story — line rows and stock rows are only ever touched under it.
 */
async function lockTransfer(
  tx: Db,
  id: string,
): Promise<{ status: string; requestingStoreId: string; sourceStoreId: string }> {
  const rows = await tx.$queryRaw<
    Array<{ status: string; requestingStoreId: string; sourceStoreId: string }>
  >`
    SELECT "status", "requestingStoreId", "sourceStoreId" FROM "TransferRequest"
     WHERE "id" = ${id}
     FOR UPDATE
  `
  const row = rows[0]
  if (!row) throw new NotFoundError('That transfer does not exist.')
  return row
}

/** 404, not 403 — an error response must not confirm another store's transfer exists. */
function assertInvolvedOr404(principal: Principal, row: {
  requestingStoreId: string
  sourceStoreId: string
}): void {
  if (isAdmin(principal)) return
  if (principal.storeId === row.requestingStoreId) return
  if (principal.storeId === row.sourceStoreId) return
  throw new NotFoundError('That transfer does not exist.')
}

function emitTransferChanged(row: {
  id: string
  status: string
  requestingStoreId: string
  sourceStoreId: string
}): void {
  const event = {
    name: 'transfer.changed' as const,
    payload: {
      transferId: row.id,
      status: row.status,
      requestingStoreId: row.requestingStoreId,
      sourceStoreId: row.sourceStoreId,
    },
  }
  emitToStore(row.requestingStoreId, event)
  emitToStore(row.sourceStoreId, event)
  emitToAdmin(event)
}

function requireActor(principal: Principal, verb: string): string {
  if (principal.userId === null) {
    throw new ForbiddenError(`A transfer ${verb} needs an acting user.`)
  }
  return principal.userId
}

async function readTransfer(
  tx: Db,
  id: string,
  showCost: boolean,
): Promise<TransferQueryRow> {
  const row = (await tx.transferRequest.findUnique({
    where: { id },
    select: transferSelect(showCost),
  })) as TransferQueryRow | null
  if (!row) throw new NotFoundError('That transfer does not exist.')
  return row
}

// --- reads -------------------------------------------------------------------------------

export interface ListTransfersFilters {
  readonly storeId?: string | undefined
  readonly status?: TransferStatus | undefined
}

export async function listTransfers(
  principal: Principal,
  filters: ListTransfersFilters = {},
): Promise<TransferRow[]> {
  // Staff hold all three transfer capabilities; a bare terminal holds none. Checking one
  // of them store-agnostically is the "may this principal see transfers at all" gate.
  assertCan(principal, 'transfer.request')

  let involvedStoreId: string | undefined
  if (isAdmin(principal)) {
    involvedStoreId = filters.storeId
  } else {
    if (filters.storeId !== undefined && filters.storeId !== principal.storeId) {
      throw new ForbiddenError('You do not have permission to act on another store.')
    }
    involvedStoreId = principal.storeId ?? undefined
  }

  // Involvement is an OR — a store sees the transfers it is requesting AND the ones it
  // is fulfilling. Direction is a client-side split over the same list.
  const where: Prisma.TransferRequestWhereInput = {
    ...(involvedStoreId
      ? { OR: [{ requestingStoreId: involvedStoreId }, { sourceStoreId: involvedStoreId }] }
      : {}),
    ...(filters.status ? { status: filters.status } : {}),
  }

  const showCost = canSeeCost(principal)
  const rows = (await prisma.transferRequest.findMany({
    where,
    select: transferSelect(showCost),
    orderBy: { createdAt: 'desc' },
    take: 200,
  })) as TransferQueryRow[]

  return rows.map((row) => toTransferRow(row, showCost))
}

export async function getTransfer(principal: Principal, id: string): Promise<TransferRow> {
  assertCan(principal, 'transfer.request')

  const showCost = canSeeCost(principal)
  const row = await readTransfer(prisma, id, showCost)
  assertInvolvedOr404(principal, row)
  return toTransferRow(row, showCost)
}

/**
 * What the SOURCE store actually has on the shelf, for each line of one transfer.
 *
 * This is the figure the fulfilling cashier is missing: the request composer shows the other
 * store's availability while you ASK, but the store being asked to give the stock up — where
 * the decision is genuinely made — had none. Without it, accepting 28g of a strain with 20g
 * in the jar succeeds, and the oversell only surfaces at SHIP, after the accept has committed.
 *
 * Source store, not "the caller's store", because the sheet this feeds is the fulfilment
 * sheet — and for the staff who use it those are the same store anyway. Involvement is
 * checked with the same 404 rule as `getTransfer`: an error must not confirm that another
 * store's transfer exists.
 *
 * Cost-free BY CONSTRUCTION — `quantityBase` is the only column selected, so there is no
 * cost key to strip and no way for one to reappear.
 */
export async function transferAvailability(
  principal: Principal,
  id: string,
): Promise<TransferAvailabilityRow[]> {
  assertCan(principal, 'transfer.request')

  const row = await prisma.transferRequest.findUnique({
    where: { id },
    select: {
      requestingStoreId: true,
      sourceStoreId: true,
      lines: { select: { variantId: true } },
    },
  })
  if (!row) throw new NotFoundError('That transfer does not exist.')
  assertInvolvedOr404(principal, row)

  const levels = await prisma.stockLevel.findMany({
    where: {
      storeId: row.sourceStoreId,
      variantId: { in: row.lines.map((line) => line.variantId) },
    },
    select: { variantId: true, quantityBase: true },
  })

  // LEFT-joined in spirit: a variant with no StockLevel row at that store reads as 0, never
  // as absent. "None there" is an answer the sheet must be able to render.
  const byVariant = new Map(levels.map((level) => [level.variantId, level.quantityBase]))
  return row.lines.map((line) => ({
    variantId: line.variantId,
    quantityBase: byVariant.get(line.variantId) ?? 0,
  }))
}

// --- lifecycle ---------------------------------------------------------------------------

function assertDistinctVariants(lines: readonly TransferLineInput[]): void {
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.variantId)) {
      throw new ValidationError('A transfer lists each product once — combine the quantities.')
    }
    seen.add(line.variantId)
  }
}

async function assertVariantsExist(
  tx: Db,
  lines: readonly TransferLineInput[],
): Promise<void> {
  const count = await tx.productVariant.count({
    where: { id: { in: lines.map((line) => line.variantId) } },
  })
  if (count !== lines.length) {
    throw new NotFoundError('One of those product variants does not exist.')
  }
}

export async function createTransfer(
  principal: Principal,
  input: TransferCreateInput,
): Promise<TransferRow> {
  // The actor acts AT the requesting store: staff request FOR their own store, an admin
  // names one. `scopeStoreId` is the same chokepoint every store-scoped write uses.
  const requestingStoreId = scopeStoreId(principal, input.requestingStoreId)
  assertCan(principal, 'transfer.request', { storeId: requestingStoreId })
  const userId = requireActor(principal, 'request')

  if (input.sourceStoreId === requestingStoreId) {
    throw new ValidationError('A transfer needs two different stores.')
  }
  assertDistinctVariants(input.lines)

  const showCost = canSeeCost(principal)
  const row = await prisma.$transaction(async (tx) => {
    const source = await tx.store.findUnique({
      where: { id: input.sourceStoreId },
      select: { active: true },
    })
    if (!source) throw new NotFoundError('That source store does not exist.')
    if (!source.active) throw new ConflictError('That store is not active.')
    await assertVariantsExist(tx, input.lines)

    const created = await tx.transferRequest.create({
      data: {
        requestingStoreId,
        sourceStoreId: input.sourceStoreId,
        requestedById: userId,
        note: input.note ?? null,
        lines: {
          create: input.lines.map((line) => ({
            variantId: line.variantId,
            quantityRequestedBase: line.quantityBase,
          })),
        },
      },
      select: { id: true },
    })

    return readTransfer(tx, created.id, showCost)
  })

  emitTransferChanged(row)
  return toTransferRow(row, showCost)
}

export async function acceptTransfer(
  principal: Principal,
  id: string,
  input: TransferAcceptInput,
): Promise<TransferRow> {
  const userId = requireActor(principal, 'acceptance')
  const showCost = canSeeCost(principal)

  const row = await prisma.$transaction(async (tx) => {
    const locked = await lockTransfer(tx, id)
    assertInvolvedOr404(principal, locked)
    assertCan(principal, 'transfer.fulfill', { storeId: locked.sourceStoreId })

    if (locked.status !== TransferStatus.PENDING) {
      throw new ConflictError('Only a pending transfer can be accepted.')
    }

    const lines = await tx.transferRequestLine.findMany({
      where: { transferRequestId: id },
      select: { id: true, quantityRequestedBase: true },
    })
    const byId = new Map(lines.map((line) => [line.id, line]))

    const approvals = new Map<string, number>()
    for (const override of input.lines ?? []) {
      const line = byId.get(override.lineId)
      if (!line) throw new NotFoundError('That line is not on this transfer.')
      if (override.approvedBase > line.quantityRequestedBase) {
        throw new ValidationError('A line cannot be approved for more than was requested.')
      }
      approvals.set(override.lineId, override.approvedBase)
    }

    // A line the source did not touch is approved at what was asked for. All-zero is a
    // decline wearing an accept's clothes — refuse it so the record says what happened.
    let anyApproved = false
    for (const line of lines) {
      const approved = approvals.get(line.id) ?? line.quantityRequestedBase
      if (approved > 0) anyApproved = true
      await tx.transferRequestLine.update({
        where: { id: line.id },
        data: { quantityApprovedBase: approved },
      })
    }
    if (!anyApproved) {
      throw new ConflictError('Every line is zero — decline the transfer instead.')
    }

    await tx.transferRequest.update({
      where: { id },
      data: {
        status: TransferStatus.ACCEPTED,
        acceptedById: userId,
        acceptedAt: new Date(),
      },
    })

    return readTransfer(tx, id, showCost)
  })

  emitTransferChanged(row)
  return toTransferRow(row, showCost)
}

export async function declineTransfer(
  principal: Principal,
  id: string,
  reason: string,
): Promise<TransferRow> {
  requireActor(principal, 'decline')
  const showCost = canSeeCost(principal)

  const row = await prisma.$transaction(async (tx) => {
    const locked = await lockTransfer(tx, id)
    assertInvolvedOr404(principal, locked)
    assertCan(principal, 'transfer.fulfill', { storeId: locked.sourceStoreId })

    if (locked.status !== TransferStatus.PENDING) {
      throw new ConflictError('Only a pending transfer can be declined.')
    }

    await tx.transferRequest.update({
      where: { id },
      data: { status: TransferStatus.DECLINED, declineReason: reason },
    })

    return readTransfer(tx, id, showCost)
  })

  emitTransferChanged(row)
  return toTransferRow(row, showCost)
}

export async function cancelTransfer(
  principal: Principal,
  id: string,
  input: TransferCancelInput,
): Promise<TransferRow> {
  requireActor(principal, 'cancellation')
  const showCost = canSeeCost(principal)

  const row = await prisma.$transaction(async (tx) => {
    const locked = await lockTransfer(tx, id)
    assertInvolvedOr404(principal, locked)
    // The REQUESTER'S side cancels — the source's remedy for a request it won't fill is
    // to decline it, which records a reason the requester sees.
    assertCan(principal, 'transfer.request', { storeId: locked.requestingStoreId })

    if (
      locked.status !== TransferStatus.PENDING &&
      locked.status !== TransferStatus.ACCEPTED
    ) {
      throw new ConflictError('A transfer can only be cancelled before it ships.')
    }

    await tx.transferRequest.update({
      where: { id },
      data: {
        status: TransferStatus.CANCELLED,
        ...(input.reason ? { declineReason: input.reason } : {}),
      },
    })

    return readTransfer(tx, id, showCost)
  })

  emitTransferChanged(row)
  return toTransferRow(row, showCost)
}

export async function shipTransfer(principal: Principal, id: string): Promise<TransferRow> {
  const userId = requireActor(principal, 'shipment')
  const showCost = canSeeCost(principal)

  const { row } = await prisma.$transaction(async (tx) => {
    const locked = await lockTransfer(tx, id)
    assertInvolvedOr404(principal, locked)
    assertCan(principal, 'transfer.fulfill', { storeId: locked.sourceStoreId })

    if (locked.status !== TransferStatus.ACCEPTED) {
      throw new ConflictError('Only an accepted transfer can be shipped.')
    }

    // variantId order, so two ships touching overlapping variants lock StockLevel rows
    // in the same sequence and cannot deadlock. Any oversell throws and the WHOLE ship
    // rolls back — a transfer half-shipped is a lie in both stores' ledgers.
    const lines = await tx.transferRequestLine.findMany({
      where: { transferRequestId: id },
      select: { id: true, variantId: true, quantityApprovedBase: true },
      orderBy: { variantId: 'asc' },
    })

    for (const line of lines) {
      const approved = line.quantityApprovedBase ?? 0
      if (approved === 0) continue

      const result = await applyMovement(
        {
          storeId: locked.sourceStoreId,
          variantId: line.variantId,
          type: MovementType.TRANSFER_OUT,
          quantityBase: -approved,
          userId,
          reference: { transferRequestId: id },
        },
        tx,
      )

      // The share the source's basis actually relieved — EXACT, never re-derived from a
      // per-unit figure. Null basis ships as null: unknown value stays unknown in transit.
      const relieved =
        result.previousCostBasisCents === null
          ? null
          : result.previousCostBasisCents - (result.costBasisAfterCents ?? 0)

      await tx.transferRequestLine.update({
        where: { id: line.id },
        data: { shippedCostCents: relieved },
      })
    }

    await tx.transferRequest.update({
      where: { id },
      data: {
        status: TransferStatus.IN_TRANSIT,
        shippedById: userId,
        shippedAt: new Date(),
      },
    })

    return {
      row: await readTransfer(tx, id, showCost),
    }
  })

  emitTransferChanged(row)
  // `stock.changed` now comes from `applyMovement` via the request scope — see
  // realtime/stock-events.ts. Emitting it here as well would double every event.
  return toTransferRow(row, showCost)
}

export async function receiveTransfer(
  principal: Principal,
  id: string,
  input: TransferReceiveInput,
): Promise<TransferRow> {
  const userId = requireActor(principal, 'receipt')
  const showCost = canSeeCost(principal)

  const { row } = await prisma.$transaction(async (tx) => {
    const locked = await lockTransfer(tx, id)
    assertInvolvedOr404(principal, locked)
    assertCan(principal, 'transfer.confirmReceipt', { storeId: locked.requestingStoreId })

    if (locked.status !== TransferStatus.IN_TRANSIT) {
      throw new ConflictError('Only a transfer in transit can be received.')
    }

    const lines = await tx.transferRequestLine.findMany({
      where: { transferRequestId: id },
      select: {
        id: true,
        variantId: true,
        quantityApprovedBase: true,
        shippedCostCents: true,
      },
      orderBy: { variantId: 'asc' },
    })
    const byId = new Map(lines.map((line) => [line.id, line]))

    const counts = new Map<string, number>()
    for (const override of input.lines ?? []) {
      const line = byId.get(override.lineId)
      if (!line) throw new NotFoundError('That line is not on this transfer.')
      if (override.receivedBase > (line.quantityApprovedBase ?? 0)) {
        throw new ValidationError('A line cannot be received for more than was shipped.')
      }
      counts.set(override.lineId, override.receivedBase)
    }

    for (const line of lines) {
      const approved = line.quantityApprovedBase ?? 0
      const received = counts.get(line.id) ?? approved

      // Every line records what was counted — including zero. A shortfall's missing
      // value stays visible on the line (received < approved, shippedCostCents intact);
      // no movement is written for it anywhere, deliberately — see the module comment.
      await tx.transferRequestLine.update({
        where: { id: line.id },
        data: { quantityReceivedBase: received },
      })

      if (received === 0) continue

      // The destination gains the source's exact relieved share. At a full receipt that
      // is the snapshot verbatim (the guard, so no division ever touches the common
      // case); short, it is the proportional share, rounded once.
      const shipped = line.shippedCostCents
      const costTotalCents =
        shipped === null
          ? undefined
          : received === approved
            ? shipped
            : divRoundHalfUp(shipped * received, approved)

      await applyMovement(
        {
          storeId: locked.requestingStoreId,
          variantId: line.variantId,
          type: MovementType.TRANSFER_IN,
          quantityBase: received,
          userId,
          ...(costTotalCents === undefined ? {} : { costTotalCents }),
          reference: { transferRequestId: id },
        },
        tx,
      )
    }

    await tx.transferRequest.update({
      where: { id },
      data: {
        status: TransferStatus.RECEIVED,
        receivedById: userId,
        receivedAt: new Date(),
      },
    })

    return {
      row: await readTransfer(tx, id, showCost),
    }
  })

  emitTransferChanged(row)
  return toTransferRow(row, showCost)
}

// --- admin direct move ---------------------------------------------------------------------

/**
 * Move stock between two stores in ONE transaction — no request, no transit window.
 *
 * Recorded as a TransferRequest born RECEIVED (all four actor fields = the admin), so
 * history and the movement FK stay uniform: every TRANSFER_* movement in the ledger
 * points at a request row, and "who moved this" has one answer for both paths.
 *
 * The canonical pre-lock is the deadlock story: both stores' StockLevel rows are locked
 * up front in one global (storeId, variantId) order, so a concurrent A→B and B→A wait on
 * each other's first lock instead of acquiring in opposite orders and deadlocking.
 * `applyMovement`'s own FOR UPDATE then re-locks rows this transaction already holds,
 * which is a no-op.
 */
export async function directMove(
  principal: Principal,
  input: DirectMoveInput,
): Promise<TransferRow> {
  assertCan(principal, 'inventory.transferBetweenStores')
  const userId = requireActor(principal, 'move')

  if (input.fromStoreId === input.toStoreId) {
    throw new ValidationError('A transfer needs two different stores.')
  }
  assertDistinctVariants(input.lines)

  const showCost = canSeeCost(principal)
  const row = await prisma.$transaction(async (tx) => {
    const stores = await tx.store.findMany({
      where: { id: { in: [input.fromStoreId, input.toStoreId] } },
      select: { id: true },
    })
    if (stores.length !== 2) throw new NotFoundError('That store does not exist.')
    await assertVariantsExist(tx, input.lines)

    const pairs = input.lines
      .flatMap((line) => [
        { storeId: input.fromStoreId, variantId: line.variantId },
        { storeId: input.toStoreId, variantId: line.variantId },
      ])
      .sort((a, b) =>
        a.storeId === b.storeId
          ? a.variantId.localeCompare(b.variantId)
          : a.storeId.localeCompare(b.storeId),
      )
    for (const pair of pairs) {
      await tx.$queryRaw`
        SELECT 1 FROM "StockLevel"
         WHERE "storeId" = ${pair.storeId} AND "variantId" = ${pair.variantId}
         FOR UPDATE
      `
    }

    const now = new Date()
    const created = await tx.transferRequest.create({
      data: {
        requestingStoreId: input.toStoreId,
        sourceStoreId: input.fromStoreId,
        requestedById: userId,
        status: TransferStatus.RECEIVED,
        acceptedById: userId,
        acceptedAt: now,
        shippedById: userId,
        shippedAt: now,
        receivedById: userId,
        receivedAt: now,
        note: input.note ?? null,
      },
      select: { id: true },
    })

    const sorted = [...input.lines].sort((a, b) => a.variantId.localeCompare(b.variantId))
    for (const line of sorted) {
      const out = await applyMovement(
        {
          storeId: input.fromStoreId,
          variantId: line.variantId,
          type: MovementType.TRANSFER_OUT,
          quantityBase: -line.quantityBase,
          userId,
          reference: { transferRequestId: created.id },
        },
        tx,
      )
      const relieved =
        out.previousCostBasisCents === null
          ? null
          : out.previousCostBasisCents - (out.costBasisAfterCents ?? 0)

      await applyMovement(
        {
          storeId: input.toStoreId,
          variantId: line.variantId,
          type: MovementType.TRANSFER_IN,
          quantityBase: line.quantityBase,
          userId,
          ...(relieved === null ? {} : { costTotalCents: relieved }),
          reference: { transferRequestId: created.id },
        },
        tx,
      )

      await tx.transferRequestLine.create({
        data: {
          transferRequestId: created.id,
          variantId: line.variantId,
          quantityRequestedBase: line.quantityBase,
          quantityApprovedBase: line.quantityBase,
          quantityReceivedBase: line.quantityBase,
          shippedCostCents: relieved,
        },
      })
    }

    return readTransfer(tx, created.id, showCost)
  })

  emitTransferChanged(row)
  return toTransferRow(row, showCost)
}
