-- Per-region price override for individual product variants (sizes).

-- CreateTable
CREATE TABLE "ProductVariantRegion" (
    "variantId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "price" DECIMAL(10,2),
    "discountedPrice" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVariantRegion_pkey" PRIMARY KEY ("variantId","regionId")
);

-- CreateIndex
CREATE INDEX "ProductVariantRegion_regionId_idx" ON "ProductVariantRegion"("regionId");

-- AddForeignKey
ALTER TABLE "ProductVariantRegion" ADD CONSTRAINT "ProductVariantRegion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantRegion" ADD CONSTRAINT "ProductVariantRegion_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
