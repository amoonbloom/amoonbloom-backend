const legalPageService = require('../services/legalPage.service');
const { success, error } = require('../utils/response');
const { assertRegionAllowed } = require('../utils/regionScope');

/**
 * GET /legal-pages/:region/:slug – Public single legal page for the storefront.
 * `:region` is a region CODE (e.g. UAE, SA). Returns 404 when the page isn't
 * published or has no content in either language ("hidden until set").
 */
async function getPublicPage(req, res, next) {
  try {
    const page = await legalPageService.getPublicPage(req.params.region, req.params.slug);
    if (!page) return error(res, 'Page not found', 404);
    return success(res, page, 'Page fetched successfully', 200);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /legal-pages?regionId=<id> – Admin: list all authored pages for a region
 * (any publish state). Region-scoped managers may only read their region(s).
 */
async function listPages(req, res, next) {
  try {
    const regionId = String(req.query.regionId || '').trim();
    if (!regionId) return error(res, 'regionId query param is required', 400);
    if (assertRegionAllowed(res, req, regionId, { hideAsNotFound: true })) return;
    const items = await legalPageService.listForRegion(regionId);
    return success(res, items, 'Legal pages fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /legal-pages/:regionId/:slug – Admin: create/update a page. Content is
 * sanitized in the service. Region-scoped managers may only write their region(s).
 */
async function upsertPage(req, res, next) {
  try {
    const { regionId, slug } = req.params;
    if (assertRegionAllowed(res, req, regionId, { hideAsNotFound: true })) return;
    const page = await legalPageService.upsertPage(regionId, slug, req.body);
    if (!page) return error(res, 'Region not found', 404);
    return success(res, page, 'Legal page saved successfully', 200);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    next(err);
  }
}

/** DELETE /legal-pages/:regionId/:slug – Admin: revert a page to "not set". */
async function deletePage(req, res, next) {
  try {
    const { regionId, slug } = req.params;
    if (assertRegionAllowed(res, req, regionId, { hideAsNotFound: true })) return;
    const result = await legalPageService.deletePage(regionId, slug);
    if (!result) return error(res, 'Page not found', 404);
    return success(res, null, 'Legal page deleted successfully', 200);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Page not found', 404);
    next(err);
  }
}

module.exports = { getPublicPage, listPages, upsertPage, deletePage };
