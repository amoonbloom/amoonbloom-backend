const sectionService = require('../services/section.service');
const { success, error } = require('../utils/response');

/**
 * GET /sections – List all sections for user panel (public). Products and categories in same shape as product/category APIs.
 */
async function getSections(req, res, next) {
  try {
    const data = await sectionService.getSections();
    return success(res, data, 'Sections fetched successfully', 200, { total: data.length });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /sections/:id – Get one section by ID (public).
 */
async function getSectionById(req, res, next) {
  try {
    const { id } = req.params;
    const data = await sectionService.getSectionById(id);
    if (!data) return error(res, 'Section not found', 404);
    return success(res, data, 'Section fetched successfully', 200);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /sections – Create section (admin). Title required; image, productIds, categoryIds optional.
 */
async function createSection(req, res, next) {
  try {
    const data = await sectionService.createSection(req.body);
    return success(res, data, 'Section created successfully', 201);
  } catch (err) {
    if (err.message === 'Section title is required' || err.message === 'Section title cannot be empty') {
      return error(res, err.message, 400);
    }
    if (err.code === 'P2003') return error(res, 'One or more product or category IDs not found', 404);
    next(err);
  }
}

/**
 * PUT /sections/:id – Update section (admin). Can update title, image, sortOrder, and/or set productIds/categoryIds (order = array order).
 */
async function updateSection(req, res, next) {
  try {
    const { id } = req.params;
    const data = await sectionService.updateSection(id, req.body);
    if (!data) return error(res, 'Section not found', 404);
    return success(res, data, 'Section updated successfully', 200);
  } catch (err) {
    if (err.message === 'Section title cannot be empty') {
      return error(res, err.message, 400);
    }
    if (err.code === 'P2025') return error(res, 'Section not found', 404);
    if (err.code === 'P2003') return error(res, 'One or more product or category IDs not found', 404);
    next(err);
  }
}

/**
 * DELETE /sections/:id – Delete section (admin).
 */
async function deleteSection(req, res, next) {
  try {
    const { id } = req.params;
    await sectionService.deleteSection(id);
    return success(res, null, 'Section deleted successfully', 200);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Section not found', 404);
    next(err);
  }
}

module.exports = {
  getSections,
  getSectionById,
  createSection,
  updateSection,
  deleteSection,
};
