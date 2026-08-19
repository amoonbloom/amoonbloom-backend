-- AlterTable
-- Per-region toggles for WHICH online methods are offered when onlinePaymentEnabled is on.
-- Set independently from the admin panel. Default true so enabling online payment offers
-- both card + Apple Pay (existing enabled regions keep their current behavior). Apple Pay is
-- enforced server-side on the session endpoints; both also drive the storefront's options.
ALTER TABLE "Region" ADD COLUMN     "applePayEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Region" ADD COLUMN     "cardPaymentEnabled" BOOLEAN NOT NULL DEFAULT true;
