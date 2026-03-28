-- Multiple descriptions per product: title (optional), description (required), sortOrder
CREATE TABLE "ProductDescription" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductDescription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductDescription_productId_idx" ON "ProductDescription"("productId");
CREATE INDEX "ProductDescription_productId_sortOrder_idx" ON "ProductDescription"("productId", "sortOrder");

ALTER TABLE "ProductDescription" ADD CONSTRAINT "ProductDescription_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing single description into one row (no title)
INSERT INTO "ProductDescription" ("id", "productId", "title", "description", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, "id", NULL, COALESCE("description", ''), 0, "createdAt"
FROM "Product"
WHERE "description" IS NOT NULL AND "description" != '';

ALTER TABLE "Product" DROP COLUMN IF EXISTS "description";
