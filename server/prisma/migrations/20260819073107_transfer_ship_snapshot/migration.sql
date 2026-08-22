-- AlterTable
ALTER TABLE "TransferRequest" ADD COLUMN     "shippedById" TEXT;

-- AlterTable
ALTER TABLE "TransferRequestLine" ADD COLUMN     "shippedCostCents" INTEGER;

-- AddForeignKey
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_shippedById_fkey" FOREIGN KEY ("shippedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The value in transit is a snapshot of relieved basis — never negative.
ALTER TABLE "TransferRequestLine" ADD CONSTRAINT "TransferRequestLine_shippedCost_check"
  CHECK ("shippedCostCents" IS NULL OR "shippedCostCents" >= 0);
