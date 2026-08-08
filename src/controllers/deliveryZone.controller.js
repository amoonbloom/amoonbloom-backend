const deliveryZoneService = require('../services/deliveryZone.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');
const { resolveListRegionFilter, isRegionAllowed, assertRegionAllowed, allowedRegionIds } = require('../utils/regionScope');

/**
 * GET /delivery-zones – Public list of ACTIVE zones for a region (?region=UAE).
 * Staff (admin/manager) get all zones (including inactive), across all regions
 * if ?region= is omitted.
 */
async function listZones(req, res, next) {
  try {
    let requestedRegionId = null;
    if (req.query.region) {
      const region = await regionService.getRegionByCode(req.query.region);
      if (!region) return success(res, [], 'Delivery zones fetched successfully', 200, { total: 0 });
      requestedRegionId = region.id;
    }
    // Intersect the requested region with the caller's scope: a region-scoped
    // manager only ever sees zones in their region(s).
    const { regionIds } = resolveListRegionFilter(req, requestedRegionId);
    if (Array.isArray(regionIds) && regionIds.length === 0) {
      return success(res, [], 'Delivery zones fetched successfully', 200, { total: 0 });
    }
    const items = await deliveryZoneService.listZones({
      regionId: regionIds ?? undefined,
      includeInactive: !!req.isStaff,
    });
    return success(res, items, 'Delivery zones fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /delivery-zones – Create a zone (admin/manager).
 */
async function createZone(req, res, next) {
  try {
    // A region-scoped manager may only create zones in their own region(s).
    if (assertRegionAllowed(res, req, req.body?.regionId)) return;
    const zone = await deliveryZoneService.createZone(req.body);
    return success(res, zone, 'Delivery zone created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION' || err.code === 'CASH_ARRANGEMENT_INVALID_LIST') return error(res, err.message, 400);
    if (err.code === 'P2002') return error(res, 'A zone with this name already exists in this region', 409);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    next(err);
  }
}

/**
 * POST /delivery-zones/bulk – Create several zones for one region at once
 * (admin/manager). Body: { regionId, zones: [{ name, name_ar?, isActive? }] }.
 * Duplicate names (existing or repeated) are skipped, not failed.
 */
async function createZonesBulk(req, res, next) {
  try {
    const { regionId, zones } = req.body;
    if (assertRegionAllowed(res, req, regionId)) return;
    const result = await deliveryZoneService.createZonesBulk(regionId, zones);
    return success(res, result, 'Delivery zones created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION' || err.code === 'CASH_ARRANGEMENT_INVALID_LIST') return error(res, err.message, 400);
    if (err.code === 'P2002') return error(res, 'A zone with this name already exists in this region', 409);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    next(err);
  }
}

/**
 * PUT /delivery-zones/:id – Update a zone (admin/manager).
 */
async function updateZone(req, res, next) {
  try {
    // Region-scoped managers may only touch zones in their region(s) — check both the
    // zone's CURRENT region and any region it's being moved to.
    const existing = await deliveryZoneService.getZoneById(req.params.id);
    if (!existing) return error(res, 'Delivery zone not found', 404);
    if (assertRegionAllowed(res, req, existing.regionId, { hideAsNotFound: true })) return;
    if (req.body?.regionId !== undefined && assertRegionAllowed(res, req, req.body.regionId)) return;
    const zone = await deliveryZoneService.updateZone(req.params.id, req.body);
    if (!zone) return error(res, 'Delivery zone not found', 404);
    return success(res, zone, 'Delivery zone updated successfully', 200);
  } catch (err) {
    if (err.code === 'VALIDATION' || err.code === 'CASH_ARRANGEMENT_INVALID_LIST') return error(res, err.message, 400);
    if (err.code === 'P2002') return error(res, 'A zone with this name already exists in this region', 409);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    if (err.code === 'P2025') return error(res, 'Delivery zone not found', 404);
    next(err);
  }
}

/**
 * DELETE /delivery-zones/:id – Delete a zone (admin/manager). Frictionless —
 * saved addresses referencing it fall back gracefully (onDelete: SetNull).
 */
async function deleteZone(req, res, next) {
  try {
    const existing = await deliveryZoneService.getZoneById(req.params.id);
    if (!existing) return error(res, 'Delivery zone not found', 404);
    if (assertRegionAllowed(res, req, existing.regionId, { hideAsNotFound: true })) return;
    const zone = await deliveryZoneService.deleteZone(req.params.id);
    if (!zone) return error(res, 'Delivery zone not found', 404);
    return success(res, null, 'Delivery zone deleted successfully', 200);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Delivery zone not found', 404);
    next(err);
  }
}

/**
 * PATCH /delivery-zones/order – Reorder zones (admin/manager).
 * Body: { items: [{ id, sortOrder }] }. sortOrder is per-region, so the client
 * reorders within a single region at a time.
 */
async function reorderZones(req, res, next) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    // Region-scoped managers may only reorder zones within their region(s).
    if (allowedRegionIds(req) !== null) {
      const zones = await Promise.all(
        items.map((it) => deliveryZoneService.getZoneById(it?.id)).filter(Boolean)
      );
      const foreign = zones.some((z) => z && !isRegionAllowed(req, z.regionId));
      if (foreign) return error(res, 'You do not have access to this region.', 403);
    }
    const result = await deliveryZoneService.reorderZones(items);
    return success(res, null, 'Delivery zone order updated successfully', 200, result);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'One or more delivery zones not found', 404);
    next(err);
  }
}

module.exports = { listZones, createZone, createZonesBulk, updateZone, deleteZone, reorderZones };
