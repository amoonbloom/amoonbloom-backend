-- Tabby (Pay in 4) as an additional payment method alongside COD + MyFatoorah.
-- Per-region opt-in toggle; default false until keys are configured for that market.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'TABBY';

-- AlterTable
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "tabbyEnabled" BOOLEAN NOT NULL DEFAULT false;
