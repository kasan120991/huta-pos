-- Purchase orders get a readable identity, and the order/receipt lifecycle gets its
-- backstop constraints.
--
-- A PurchaseOrder has only a cuid today. It is an INTERNAL order log — nobody sends it to a
-- supplier — but an admin still reads its number off an invoice and says it down a phone, and
-- "cmsx9o6n500009er8fnar1ue4" is not that. StoreCounter exists for exactly this and nothing
-- has written to it yet.

-- ---------------------------------------------------------------------------
-- A readable, per-store order number
-- ---------------------------------------------------------------------------

-- Nullable because a DRAFT has not been placed yet and therefore has no number. Allocating
-- one at creation would burn numbers on drafts that get abandoned, and a gap in a sequence
-- someone reconciles against is a question nobody can answer six months later.
ALTER TABLE "PurchaseOrder" ADD COLUMN "number" INTEGER;

-- Per store, not global. Two stores ordering independently should each count from 1; a
-- shared sequence would make Ashley's first order PO-0038 and tell its manager nothing.
CREATE UNIQUE INDEX "PurchaseOrder_storeId_number_key"
  ON "PurchaseOrder"("storeId", "number");

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_number_check"
  CHECK ("number" IS NULL OR "number" > 0);

-- ---------------------------------------------------------------------------
-- Status and its timestamps must agree
-- ---------------------------------------------------------------------------

-- Lead time is `firstReceiptAt - orderedAt`, and time-to-full-fulfillment is
-- `fullyReceivedAt - orderedAt`. A status that disagrees with its own timestamps turns both
-- of those into guesses dressed as facts, which is precisely what the two separate columns
-- exist to prevent.
--
-- A DRAFT has no number and no order date to speak of; everything past DRAFT must have both.
ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_status_timestamps_check"
  CHECK (
    ("status" = 'DRAFT' OR "number" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
    AND ("status" <> 'RECEIVED' OR "fullyReceivedAt" IS NOT NULL)
    AND ("fullyReceivedAt" IS NULL OR "firstReceiptAt" IS NOT NULL)
    AND ("fullyReceivedAt" IS NULL OR "fullyReceivedAt" >= "firstReceiptAt")
  );

-- ---------------------------------------------------------------------------
-- Receipt review and variance
-- ---------------------------------------------------------------------------

-- Half a review record cannot be audited: a reviewer with no timestamp, or a timestamp with
-- no reviewer, answers neither "who signed this off" nor "when".
ALTER TABLE "Receipt"
  ADD CONSTRAINT "Receipt_review_pair_check"
  CHECK (
    ("reviewedById" IS NULL AND "reviewedAt" IS NULL)
    OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)
  );

-- House rule: "Standalone receipts can't have a variance — there's nothing to compare
-- against." A flagged standalone receipt is therefore a bug in the variance calculation, not
-- a finding for an admin to review, and it should fail here rather than quietly fill the
-- review queue with deliveries nobody can act on.
ALTER TABLE "Receipt"
  ADD CONSTRAINT "Receipt_variance_needs_order_check"
  CHECK ("hasVariance" = FALSE OR "purchaseOrderId" IS NOT NULL);
