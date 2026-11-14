-- Per-region gift option enable flags (null = inherit product global).
ALTER TABLE "ProductRegion"
  ADD COLUMN IF NOT EXISTS "giftCardEnabled" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "customNameEnabled" BOOLEAN;
