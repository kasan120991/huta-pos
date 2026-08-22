-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "reasonCode" TEXT;

-- CreateIndex
CREATE INDEX "InventoryMovement_reasonCode_createdAt_idx" ON "InventoryMovement"("reasonCode", "createdAt");
