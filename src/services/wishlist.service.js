/**
 * Wishlist — signed-in users (userId) and guests (guestToken via X-Guest-Token).
 * On login the guest list is claimed into the account (union by productId+variantKey),
 * mirroring how guest orders are linked by email.
 */
const prisma = require('../config/db');
const productService = require('./product.service');
const { variantKeyOf } = require('../utils/variantKey');

const MAX_WISHLIST_ITEMS = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeGuestToken(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t || !UUID_RE.test(t)) return null;
  return t;
}

function ownerWhere({ userId, guestToken }) {
  if (userId) return { userId };
  if (guestToken) return { guestToken };
  return null;
}

function productIncludeForRegion(regionId) {
  return {
    images: { orderBy: { sortOrder: 'asc' } },
    category: {
      select: {
        id: true,
        title: true,
        title_ar: true,
        comingSoon: true,
        onSale: true,
        saleLabel: true,
        saleLabel_ar: true,
        giftCardMode: true,
        deliveryLeadDays: true,
        ...(regionId
          ? { regions: { where: { regionId }, select: { comingSoon: true, onSale: true } } }
          : {}),
      },
    },
    ...(regionId
      ? {
          regions: {
            where: { regionId },
            select: {
              regionId: true,
              price: true,
              discountedPrice: true,
              giftCardExtraPrice: true,
              customNamePrice: true,
              comingSoon: true,
              onSale: true,
            },
          },
        }
      : {}),
  };
}

async function mapWishlistRows(rows, currency, regionId) {
  const items = [];
  for (const row of rows) {
    if (!row.product || row.product.status !== 'PUBLISHED') continue;
    const mapped = productService.applyRegionCurrency(productService.mapProduct(row.product));
    items.push({
      id: row.id,
      productId: row.productId,
      selectedOptions: row.selectedOptions ?? null,
      variantKey: row.variantKey ?? '',
      createdAt: row.createdAt,
      product: mapped,
    });
  }
  await productService.attachResolvedDeliveryLeadDays(
    items.map((i) => i.product),
    regionId
  );
  return {
    items,
    totalItems: items.length,
    currency: currency || 'AED',
  };
}

/**
 * Resolve the owner for a wishlist call.
 * Logged-in wins over guest token (token is only used for claim).
 */
function resolveOwner(userId, guestTokenRaw) {
  if (userId) return { userId, guestToken: null, error: null };
  const guestToken = normalizeGuestToken(guestTokenRaw);
  if (!guestToken) {
    return {
      userId: null,
      guestToken: null,
      error: 'Guest wishlist requires X-Guest-Token (a UUID stored on the device)',
    };
  }
  return { userId: null, guestToken, error: null };
}

async function listWishlist({ userId, guestToken, currency = 'AED', regionId = null }) {
  const where = ownerWhere({ userId, guestToken });
  if (!where) return { items: [], totalItems: 0, currency };

  const rows = await prisma.wishlistItem.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      product: { include: productIncludeForRegion(regionId) },
    },
  });
  return mapWishlistRows(rows, currency, regionId);
}

async function addToWishlist({ userId, guestToken, productId, selectedOptions, regionId = null }) {
  const where = ownerWhere({ userId, guestToken });
  if (!where) return { error: 'Wishlist owner required', code: 'WISHLIST_OWNER_REQUIRED' };

  const product = await prisma.product.findFirst({
    where: { id: productId, status: 'PUBLISHED' },
    select: { id: true },
  });
  if (!product) return { error: 'Product not found', code: 'WISHLIST_PRODUCT_NOT_FOUND' };

  const variantKey = variantKeyOf(selectedOptions);
  const existing = await prisma.wishlistItem.findFirst({
    where: { ...where, productId, variantKey },
    select: { id: true },
  });
  if (existing) {
    return { alreadyExists: true, error: null };
  }

  const count = await prisma.wishlistItem.count({ where });
  if (count >= MAX_WISHLIST_ITEMS) {
    return {
      error: `You can save up to ${MAX_WISHLIST_ITEMS} wishlist items`,
      code: 'WISHLIST_LIMIT_REACHED',
    };
  }

  await prisma.wishlistItem.create({
    data: {
      userId: userId || null,
      guestToken: userId ? null : guestToken,
      productId,
      selectedOptions:
        selectedOptions && typeof selectedOptions === 'object' && Object.keys(selectedOptions).length > 0
          ? selectedOptions
          : undefined,
      variantKey,
    },
  });
  return { alreadyExists: false, error: null };
}

async function removeFromWishlist({ userId, guestToken, productId, variantKey, selectedOptions }) {
  const where = ownerWhere({ userId, guestToken });
  if (!where) return { removed: 0, error: 'Wishlist owner required', code: 'WISHLIST_OWNER_REQUIRED' };

  const vk =
    typeof variantKey === 'string'
      ? variantKey
      : selectedOptions !== undefined
        ? variantKeyOf(selectedOptions)
        : undefined;

  const result = await prisma.wishlistItem.deleteMany({
    where: {
      ...where,
      productId,
      ...(vk !== undefined ? { variantKey: vk } : {}),
    },
  });
  return { removed: result.count, error: null };
}

async function clearWishlist({ userId, guestToken }) {
  const where = ownerWhere({ userId, guestToken });
  if (!where) return { cleared: 0, error: 'Wishlist owner required', code: 'WISHLIST_OWNER_REQUIRED' };
  const result = await prisma.wishlistItem.deleteMany({ where });
  return { cleared: result.count, error: null };
}

/**
 * Move all guestToken wishlist rows onto userId (union). Idempotent.
 * Called from signup / signin / OAuth and POST /wishlist/claim.
 */
async function claimGuestWishlist(userId, guestTokenRaw) {
  if (!userId) return { claimed: 0, skipped: 0 };
  const guestToken = normalizeGuestToken(guestTokenRaw);
  if (!guestToken) return { claimed: 0, skipped: 0 };

  const guestItems = await prisma.wishlistItem.findMany({
    where: { guestToken, userId: null },
    select: {
      id: true,
      productId: true,
      selectedOptions: true,
      variantKey: true,
    },
  });
  if (guestItems.length === 0) return { claimed: 0, skipped: 0 };

  let claimed = 0;
  let skipped = 0;

  await prisma.$transaction(async (tx) => {
    const userCount = await tx.wishlistItem.count({ where: { userId } });
    let room = Math.max(0, MAX_WISHLIST_ITEMS - userCount);

    for (const item of guestItems) {
      const exists = await tx.wishlistItem.findFirst({
        where: {
          userId,
          productId: item.productId,
          variantKey: item.variantKey,
        },
        select: { id: true },
      });
      if (exists) {
        skipped += 1;
        await tx.wishlistItem.delete({ where: { id: item.id } });
        continue;
      }
      if (room <= 0) {
        // Drop excess guest items after claim so the guest token is fully cleared.
        await tx.wishlistItem.delete({ where: { id: item.id } });
        skipped += 1;
        continue;
      }
      await tx.wishlistItem.update({
        where: { id: item.id },
        data: { userId, guestToken: null },
      });
      claimed += 1;
      room -= 1;
    }
  });

  return { claimed, skipped };
}

module.exports = {
  MAX_WISHLIST_ITEMS,
  normalizeGuestToken,
  resolveOwner,
  listWishlist,
  addToWishlist,
  removeFromWishlist,
  clearWishlist,
  claimGuestWishlist,
};
