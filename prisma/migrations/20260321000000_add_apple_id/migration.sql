-- Add Apple Sign In identifier to User
ALTER TABLE "User" ADD COLUMN "appleId" TEXT;
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");
