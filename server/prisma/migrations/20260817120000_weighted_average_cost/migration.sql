-- Weighted-average costing, scoped per store.
--
-- The design left the costing method open: "when the same variant is received at different
-- costs, is margin computed on last cost, weighted average, or FIFO?" Settled as WEIGHTED
-- AVERAGE, per store. Each store's on-hand stock carries its own cost basis, so a store
-- that received a variant at $4/g and one that received it at $5/g each report an honest
-- margin instead of a blend neither of them actually paid.
--
-- The stored number is the POOL'S TOTAL VALUE, not the average. Storing an average would
-- mean re-rounding it on every single receive and compounding the error indefinitely;
-- storing the total rounds once per receipt line and lets the average be derived for
-- display. `ProductVariant."costCents"` keeps its documented meaning — most recent unit
-- cost — and is not what margin is computed from.

-- ---------------------------------------------------------------------------
-- Cost basis on the materialized stock row
-- ---------------------------------------------------------------------------

-- Nullable on purpose. Stock received by a staff member carries no cost until an admin
-- enters one, and NULL says "we do not know what this cost" where 0 would say "this was
-- free" — a difference that shows up directly in every margin number.
ALTER TABLE "StockLevel" ADD COLUMN "costBasisCents" INTEGER;

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_cost_basis_check"
  CHECK ("costBasisCents" IS NULL OR "costBasisCents" >= 0);

-- ---------------------------------------------------------------------------
-- Cost on the ledger
-- ---------------------------------------------------------------------------

-- `costBasisAfterCents` is to cost what `balanceAfterBase` is to quantity. Without it,
-- "why did this variant's average cost jump in March" cannot be answered without replaying
-- the entire ledger from zero, which is precisely the situation balanceAfterBase was added
-- to avoid.
ALTER TABLE "InventoryMovement" ADD COLUMN "unitCostCents" INTEGER;
ALTER TABLE "InventoryMovement" ADD COLUMN "costBasisAfterCents" INTEGER;

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_cost_check"
  CHECK (
    ("unitCostCents" IS NULL OR "unitCostCents" >= 0)
    AND ("costBasisAfterCents" IS NULL OR "costBasisAfterCents" >= 0)
  );

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- The legacy import populated ProductVariant."costCents" from the old system's
-- `purchase_price`, so existing stock has a real cost to seed from. Seeding from it beats
-- leaving the basis NULL: every legacy row would otherwise read as uncosted forever, and
-- the first receive would have to guess whether the existing pile was free.
--
-- WEIGHT variants store cost as cents per GRAM while quantityBase counts MILLIGRAMS, hence
-- the /1000. Getting this wrong makes flower margin silently 1000x wrong, which is why the
-- conversion lives in exactly one place in application code (shared/src/costing.ts) and is
-- written out explicitly here.
UPDATE "StockLevel" sl
   SET "costBasisCents" =
     CASE v."trackingMode"
       WHEN 'EACH'   THEN sl."quantityBase" * v."costCents"
       WHEN 'WEIGHT' THEN ROUND(sl."quantityBase"::numeric * v."costCents" / 1000)
     END
  FROM "ProductVariant" v
 WHERE v."id" = sl."variantId"
   AND v."costCents" IS NOT NULL
   AND sl."quantityBase" > 0;
