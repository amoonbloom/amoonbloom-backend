-- Public (guest) contact-form submissions: userId nullable + guest detail fields.
ALTER TABLE "UserContact" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "UserContact" ADD COLUMN IF NOT EXISTS "guestName" TEXT;
ALTER TABLE "UserContact" ADD COLUMN IF NOT EXISTS "guestPhone" TEXT;
ALTER TABLE "UserContact" ADD COLUMN IF NOT EXISTS "guestEmail" TEXT;
