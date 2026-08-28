-- AlterTable: global default storefront language (en | ar)
ALTER TABLE "Settings" ADD COLUMN "defaultLocale" TEXT NOT NULL DEFAULT 'en';
