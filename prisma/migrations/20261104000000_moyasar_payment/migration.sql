-- Moyasar card gateway for KSA: provider per region + MOYASAR payment method.
-- Idempotent: safe if a prior partial apply already created the type/column/enum value.

DO $$ BEGIN
  CREATE TYPE "OnlinePaymentProvider" AS ENUM ('MYFATOORAH', 'MOYASAR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Region"
  ADD COLUMN IF NOT EXISTS "onlinePaymentProvider" "OnlinePaymentProvider" NOT NULL DEFAULT 'MYFATOORAH';

DO $$ BEGIN
  ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'MOYASAR';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
