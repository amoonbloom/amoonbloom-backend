-- Optional upper bound for region / zone standard delivery windows.
-- When set (and > min), the storefront/app shows "N to M days"; otherwise "within N days".
ALTER TABLE "Region"
  ADD COLUMN IF NOT EXISTS "standardDeliveryDaysMax" INTEGER;

ALTER TABLE "DeliveryZone"
  ADD COLUMN IF NOT EXISTS "standardLeadDaysMax" INTEGER;
