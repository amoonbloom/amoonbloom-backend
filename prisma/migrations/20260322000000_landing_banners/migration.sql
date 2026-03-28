-- CreateTable BannerImage for landing page banners (admin-managed, ordered)
CREATE TABLE "BannerImage" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BannerImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BannerImage_sortOrder_idx" ON "BannerImage"("sortOrder");
