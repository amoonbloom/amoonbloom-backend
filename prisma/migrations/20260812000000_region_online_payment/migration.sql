-- AlterTable
-- Per-region toggle for online (card / Apple Pay via MyFatoorah) payment. Opt-in:
-- default false so no region can accidentally offer online payment in a currency the
-- gateway account can't charge. Replaces the old global currency-equality gate; enable
-- per region from the admin (e.g. UAE) once the gateway is confirmed for that currency.
ALTER TABLE "Region" ADD COLUMN     "onlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT false;
