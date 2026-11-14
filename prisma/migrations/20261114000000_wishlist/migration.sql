-- Wishlist: guest (X-Guest-Token) + signed-in user. Claimed into the user account on login.
CREATE TABLE IF NOT EXISTS "WishlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "guestToken" TEXT,
    "productId" TEXT NOT NULL,
    "selectedOptions" JSONB,
    "variantKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WishlistItem_userId_productId_variantKey_key"
  ON "WishlistItem"("userId", "productId", "variantKey");

CREATE UNIQUE INDEX IF NOT EXISTS "WishlistItem_guestToken_productId_variantKey_key"
  ON "WishlistItem"("guestToken", "productId", "variantKey");

CREATE INDEX IF NOT EXISTS "WishlistItem_userId_idx" ON "WishlistItem"("userId");
CREATE INDEX IF NOT EXISTS "WishlistItem_guestToken_idx" ON "WishlistItem"("guestToken");
CREATE INDEX IF NOT EXISTS "WishlistItem_productId_idx" ON "WishlistItem"("productId");

ALTER TABLE "WishlistItem"
  ADD CONSTRAINT "WishlistItem_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WishlistItem"
  ADD CONSTRAINT "WishlistItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
