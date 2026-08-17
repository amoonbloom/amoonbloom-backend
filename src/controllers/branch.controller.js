const branchService = require('../services/branch.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');
const { resolveListRegionFilter, isRegionAllowed, assertRegionAllowed, allowedRegionIds } = require('../utils/regionScope');

/**
 * GET /branches – Public list of ACTIVE branches for a region (?region=UAE).
 * Staff (admin/manager) get all branches (including inactive), across all
 * regions if ?region= is omitted. Mirrors delivery-zones.
 */
async function listBranches(req, res, next) {
  try {
    let requestedRegionId = null;
    if (req.query.region) {
      const region = await regionService.getRegionByCode(req.query.region);
      if (!region) return success(res, [], 'Branches fetched successfully', 200, { total: 0 });
      requestedRegionId = region.id;
    }
    const { regionIds } = resolveListRegionFilter(req, requestedRegionId);
    if (Array.isArray(regionIds) && regionIds.length === 0) {
      return success(res, [], 'Branches fetched successfully', 200, { total: 0 });
    }
    const items = await branchService.listBranches({
      regionId: regionIds ?? undefined,
      includeInactive: !!req.isStaff,
    });
    return success(res, items, 'Branches fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/** POST /branches – Create a branch (admin/manager). */
async function createBranch(req, res, next) {
  try {
    if (assertRegionAllowed(res, req, req.body?.regionId)) return;
    const branch = await branchService.createBranch(req.body);
    return success(res, branch, 'Branch created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    next(err);
  }
}

/** PUT /branches/:id – Update a branch (admin/manager). */
async function updateBranch(req, res, next) {
  try {
    const existing = await branchService.getBranchById(req.params.id);
    if (!existing) return error(res, 'Branch not found', 404);
    if (assertRegionAllowed(res, req, existing.regionId, { hideAsNotFound: true })) return;
    if (req.body?.regionId !== undefined && assertRegionAllowed(res, req, req.body.regionId)) return;
    const branch = await branchService.updateBranch(req.params.id, req.body);
    if (!branch) return error(res, 'Branch not found', 404);
    return success(res, branch, 'Branch updated successfully', 200);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    if (err.code === 'P2025') return error(res, 'Branch not found', 404);
    next(err);
  }
}

/** DELETE /branches/:id – Delete a branch (admin/manager). */
async function deleteBranch(req, res, next) {
  try {
    const existing = await branchService.getBranchById(req.params.id);
    if (!existing) return error(res, 'Branch not found', 404);
    if (assertRegionAllowed(res, req, existing.regionId, { hideAsNotFound: true })) return;
    const branch = await branchService.deleteBranch(req.params.id);
    if (!branch) return error(res, 'Branch not found', 404);
    return success(res, null, 'Branch deleted successfully', 200);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Branch not found', 404);
    next(err);
  }
}

/** PATCH /branches/order – Reorder branches (admin/manager). */
async function reorderBranches(req, res, next) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (allowedRegionIds(req) !== null) {
      const branches = (await Promise.all(items.map((it) => branchService.getBranchById(it?.id)))).filter(Boolean);
      const foreign = branches.some((b) => b && !isRegionAllowed(req, b.regionId));
      if (foreign) return error(res, 'You do not have access to this region.', 403);
    }
    const result = await branchService.reorderBranches(items);
    return success(res, null, 'Branch order updated successfully', 200, result);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'One or more branches not found', 404);
    next(err);
  }
}

module.exports = { listBranches, createBranch, updateBranch, deleteBranch, reorderBranches };
