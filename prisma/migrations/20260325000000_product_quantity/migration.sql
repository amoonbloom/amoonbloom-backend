-- Add quantity to Product for admin stock tracking
ALTER TABLE "Product" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 0;
