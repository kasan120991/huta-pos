/*
  Warnings:

  - You are about to drop the column `brand` on the `Product` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Product_brand_idx";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "brand",
ADD COLUMN     "brandId" TEXT;

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "legacyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_legacyId_key" ON "Brand"("legacyId");

-- CreateIndex
CREATE INDEX "Brand_active_idx" ON "Brand"("active");

-- CreateIndex
CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
