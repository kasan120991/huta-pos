import type { TrackingMode } from '@huta/shared'
import { unitCostFromBasis } from '@huta/shared'
import type {
  CheckoutInput,
  ReceiptPayment,
  SaleIntentInput,
  SaleIntentResult,
  SaleReceipt,
  SaleReceiptLine,
} from '@huta/shared/schemas'

import { assertCan, canSeeCost } from '../auth/permissions.js'
import type { Principal } from '../auth/principal.js'
import { prisma } from '../db/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import {
  AgeVerificationRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentFailedError,
} from '../errors/index.js'
import { bearsCannabinoids, resolveSupplierId } from '../catalog/variant-identity.js'
import { applyMovement } from '../inventory/inventory.service.js'
import type { IntentInfo } from '../payments/provider.js'
import { getPaymentProvider } from '../payments/provider.js'
import { quote } from '../pricing/pricing.service.js'
import { emitToAdmin, emitToStore } from '../realtime/emitter.js'

type Db = Prisma.TransactionClient

/**
 * Checkout — the first and only writer of Sale/SaleLine.
 *
 * Every column written here is a SNAPSHOT that can never be backfilled: the price, the
 * per-gram rate, the tier, the promotion list, the tax rate, the supplier, and the
 * weighted-average cost at the moment stock left the shelf. Re-displaying or reporting a
 * sale reads these columns and never joins to current catalog or pricing state.
 *
 * Everything happens in ONE transaction whose first locked read is the OPEN shift row.
 * That lock settles the close-vs-checkout race (a close computes expected cash over a
 * settled set of sales) and serialises checkouts per store, which also prevents
 * StockLevel lock ordering deadlocks across multi-line carts.
 */

const SALE_COUNTER = 'sale'

/** Clone of the PO allocator: ensure-then-lock, because FOR UPDATE cannot lock a row
 *  that does not exist and `upsert` is two statements that race. */
async function nextSaleNumber(tx: Db, storeId: string): Promise<number> {
  await tx.storeCounter.createMany({
    data: [{ storeId, name: SALE_COUNTER, value: 0 }],
    skipDuplicates: true,
  })
  const locked = await tx.$queryRaw<Array<{ value: number }>>`
    SELECT "value" FROM "StoreCounter"
     WHERE "storeId" = ${storeId} AND "name" = ${SALE_COUNTER}
     FOR UPDATE
  `
  const next = (locked[0]?.value ?? 0) + 1
  await tx.storeCounter.update({
    where: { storeId_name: { storeId, name: SALE_COUNTER } },
    data: { value: next },
  })
  return next
}

/** The terminal's store — how an ADMIN covering the counter resolves a store, since an
 *  admin principal keeps `storeId: null` even while attached. */
async function resolveStoreId(principal: Principal): Promise<string> {
  if (principal.terminalId === null) {
    throw new ForbiddenError('Ring sales from a register — attach at a terminal first.')
  }
  if (principal.storeId !== null) return principal.storeId

  const terminal = await prisma.terminal.findUnique({
    where: { id: principal.terminalId },
    select: { storeId: true, active: true },
  })
  if (!terminal || !terminal.active) throw new NotFoundError('That terminal does not exist.')
  return terminal.storeId
}

/**
 * Stage the card charge for a sale-in-progress. The amount comes from the SERVER's own
 * quote of the cart — never the client's arithmetic — and equals `total − cashCents` so a
 * split sale's card portion is fixed before the customer taps. The client confirms the
 * returned clientSecret with Stripe Elements, then calls `checkout` with the intent id.
 */
export async function createSaleIntent(
  principal: Principal,
  input: SaleIntentInput,
): Promise<SaleIntentResult> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, 'sale.ring', { storeId })
  if (principal.userId === null || principal.terminalId === null) {
    throw new ForbiddenError('A sale needs a cashier at a register.')
  }

  const quoted = await quote({
    storeId,
    lines: input.lines,
    ...(input.orderDiscount ? { orderDiscount: input.orderDiscount } : {}),
  })

  const cardAmountCents = quoted.totalCents - input.cashCents
  if (cardAmountCents <= 0) {
    throw new ConflictError('Nothing is left for the card — the cash already covers this sale.')
  }

  const intent = await getPaymentProvider().createIntent({
    amountCents: cardAmountCents,
    // Traceability for the Stripe dashboard and for reconciling an orphaned charge.
    metadata: { storeId, terminalId: principal.terminalId, cashierId: principal.userId },
  })

  return {
    paymentIntentId: intent.id,
    clientSecret: intent.clientSecret,
    cardAmountCents,
    totalCents: quoted.totalCents,
  }
}

