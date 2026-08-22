-- Indexes for the per-person activity figures on the Staff page.
--
-- InventoryMovement is the one that actually matters: it is the largest table in the system
-- (every sale line writes a row) and `userId` had no index at all, so "how many stock
-- movements has this person made" was a full scan on a table that reaches six figures in a
-- couple of years.
--
-- CashMovement.userId is deliberately NOT indexed. That table is a few hundred rows for the
-- life of the business; an index there would be cargo cult.
CREATE INDEX "Shift_openedById_openedAt_idx"       ON "Shift"("openedById", "openedAt");
CREATE INDEX "Shift_closedById_idx"                ON "Shift"("closedById");
CREATE INDEX "InventoryMovement_userId_createdAt_idx" ON "InventoryMovement"("userId", "createdAt");
CREATE INDEX "Refund_refundedById_createdAt_idx"   ON "Refund"("refundedById", "createdAt");
