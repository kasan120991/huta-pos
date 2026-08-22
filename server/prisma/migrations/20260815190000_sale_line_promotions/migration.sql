-- Promotions applied to a sale line become a LIST.
--
-- "Best outcome for the customer" combines stackable promotions, so more than one can
-- price a single line. `SaleLine."promotionId"` was a single nullable FK, which would have
-- recorded exactly one of them and under-reported every other promotion's performance.
-- the house rules are explicit that these snapshots "must be written correctly from the very
-- first sale — none of them can be backfilled."
--
-- Dropping the column is free: Sale, SaleLine and Refund are all empty. Keeping both would
-- leave two sources of truth for the same fact.

DROP INDEX IF EXISTS "SaleLine_promotionId_idx";

ALTER TABLE "SaleLine" DROP CONSTRAINT IF EXISTS "SaleLine_promotionId_fkey";
ALTER TABLE "SaleLine" DROP COLUMN IF EXISTS "promotionId";

CREATE TABLE "SaleLinePromotion" (
  "saleLineId"    TEXT    NOT NULL,
  "promotionId"   TEXT    NOT NULL,
  "discountCents" INTEGER NOT NULL,
  "sequence"      INTEGER NOT NULL,
  "nameSnapshot"  TEXT    NOT NULL,

  CONSTRAINT "SaleLinePromotion_pkey" PRIMARY KEY ("saleLineId", "promotionId")
);

CREATE INDEX "SaleLinePromotion_promotionId_idx" ON "SaleLinePromotion"("promotionId");

ALTER TABLE "SaleLinePromotion"
  ADD CONSTRAINT "SaleLinePromotion_saleLineId_fkey"
  FOREIGN KEY ("saleLineId") REFERENCES "SaleLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not SET NULL: a promotion that has priced a sale is part of the audit trail
-- and must not be deletable out from under it. Deactivate it instead.
ALTER TABLE "SaleLinePromotion"
  ADD CONSTRAINT "SaleLinePromotion_promotionId_fkey"
  FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A promotion can only ever take money off, never add it. Zero is legal and meaningful:
-- an OVERRIDE_PRICE_PER_GRAM's effect lives in the line's grossCents as a replaced rate,
-- so it subtracts nothing here by construction.
ALTER TABLE "SaleLinePromotion"
  ADD CONSTRAINT "SaleLinePromotion_discount_nonneg_check"
  CHECK ("discountCents" >= 0);

ALTER TABLE "SaleLinePromotion"
  ADD CONSTRAINT "SaleLinePromotion_sequence_nonneg_check"
  CHECK ("sequence" >= 0);
