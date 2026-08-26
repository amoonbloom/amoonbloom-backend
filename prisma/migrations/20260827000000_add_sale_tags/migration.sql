-- Sale tags (visual only): per-region on/off on Product + Category, section-level
-- on/off, plus a bilingual custom label per entity (default "Sale" resolved in code).

-- Product: global mirror + bilingual label
ALTER TABLE "Product" ADD COLUMN "onSale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "saleLabel" TEXT;
ALTER TABLE "Product" ADD COLUMN "saleLabel_ar" TEXT;

-- ProductRegion: authoritative per-region on/off
ALTER TABLE "ProductRegion" ADD COLUMN "onSale" BOOLEAN NOT NULL DEFAULT false;

-- Category: global mirror + bilingual label
ALTER TABLE "Category" ADD COLUMN "onSale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Category" ADD COLUMN "saleLabel" TEXT;
ALTER TABLE "Category" ADD COLUMN "saleLabel_ar" TEXT;

-- CategoryRegion: authoritative per-region on/off
ALTER TABLE "CategoryRegion" ADD COLUMN "onSale" BOOLEAN NOT NULL DEFAULT false;

-- Section: on/off + bilingual label (section is already region-scoped by membership)
ALTER TABLE "Section" ADD COLUMN "onSale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Section" ADD COLUMN "saleLabel" TEXT;
ALTER TABLE "Section" ADD COLUMN "saleLabel_ar" TEXT;
