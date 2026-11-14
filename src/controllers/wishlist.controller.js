const wishlistService = require('../services/wishlist.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');

async function regionFromReq(req) {
  return regionService.resolveRegion(req.headers['x-region']);
}

function guestTokenFromReq(req) {
  return (
    req.headers['x-guest-token'] ||
    req.body?.guestToken ||
    req.query?.guestToken ||
    null
  );
}

function ownerFromReq(req) {
  return wishlistService.resolveOwner(req.userId || null, guestTokenFromReq(req));
}

async function list(req, res, next) {
  try {
    const owner = ownerFromReq(req);
    if (owner.error) return error(res, owner.error, 400);
    const region = await regionFromReq(req);
    const data = await wishlistService.listWishlist({
      userId: owner.userId,
      guestToken: owner.guestToken,
      currency: region?.currency || 'AED',
      regionId: region?.id || null,
    });
    return success(res, data, 'Wishlist fetched');
  } catch (err) {
    next(err);
  }
}

async function add(req, res, next) {
  try {
    const owner = ownerFromReq(req);
    if (owner.error) return error(res, owner.error, 400);
    const { productId, selectedOptions } = req.body || {};
    const region = await regionFromReq(req);
    const result = await wishlistService.addToWishlist({
      userId: owner.userId,
      guestToken: owner.guestToken,
      productId,
      selectedOptions,
      regionId: region?.id || null,
    });
    if (result.error) {
      const status =
        result.code === 'WISHLIST_PRODUCT_NOT_FOUND'
          ? 404
          : result.code === 'WISHLIST_LIMIT_REACHED'
            ? 409
            : 400;
      return error(res, result.error, status);
    }
    const data = await wishlistService.listWishlist({
      userId: owner.userId,
      guestToken: owner.guestToken,
      currency: region?.currency || 'AED',
      regionId: region?.id || null,
    });
    return success(
      res,
      data,
      result.alreadyExists ? 'Already in wishlist' : 'Added to wishlist',
      result.alreadyExists ? 200 : 201
    );
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const owner = ownerFromReq(req);
    if (owner.error) return error(res, owner.error, 400);
    const productId = req.params.productId || req.body?.productId;
    const variantKey = req.body?.variantKey ?? req.query?.variantKey;
    const selectedOptions = req.body?.selectedOptions;
    const result = await wishlistService.removeFromWishlist({
      userId: owner.userId,
      guestToken: owner.guestToken,
      productId,
      variantKey,
      selectedOptions,
    });
    if (result.error) return error(res, result.error, 400);
    if (result.removed === 0) return error(res, 'Wishlist item not found', 404);
    const region = await regionFromReq(req);
    const data = await wishlistService.listWishlist({
      userId: owner.userId,
      guestToken: owner.guestToken,
      currency: region?.currency || 'AED',
      regionId: region?.id || null,
    });
    return success(res, data, 'Removed from wishlist');
  } catch (err) {
    next(err);
  }
}

async function clear(req, res, next) {
  try {
    const owner = ownerFromReq(req);
    if (owner.error) return error(res, owner.error, 400);
    const result = await wishlistService.clearWishlist({
      userId: owner.userId,
      guestToken: owner.guestToken,
    });
    if (result.error) return error(res, result.error, 400);
    return success(res, { cleared: result.cleared }, 'Wishlist cleared');
  } catch (err) {
    next(err);
  }
}

/** POST /wishlist/claim — merge a guest token into the signed-in user's wishlist. */
async function claim(req, res, next) {
  try {
    if (!req.userId) return error(res, 'Authentication required', 401);
    const token = guestTokenFromReq(req);
    const result = await wishlistService.claimGuestWishlist(req.userId, token);
    const region = await regionFromReq(req);
    const data = await wishlistService.listWishlist({
      userId: req.userId,
      guestToken: null,
      currency: region?.currency || 'AED',
      regionId: region?.id || null,
    });
    return success(
      res,
      { ...data, claimed: result.claimed, skipped: result.skipped },
      'Guest wishlist claimed'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { list, add, remove, clear, claim };
