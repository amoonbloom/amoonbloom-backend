const bannerService = require('../services/banner.service');
const { success, error } = require('../utils/response');

/**
 * GET /banners – List all banner images in display order (public, for landing page).
 */
async function getBanners(req, res, next) {
  try {
    const items = await bannerService.getBanners();
    return success(res, items, 'Banners fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /banners – Add one or more banner images (admin). New images appended at end.
 */
async function addBanners(req, res, next) {
  try {
    const { url, urls } = req.body;
    const toAdd = url != null ? [url] : Array.isArray(urls) ? urls : [];
    if (toAdd.length === 0) {
      return error(res, 'Provide either url (string) or urls (array of strings)', 400);
    }
    const invalid = toAdd.filter((u) => !u || typeof u !== 'string' || !u.trim());
    if (invalid.length > 0) {
      return error(res, 'Each URL must be a non-empty string', 400);
    }
    const { count, items } = await bannerService.addBanners(toAdd);
    return success(res, items, count === 1 ? 'Banner added successfully' : `${count} banners added successfully`, 201, { count });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /banners/order – Reorder banners by ID array (admin). Order of array = display order.
 */
async function updateOrder(req, res, next) {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return error(res, 'order must be a non-empty array of banner IDs', 400);
    }
    const items = await bannerService.updateOrder(order);
    return success(res, items, 'Banner order updated successfully', 200, { total: items.length });
  } catch (err) {
    if (err.code === 'P2025') {
      return error(res, 'One or more banner IDs not found', 404);
    }
    next(err);
  }
}

/**
 * DELETE /banners/:id – Remove a banner (admin).
 */
async function deleteBanner(req, res, next) {
  try {
    const { id } = req.params;
    await bannerService.deleteBanner(id);
    const items = await bannerService.getBanners();
    return success(res, items, 'Banner deleted successfully', 200, { total: items.length });
  } catch (err) {
    if (err.code === 'P2025') {
      return error(res, 'Banner not found', 404);
    }
    next(err);
  }
}

module.exports = {
  getBanners,
  addBanners,
  updateOrder,
  deleteBanner,
};
