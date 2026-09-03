-- Reverse the receipt posted by accident on 2026-08-22 against PO-0007 (Lost8s).
--
-- The receipt was posted while driving /register/receiving to verify a form-control
-- conversion. It linked to PO-0007, moved 10 + 10 units into Main Store (Baytree), and
-- flipped the order from ORDERED to RECEIVED.
--
-- This deliberately breaks the append-only rule for inventory movements and receipts.
-- It is a one-off correction of fabricated data on the DEV database, authorised by Kasan —
-- NOT a pattern, and never a code path. There is no "undo receipt" endpoint by design.
--
-- Run with:
--   docker exec -i huta-pg psql -U huta -d huta_pos < scripts/revert-accidental-receipt.sql

\set receipt 'cmt3nb3gt001ytyr8q895gw36'

BEGIN;

DELETE FROM "InventoryMovement" WHERE "receiptId" = :'receipt';

-- These two StockLevel rows were CREATED by that receipt — neither variant had any movement
-- history before it — so deleting them restores "no row", which is the state that was there,
-- rather than leaving a row sitting at zero.
DELETE FROM "StockLevel"
 WHERE "variantId" IN ('cmsu3br870043vwr8mrxh517w', 'cmsu3bvx800l1vwr8ctwqtbka')
   AND "storeId" = (SELECT id FROM "Store" WHERE name = 'Main Store (Baytree)');

DELETE FROM "ReceiptLine" WHERE "receiptId" = :'receipt';
DELETE FROM "AuditLog"    WHERE "entityId"  = :'receipt';
DELETE FROM "Receipt"     WHERE id          = :'receipt';

-- Back to the open order it was, with no delivery recorded against it.
UPDATE "PurchaseOrder"
   SET status = 'ORDERED', "firstReceiptAt" = NULL, "fullyReceivedAt" = NULL
 WHERE number = 7;

COMMIT;

-- ————— verification —————
SELECT number, status, "orderedAt"::date, "firstReceiptAt", "fullyReceivedAt"
  FROM "PurchaseOrder" WHERE number = 7;

SELECT
  (SELECT count(*) FROM "Receipt" WHERE id = :'receipt')                     AS receipt_rows,
  (SELECT count(*) FROM "ReceiptLine" WHERE "receiptId" = :'receipt')        AS receipt_lines,
  (SELECT count(*) FROM "InventoryMovement" WHERE "receiptId" = :'receipt')  AS movements,
  (SELECT count(*) FROM "StockLevel"
     WHERE "variantId" IN ('cmsu3br870043vwr8mrxh517w','cmsu3bvx800l1vwr8ctwqtbka')) AS stock_rows;
-- Every one of those should read 0, and PO-0007 should read ORDERED with both dates NULL.
