-- Optional upper bound for standard delivery ETA (region + zone).
-- Null keeps the existing single-number "within N days" copy. When set alongside
-- the min field, the storefront shows "around X to Y days".

ALTER TABLE "Region" ADD COLUMN "standardDeliveryDaysMax" INTEGER;
ALTER TABLE "DeliveryZone" ADD COLUMN "standardLeadDaysMax" INTEGER;
