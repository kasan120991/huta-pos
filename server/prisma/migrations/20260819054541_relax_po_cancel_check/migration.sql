-- Found live (2026-08-19): cancelling a DRAFT violated the status/timestamps CHECK,
-- because it demanded a number for anything past DRAFT — but a draft discarded before
-- placement CORRECTLY has no number. Numbering happens at place time precisely so an
-- abandoned draft never burns one; the constraint must not demand what the design
-- deliberately withholds. CANCELLED joins DRAFT in the number exemption: an order
-- cancelled after placement simply keeps the number it already has.
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT "PurchaseOrder_status_timestamps_check";
ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_status_timestamps_check"
  CHECK (
    ("status" IN ('DRAFT', 'CANCELLED') OR "number" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
    AND ("status" <> 'RECEIVED' OR "fullyReceivedAt" IS NOT NULL)
    AND ("fullyReceivedAt" IS NULL OR "firstReceiptAt" IS NOT NULL)
    AND ("fullyReceivedAt" IS NULL OR "fullyReceivedAt" >= "firstReceiptAt")
  );
