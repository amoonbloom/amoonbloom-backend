-- Add optional user preference and address fields to User
ALTER TABLE "User" ADD COLUMN "preferredLanguage" TEXT;
ALTER TABLE "User" ADD COLUMN "addressCountry" TEXT;
ALTER TABLE "User" ADD COLUMN "addressCity" TEXT;
