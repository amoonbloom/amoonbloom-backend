-- Admin-defined display order for categories (storefront home grid + menus).
-- Additive: existing rows default to 0; combined with the createdAt-desc tiebreak
-- in the service layer this preserves the current visual order until an admin
-- drags to reorder. Fast metadata-only ADD COLUMN (has a constant default).
ALTER TABLE "Category" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Index the ordering column (mirrors DeliveryZone/BannerImage.sortOrder).
CREATE INDEX "Category_sortOrder_idx" ON "Category"("sortOrder");