/** The register discards a staged intent whenever the cart changes. Best-effort. */
export async function cancelSaleIntent(principal: Principal, intentId: string): Promise<void> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, 'sale.ring', { storeId })
  await getPaymentProvider().cancelIntent(intentId)
}

export async function checkout(principal: Principal, input: CheckoutInput): Promise<SaleReceipt> {
  const storeId = await resolveStoreId(principal)
  assertCan(principal, 'sale.ring', { storeId })
  if (principal.userId === null) throw new ForbiddenError('A sale needs a cashier.')
  const cashierId = principal.userId

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { taxRateBps: true },
  })
  if (!store) throw new NotFoundError('That store does not exist.')

  const cashTender = input.tenders.find((t) => t.method === 'CASH')
  const cardTender = input.tenders.find((t) => t.method === 'CARD')

  // The Stripe round-trip happens OUTSIDE the transaction: the shift lock serialises a
  // store's checkouts, and one slow network call under it would stall the whole drawer.
  // Only the amount is re-verified inside, against the transaction's own quote.
  let intent: IntentInfo | null = null
  if (cardTender) {
    intent = await getPaymentProvider().retrieveIntent(cardTender.paymentIntentId)
    if (intent.status !== 'succeeded') {
      throw new PaymentFailedError(
        'not_succeeded',
        'The card payment has not gone through — confirm it before completing the sale.',
      )
    }
  }

  const runCheckout = async (): Promise<string> => prisma.$transaction(
    async (tx) => {
      // The shift lock comes FIRST — see the module comment.
      const shifts = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Shift"
         WHERE "storeId" = ${storeId} AND "status" = 'OPEN'
         FOR UPDATE
      `
      const shift = shifts[0]
      if (!shift) throw new ConflictError('Open a shift before ringing a sale.')

      // Re-price INSIDE the transaction: the receipt's numbers are the numbers that were
      // true when the stock moved. The quote already enforces active variants, positive
      // quantities, and each variant's min/max sale bounds.
      const quoted = await quote(
        {
          storeId,
          lines: input.lines,
          ...(input.orderDiscount ? { orderDiscount: input.orderDiscount } : {}),
        },
        tx,
      )

      // Checkout extras the quote does not carry: the supplier to attribute the sale
      // to, and whether the line is cannabinoid-bearing. BOTH are read at the variant
      // level first and fall back to the product — strains are variants of one flower
      // product (the house rules, Domain model), so reading the product alone would attribute
      // every strain to one supplier and miss a strain whose potency is recorded on the
      // variant. See catalog/variant-identity.ts for the rules.
      const variantIds = [...new Set(quoted.lines.map((l) => l.variantId))]
      const extras = await tx.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: {
          id: true,
          supplierId: true,
          _count: { select: { cannabinoids: true } },
          product: {
            select: {
              primarySupplierId: true,
              _count: { select: { cannabinoids: true } },
            },
          },
        },
      })
      const extraById = new Map(extras.map((e) => [e.id, e]))
      const supplierFor = (variantId: string): string | null => {
        const extra = extraById.get(variantId)
        return resolveSupplierId(extra?.supplierId, extra?.product.primarySupplierId)
      }

      /**
       * Age verification (21+). NOTE the data caveat: much of the legacy catalog has no
       * ProductCannabinoid links, so a cannabinoid product without links will not trip
       * this. The spec keys on the links deliberately — fix the data, not the rule.
       */
      const needsAge = quoted.lines.some((l) => {
        const extra = extraById.get(l.variantId)
        return bearsCannabinoids(
          extra?._count.cannabinoids ?? 0,
          extra?.product._count.cannabinoids ?? 0,
        )
      })
      if (needsAge && !input.ageVerified) throw new AgeVerificationRequiredError()

      // Tax comes FROM the quote — computed there with this exact math, so what the
      // register displayed is what the sale records. One source of truth.
      const taxCents = quoted.taxCents
      const totalCents = quoted.totalCents

      /**
       * Tender arithmetic. The card amount is the INTENT's — fixed when it was staged,
       * never from the body — so it is re-verified against this transaction's own quote.
       * Any disagreement means the cart or the cash split changed after staging; the
       * remedy is a fresh intent, so it is a PAYMENT_FAILED the register branches on
       * (and the catch below refunds the already-taken charge).
       */
      const cardCents = intent?.amountCents ?? 0
      const cashDue = totalCents - cardCents
      if (totalCents === 0 && input.tenders.length > 0) {
        throw new ConflictError('Nothing is due for this sale — complete it without a tender.')
      }
      if (intent) {
        if (cashDue < 0 || (cashTender?.tenderedCents ?? 0) !== cashDue) {
          throw new PaymentFailedError(
            'amount_mismatch',
            'The card was charged for a different total than this sale — the charge has been reversed. Re-check the cart and take the card again.',
          )
        }
      } else if (totalCents > 0) {
        if (!cashTender) {
          throw new ConflictError('This sale has nothing paying for it — add a tender.')
        }
        if (cashTender.tenderedCents < totalCents) {
          throw new ConflictError(
            `Not enough tendered: the total is ${totalCents} cents and ${cashTender.tenderedCents} were presented.`,
          )
        }
      }

      const number = await nextSaleNumber(tx, storeId)

      const sale = await tx.sale.create({
        data: {
          number,
          storeId,
          shiftId: shift.id,
          terminalId: principal.terminalId,
          cashierId,
          subtotalCents: quoted.subtotalCents,
          discountCents: quoted.discountCents,
          taxCents,
          totalCents,
          taxRateBps: store.taxRateBps,
          ageVerified: input.ageVerified,
          ageVerifiedById: input.ageVerified ? cashierId : null,
        },
        select: { id: true },
      })

      for (const line of quoted.lines) {
        // Stock out first: InsufficientStockError rolls the whole sale back, and the
        // movement result carries the pre-sale basis the cost snapshot needs.
        const movement = await applyMovement(
          {
            storeId,
            variantId: line.variantId,
            type: 'SALE',
            quantityBase: -line.quantityBase,
            userId: cashierId,
            reference: { saleId: sale.id },
          },
          tx,
        )

        // Weighted-average cost at the MOMENT of sale. Null basis stays null — valuing
        // unknown stock at zero would drag every margin this line touches toward 100%.
        const unitCostCents = unitCostFromBasis(
          line.trackingMode as TrackingMode,
          movement.previousCostBasisCents,
          movement.previousBase,
        )

        await tx.saleLine.create({
          data: {
            saleId: sale.id,
            variantId: line.variantId,
            productNameSnapshot: line.productName,
            variantLabelSnapshot: line.variantLabel,
            trackingMode: line.trackingMode as TrackingMode,
            quantityBase: line.quantityBase,
            unitPriceCents: line.unitPriceCents,
            pricePerGramCents: line.pricePerGramCents,
            unitCostCents,
            supplierId: supplierFor(line.variantId),
            priceTierId: line.appliedTierId,
            grossCents: line.grossCents,
            discountCents: line.discountCents,
            netCents: line.netCents,
            taxCents: line.taxCents,
            // The promotions LIST: array order IS application order (the override, when
            // present, rides at index 0 with discountCents 0 — its effect is in gross).
            promotions: {
              createMany: {
                data: line.appliedPromotions.map((p, sequence) => ({
                  promotionId: p.promotionId,
                  discountCents: p.discountCents,
                  sequence,
                  nameSnapshot: p.name,
                })),
              },
            },
          },
        })
      }

      // Card first (createdAt orders the receipt's rows). The @unique on the intent id
      // is the backstop against one charge paying for two sales — a concurrent checkout
      // racing this one dies here on P2002, after which nothing refunds the intent,
      // because the money belongs to the sale that won.
      if (intent) {
        try {
          await tx.payment.create({
            data: {
              saleId: sale.id,
              method: 'CARD',
              amountCents: cardCents,
              status: 'SUCCEEDED',
              stripePaymentIntentId: intent.id,
              cardBrand: intent.cardBrand,
              cardLast4: intent.cardLast4,
            },
          })
        } catch (error) {
          if ((error as { code?: string }).code === 'P2002') {
            throw new PaymentFailedError(
              'intent_already_used',
              'That card payment already paid for another sale.',
            )
          }
          throw error
        }
      }

      // A $0 sale writes no payment at all — an amountCents of 0 is a CHECK violation,
      // and "paid with nothing" is exactly what happened.
      if (cashDue > 0 && cashTender) {
        await tx.payment.create({
          data: {
            saleId: sale.id,
            method: 'CASH',
            // The amount KEPT; the drawer arithmetic — what was handed over and what
            // went back — lives in tendered/change. In a split, cash is exact by rule.
            amountCents: cashDue,
            status: 'SUCCEEDED',
            cashTenderedCents: cashTender.tenderedCents,
            cashChangeCents: cashTender.tenderedCents - cashDue,
          },
        })
      }

      return sale.id
    },
    { timeout: 15_000 },
  )

  let saleId: string
  try {
    saleId = await runCheckout()
  } catch (error) {
    // Prisma throws only after the rollback, so reaching here means NO sale exists. If
    // the card was already charged and the money is not claimed by another sale (the
    // intent_already_used case — that money belongs to the sale that won), give it back
    // rather than orphaning it. If even the refund fails, log loudly: the intent id is
    // in Stripe's dashboard and in this line, never silently lost.
    const claimedElsewhere =
      error instanceof PaymentFailedError && error.details?.['reason'] === 'intent_already_used'
    if (intent && !claimedElsewhere) {
      try {
        await getPaymentProvider().refund({
          paymentIntentId: intent.id,
          amountCents: intent.amountCents,
        })
      } catch (refundError) {
        console.error(
          `[payments] URGENT: auto-refund of ${intent.id} (${intent.amountCents} cents) failed after a checkout rollback — refund it manually in the Stripe dashboard.`,
          refundError,
        )
      }
    }
    throw error
  }

  const receipt = await getSale(principal, saleId)

  // After commit, never throwing — announcing a sale a rollback erased would be worse
  // than announcing nothing.
  emitToAdmin({
    name: 'sale.completed',
    payload: {
      saleId,
      storeId,
      storeName: receipt.storeName,
      number: receipt.number,
      totalCents: receipt.totalCents,
    },
  })
  for (const variantId of new Set(receipt.lines.map((l) => l.variantId))) {
    emitToStore(storeId, { name: 'stock.changed', payload: { storeId, variantId } })
  }

  return receipt
}

/** Everything a RefundReceipt renders — shared with the refund service in Phase 9. */
export const refundSelect = {
  id: true,
  saleId: true,
  method: true,
  amountCents: true,
  status: true,
  reason: true,
  createdAt: true,
  refundedBy: { select: { firstName: true, lastName: true } },
  approvedBy: { select: { firstName: true, lastName: true } },
  lines: {
    select: {
      saleLineId: true,
      quantityBase: true,
      amountCents: true,
      restock: true,
      saleLine: {
        select: { productNameSnapshot: true, variantLabelSnapshot: true, trackingMode: true },
      },
    },
  },
} as const

type RefundRecord = Prisma.RefundGetPayload<{ select: typeof refundSelect }>

export function mapRefund(refund: RefundRecord, saleNumber: number) {
  return {
    id: refund.id,
    saleId: refund.saleId,
    saleNumber,
    method: refund.method,
    amountCents: refund.amountCents,
    status: refund.status,
    reason: refund.reason,
    refundedByName:
      `${refund.refundedBy.firstName} ${refund.refundedBy.lastName}`.trim(),
    approvedByName: refund.approvedBy
      ? `${refund.approvedBy.firstName} ${refund.approvedBy.lastName}`.trim()
      : null,
    createdAt: refund.createdAt.toISOString(),
    lines: refund.lines.map((line) => ({
      saleLineId: line.saleLineId,
      productName: line.saleLine.productNameSnapshot,
      variantLabel: line.saleLine.variantLabelSnapshot,
      trackingMode: line.saleLine.trackingMode as TrackingMode,
      quantityBase: line.quantityBase,
      amountCents: line.amountCents,
      restock: line.restock,
    })),
  }
}

export async function getSale(principal: Principal, id: string): Promise<SaleReceipt> {
  const includeCost = canSeeCost(principal)

  const sale = await prisma.sale.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      storeId: true,
      store: { select: { name: true } },
      terminalId: true,
      cashier: { select: { firstName: true, lastName: true } },
      createdAt: true,
      status: true,
      subtotalCents: true,
      discountCents: true,
      taxCents: true,
      totalCents: true,
      taxRateBps: true,
      ageVerified: true,
      voidedAt: true,
      voidReason: true,
      payments: {
        orderBy: { createdAt: 'asc' },
        select: {
          method: true,
          amountCents: true,
          cashTenderedCents: true,
          cashChangeCents: true,
          cardBrand: true,
          cardLast4: true,
          status: true,
        },
      },
      refunds: {
        orderBy: { createdAt: 'asc' },
        select: refundSelect,
      },
      lines: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          variantId: true,
          productNameSnapshot: true,
          variantLabelSnapshot: true,
          trackingMode: true,
          quantityBase: true,
          unitPriceCents: true,
          pricePerGramCents: true,
          priceTierId: true,
          grossCents: true,
          discountCents: true,
          netCents: true,
          taxCents: true,
          refundedQuantityBase: true,
          // Cost decided AT THE SELECT — it never leaves the database for staff.
          ...(includeCost ? { unitCostCents: true } : {}),
          promotions: {
            orderBy: { sequence: 'asc' },
            select: { promotionId: true, nameSnapshot: true, discountCents: true, sequence: true },
          },
        },
      },
    },
  })
  if (!sale) throw new NotFoundError('That sale does not exist.')
  if (principal.storeId !== null && principal.storeId !== sale.storeId) {
    throw new ForbiddenError('That sale belongs to another store.')
  }

  // Only settled money renders — a PENDING or FAILED card row never took anything. An
  // empty array is legal: a fully discounted $0 sale has no payments at all.
  const payments: ReceiptPayment[] = sale.payments
    .filter((p) => p.status === 'SUCCEEDED')
    .map((p) =>
      p.method === 'CASH'
        ? {
            method: 'CASH' as const,
            amountCents: p.amountCents,
            cashTenderedCents: p.cashTenderedCents ?? 0,
            cashChangeCents: p.cashChangeCents ?? 0,
          }
        : {
            method: 'CARD' as const,
            amountCents: p.amountCents,
            cardBrand: p.cardBrand,
            cardLast4: p.cardLast4,
          },
    )

  return {
    id: sale.id,
    number: sale.number,
    storeId: sale.storeId,
    storeName: sale.store.name,
    terminalId: sale.terminalId,
    cashierName: `${sale.cashier.firstName} ${sale.cashier.lastName}`.trim(),
    createdAt: sale.createdAt.toISOString(),
    status: sale.status,
    subtotalCents: sale.subtotalCents,
    discountCents: sale.discountCents,
    taxCents: sale.taxCents,
    totalCents: sale.totalCents,
    taxRateBps: sale.taxRateBps,
    ageVerified: sale.ageVerified,
    voidedAt: sale.voidedAt?.toISOString() ?? null,
    voidReason: sale.voidReason,
    payments,
    refunds: sale.refunds.map((refund) => mapRefund(refund, sale.number)),
    lines: sale.lines.map((line): SaleReceiptLine => {
      const row: SaleReceiptLine = {
        id: line.id,
        variantId: line.variantId,
        productName: line.productNameSnapshot,
        variantLabel: line.variantLabelSnapshot,
        trackingMode: line.trackingMode as TrackingMode,
        quantityBase: line.quantityBase,
        unitPriceCents: line.unitPriceCents,
        pricePerGramCents: line.pricePerGramCents,
        priceTierId: line.priceTierId,
        grossCents: line.grossCents,
        discountCents: line.discountCents,
        netCents: line.netCents,
        taxCents: line.taxCents,
        refundedQuantityBase: line.refundedQuantityBase,
        promotions: line.promotions,
      }
      if (includeCost) {
        return { ...row, unitCostCents: (line as { unitCostCents?: number | null }).unitCostCents ?? null }
      }
      return row
    }),
  }
}
