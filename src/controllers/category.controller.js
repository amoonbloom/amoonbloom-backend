const categoryService = require('../services/category.service');
const { success, error } = require('../utils/response');
const { visibilityFromReq } = require('../utils/visibilityFromReq');
const { guardCreate, guardMutate } = require('../utils/catalogRegionGuard');

async function createCategory(req, res, next) {
  try {
    if (guardCreate(res, req, req.body)) return;
    const category = await categoryService.createCategory(req.body);
    return success(res, category, 'Category created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'REGION_NOT_FOUND') return error(res, err.message, 400);
    if (err.code === 'P2002') {
      return error(res, 'Category with this title may already exist', 409);
    }
    next(err);
  }
}

async function updateCategory(req, res, next) {
  try {
    const { id } = req.params;
    if ((await guardMutate(res, req, 'category', id, { submittedRegionIds: req.body.regionIds })).blocked) return;
    const category = await categoryService.updateCategory(id, req.body);
    return success(res, category, 'Category updated successfully');
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'REGION_NOT_FOUND') return error(res, err.message, 400);
    if (err.code === 'P2025') return error(res, 'Category not found', 404);
    if (err.code === 'P2002') return error(res, 'Title already in use', 409);
    next(err);
  }
}

async function deleteCategory(req, res, next) {
  try {
    const { id } = req.params;
    if ((await guardMutate(res, req, 'category', id)).blocked) return;
    await categoryService.deleteCategory(id);
    return success(res, null, 'Category deleted successfully');
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Category not found', 404);
    // CAT-4: keep the existing 400 for "has products", and map the foreign-key restrict
    // violation (a product slipped in during a race) to the SAME clean 400 instead of a
    // generic 500 — so the client behavior is unchanged, just no longer crashes on the race.
    if (err.code === 'CATEGORY_HAS_PRODUCTS' || err.code === 'P2003') {
      return error(res, 'Cannot delete category that has products', 400);
    }
    next(err);
  }
}

async function reorderCategories(req, res, next) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    // Category display order is store-wide (drives the storefront home grid + menus),
    // not per-region, so there's no region tier to scope here — CATEGORIES permission
    // (checked in the route) gates it. Mirrors the banner reorder.
    const result = await categoryService.reorderCategories(items);
    return success(res, null, 'Category order updated successfully', 200, result);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'One or more categories not found', 404);
    next(err);
  }
}

async function getAllCategories(req, res, next) {
  try {
    const visibility = await visibilityFromReq(req);
    const data = await categoryService.getAllCategories(visibility);
    return success(res, data, 'Categories fetched successfully', 200, {
      total: data.length,
    });
  } catch (err) {
    next(err);
  }
}

async function getCategoryById(req, res, next) {
  try {
    const { id } = req.params;
    const visibility = await visibilityFromReq(req);
    const category = await categoryService.getCategoryById(id, true, visibility);
    if (!category) return error(res, 'Category not found', 404);
    return success(res, category, 'Category fetched successfully');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  getAllCategories,
  getCategoryById,
};
