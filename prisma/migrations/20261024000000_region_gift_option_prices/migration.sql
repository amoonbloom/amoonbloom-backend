-- Per-region overrides for gift-card / custom-name add-on prices.
-- Null = fall back to Product.giftCardExtraPrice / Product.customNamePrice.

ALTER TABLE "ProductRegion" ADD COLUMN IF NOT EXISTS "giftCardExtraPrice" DECIMAL(10,2);
ALTER TABLE "ProductRegion" ADD COLUMN IF NOT EXISTS "customNamePrice" DECIMAL(10,2);
