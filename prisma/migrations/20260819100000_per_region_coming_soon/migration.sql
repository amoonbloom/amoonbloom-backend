-- Per-region "coming soon" for products + categories (was a single global flag).

-- AlterTable
ALTER TABLE "ProductRegion" ADD COLUMN "comingSoon" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CategoryRegion" ADD COLUMN "comingSoon" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every EXISTING per-region row inherits the item's current global
-- comingSoon value, so live regions keep their current coming-soon items. New
-- regions (rows created after this) default to false = available.
UPDATE "ProductRegion" pr SET "comingSoon" = true
  FROM "Product" p WHERE pr."productId" = p."id" AND p."comingSoon" = true;
UPDATE "CategoryRegion" cr SET "comingSoon" = true
  FROM "Category" c WHERE cr."categoryId" = c."id" AND c."comingSoon" = true;
