-- Section flag: sell curated products even if their category is "coming soon".
ALTER TABLE "Section" ADD COLUMN "releaseComingSoon" BOOLEAN NOT NULL DEFAULT false;
