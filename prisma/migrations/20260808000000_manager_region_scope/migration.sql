-- CreateTable
CREATE TABLE "ManagerRegion" (
    "userId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagerRegion_pkey" PRIMARY KEY ("userId","regionId")
);

-- CreateIndex
CREATE INDEX "ManagerRegion_regionId_idx" ON "ManagerRegion"("regionId");

-- AddForeignKey
ALTER TABLE "ManagerRegion" ADD CONSTRAINT "ManagerRegion_userId_fkey"   FOREIGN KEY ("userId")   REFERENCES "User"("id")   ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerRegion" ADD CONSTRAINT "ManagerRegion_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: No backfill. Existing MANAGER accounts get zero rows here and are
-- therefore treated as "all regions" (unchanged behavior) until an admin
-- assigns them regions. Only an ADMIN is unconditionally all-region.
