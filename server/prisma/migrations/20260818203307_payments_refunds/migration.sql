-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cardBrand" TEXT,
ADD COLUMN     "cardLast4" TEXT;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'SUCCEEDED';

-- CreateIndex
CREATE INDEX "Refund_shiftId_idx" ON "Refund"("shiftId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 9 CHECK constraints (hand-written — Prisma's schema language cannot express them).

-- A $0 sale (100% discount) must still be voidable, and a void writes Refund rows for
-- the full disbursement — which is zero. Relax the Phase-1 strict-positive check.
ALTER TABLE "Refund" DROP CONSTRAINT "Refund_amount_check";
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amountCents" >= 0);

-- A Stripe refund id on a cash refund is a data error, same shape as
-- Payment_method_fields_check.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_method_fields_check"
  CHECK ("method" = 'CARD' OR "stripeRefundId" IS NULL);

-- Card brand/last4 describe a card; they must not appear on a cash payment.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_card_fields_check"
  CHECK ("method" = 'CARD' OR ("cardBrand" IS NULL AND "cardLast4" IS NULL));
