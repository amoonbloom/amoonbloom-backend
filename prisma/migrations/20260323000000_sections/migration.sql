-- Sections: admin-created blocks for user panel (e.g. Ramadan Deals) with optional image, products, and categories
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Section_sortOrder_idx" ON "Section"("sortOrder");

CREATE TABLE "SectionProduct" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SectionProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SectionProduct_sectionId_productId_key" ON "SectionProduct"("sectionId", "productId");
CREATE INDEX "SectionProduct_sectionId_idx" ON "SectionProduct"("sectionId");
CREATE INDEX "SectionProduct_productId_idx" ON "SectionProduct"("productId");

CREATE TABLE "SectionCategory" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SectionCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SectionCategory_sectionId_categoryId_key" ON "SectionCategory"("sectionId", "categoryId");
CREATE INDEX "SectionCategory_sectionId_idx" ON "SectionCategory"("sectionId");
CREATE INDEX "SectionCategory_categoryId_idx" ON "SectionCategory"("categoryId");

ALTER TABLE "SectionProduct" ADD CONSTRAINT "SectionProduct_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SectionProduct" ADD CONSTRAINT "SectionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SectionCategory" ADD CONSTRAINT "SectionCategory_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SectionCategory" ADD CONSTRAINT "SectionCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
