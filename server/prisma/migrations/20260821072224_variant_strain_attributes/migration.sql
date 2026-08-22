-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "coaUrl" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "nose" TEXT,
ADD COLUMN     "strainType" "StrainType",
ADD COLUMN     "supplierId" TEXT,
ADD COLUMN     "terpeneProfile" TEXT;

-- CreateTable
CREATE TABLE "VariantCannabinoid" (
    "variantId" TEXT NOT NULL,
    "cannabinoidId" TEXT NOT NULL,
    "mgPerUnit" INTEGER,
    "percentBps" INTEGER,

    CONSTRAINT "VariantCannabinoid_pkey" PRIMARY KEY ("variantId","cannabinoidId")
);

-- CreateIndex
CREATE INDEX "VariantCannabinoid_cannabinoidId_idx" ON "VariantCannabinoid"("cannabinoidId");

-- CreateIndex
CREATE INDEX "ProductVariant_supplierId_idx" ON "ProductVariant"("supplierId");

-- AddForeignKey
ALTER TABLE "VariantCannabinoid" ADD CONSTRAINT "VariantCannabinoid_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCannabinoid" ADD CONSTRAINT "VariantCannabinoid_cannabinoidId_fkey" FOREIGN KEY ("cannabinoidId") REFERENCES "Cannabinoid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
