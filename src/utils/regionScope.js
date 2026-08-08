/**
 * Region access-control scope for staff (admin / manager) requests.
 *
 * A MANAGER account may be scoped to a set of regions (see the ManagerRegion
 * join table). The single rule enforced across the admin surface:
 *
 *   allowedRegionIds(req) === null   -> caller may access ALL regions
 *   allowedRegionIds(req) === [...]  -> caller may access ONLY these region ids
 *
 * Unrestricted (null) means the caller is an ADMIN, OR a manager with an empty
 * managed-region set (a "super-manager" — still limited by managerPermissions).
 * A manager with a non-empty set is region-scoped and must never see or touch
 * data outside it.
 *
 * These helpers rely on the staff auth middleware having populated
 *   req.isAdmin           (true for ADMIN)
 *   req.managerRegionIds  (string[] of the manager's managed region ids)
 * See middleware/managerAuth.js (verifyAdminOrManager, attachOrderStaffAccess)
 * and middleware/optionalStaff.js (attachStaffIfPresent).
 */

const { error } = require('./response');

// Sentinel region id that can never match a real row — used to force an empty
// result set when a scoped manager requests a region outside their scope,
// instead of silently widening back to "all regions". Mirrors the sentinel in
// user.controller.js / analytics.service.js / visibilityFromReq.js.
const NO_MATCH_REGION_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The set of region ids this caller may access, or null for "unrestricted".
 * @returns {string[]|null}
 */
function allowedRegionIds(req) {
  if (req.isAdmin) return null;
  const ids = req.managerRegionIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return ids;
}

/** True when the caller is a region-scoped manager (non-empty managed set). */
function isRegionScoped(req) {
  return allowedRegionIds(req) !== null;
}

/**
 * May this caller access the given single region id?
 * Unrestricted callers can access anything (including region-less/null rows).
 * A scoped manager can only access ids within their set — never a null region.
 * @param {string|null|undefined} regionId
 */
function isRegionAllowed(req, regionId) {
  const allowed = allowedRegionIds(req);
  if (allowed === null) return true;
  if (!regionId) return false;
  return allowed.includes(regionId);
}

/**
 * Resolve the region filter for a LIST / aggregate query, combining the caller's
 * scope with any region they explicitly asked to filter by (already resolved to
 * an id — pass NO_MATCH_REGION_ID for an unknown code so it narrows to nothing).
 *
 * @param {object} req
 * @param {string|null} requestedRegionId  region id from ?region=, or null
 * @returns {{ regionIds: string[]|null, empty: boolean }}
 *   - regionIds null  => apply NO region filter (unrestricted caller, no explicit ?region)
 *   - regionIds [...] => filter to exactly these ids
 *   - empty true      => caller asked for a region outside their scope => return zero rows
 */
function resolveListRegionFilter(req, requestedRegionId) {
  const allowed = allowedRegionIds(req);
  if (allowed === null) {
    return { regionIds: requestedRegionId ? [requestedRegionId] : null, empty: false };
  }
  if (requestedRegionId) {
    return allowed.includes(requestedRegionId)
      ? { regionIds: [requestedRegionId], empty: false }
      : { regionIds: [], empty: true };
  }
  return { regionIds: allowed, empty: false };
}

/**
 * Filter a caller-supplied list of region ids down to the ones they're allowed
 * to write to. Unrestricted callers get the list back unchanged.
 * @param {string[]} regionIds
 * @returns {{ allowed: string[], rejected: string[] }}
 */
function filterWritableRegionIds(req, regionIds) {
  const allowed = allowedRegionIds(req);
  const list = Array.isArray(regionIds) ? regionIds : [];
  if (allowed === null) return { allowed: list, rejected: [] };
  const allowedSet = new Set(allowed);
  return {
    allowed: list.filter((id) => allowedSet.has(id)),
    rejected: list.filter((id) => !allowedSet.has(id)),
  };
}

/**
 * Guard a WRITE / detail action against a single region. Returns true (and sends
 * the response) when the caller may NOT touch this region; returns false when the
 * action may proceed. Usage:
 *   if (assertRegionAllowed(res, req, row.regionId)) return;
 * @param {{ hideAsNotFound?: boolean }} [opts] when true, 404 instead of 403 so a
 *   scoped manager can't confirm a foreign-region row exists by probing its id.
 */
function assertRegionAllowed(res, req, regionId, { hideAsNotFound = false } = {}) {
  if (isRegionAllowed(req, regionId)) return false;
  if (hideAsNotFound) {
    error(res, 'Not found', 404);
  } else {
    error(res, 'You do not have access to this region.', 403);
  }
  return true;
}

module.exports = {
  NO_MATCH_REGION_ID,
  allowedRegionIds,
  isRegionScoped,
  isRegionAllowed,
  resolveListRegionFilter,
  filterWritableRegionIds,
  assertRegionAllowed,
};
