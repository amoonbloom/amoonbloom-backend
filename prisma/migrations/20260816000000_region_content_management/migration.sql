-- Region content management: per-region social links, authored legal pages, branches.

-- AlterTable: per-region social links
ALTER TABLE "Region" ADD COLUMN "instagramUrl" TEXT;
ALTER TABLE "Region" ADD COLUMN "facebookUrl" TEXT;
ALTER TABLE "Region" ADD COLUMN "tiktokUrl" TEXT;
ALTER TABLE "Region" ADD COLUMN "threadsUrl" TEXT;
ALTER TABLE "Region" ADD COLUMN "snapchatUrl" TEXT;
ALTER TABLE "Region" ADD COLUMN "xUrl" TEXT;
ALTER TABLE "Region" ADD COLUMN "youtubeUrl" TEXT;

-- CreateEnum
CREATE TYPE "LegalPageSlug" AS ENUM ('TERMS', 'PRIVACY', 'REFUND_POLICY', 'SHIPPING_POLICY', 'PRODUCT_DISCLAIMER');

-- CreateTable
CREATE TABLE "RegionLegalPage" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "slug" "LegalPageSlug" NOT NULL,
    "title" TEXT,
    "title_ar" TEXT,
    "content" TEXT,
    "content_ar" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegionLegalPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegionLegalPage_regionId_idx" ON "RegionLegalPage"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "RegionLegalPage_regionId_slug_key" ON "RegionLegalPage"("regionId", "slug");

-- CreateTable
CREATE TABLE "RegionBranch" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "address" TEXT,
    "address_ar" TEXT,
    "phone" TEXT,
    "hours" TEXT,
    "hours_ar" TEXT,
    "note" TEXT,
    "note_ar" TEXT,
    "mapUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegionBranch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegionBranch_regionId_idx" ON "RegionBranch"("regionId");

-- CreateIndex
CREATE INDEX "RegionBranch_isActive_idx" ON "RegionBranch"("isActive");

-- AddForeignKey
ALTER TABLE "RegionLegalPage" ADD CONSTRAINT "RegionLegalPage_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegionBranch" ADD CONSTRAINT "RegionBranch_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
