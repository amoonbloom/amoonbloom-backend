/**
 * Region write-guarding for the shared, many-to-many catalog entities
 * (Product, Category, Section, BannerImage — each has a `regions` join relation
 * carrying `regionId`).
 *
 * Reads are already scoped for a region-scoped MANAGER via buildVisibilityWhere
 * (overlap: content in ANY of their regions is visible). For WRITES we apply the
 * stricter subset rule so a scoped manager can never mutate another region's data:
 *
 *   - CREATE: the region ids they assign must all be within their scope; if they
 *     assign none, default to their whole scope (never the store default, which
 *     could be a region they don't manage).
 *   - UPDATE / DELETE: allowed only when the entity's CURRENT regions are entirely
 *     within their scope (editing content shared with a foreign region could alter
 *     that region's copy), and any regions they set must also be within scope.
 *
 * ADMIN and all-region managers (allowedRegionIds === null) are never constrained.
 */

const prisma = require('../config/db');
const { allowedRegionIds } = require('./regionScope');
const { error } = require('./response');

const DELEGATES = {
  product: () => prisma.product,
  category: () => prisma.category,
  section: () => prisma.section,
  banner: () => prisma.bannerImage,
};

/** Current region ids of a catalog entity, or null when the row doesn't exist. */
async function entityRegionIds(model, id) {
  const delegate = DELEGATES[model]();
  const row = await delegate.findUnique({
    where: { id },
    select: { regions: { select: { regionId: true } } },
  });
  if (!row) return null;
  return (row.regions || []).map((r) => r.regionId);
}

/**
 * Guard a CREATE. Mutates body.regionIds when a scoped manager omitted them
 * (defaults to their whole scope). Returns true when the request was rejected
 * (response already sent) — caller should `return`.
 */
function guardCreate(res, req, body) {
  const allowed = allowedRegionIds(req);
  if (allowed === null) return false; // admin / all-region manager
  const requested = Array.isArray(body.regionIds) ? body.regionIds : null;
  if (!requested || requested.length === 0) {
    body.regionIds = allowed;
    return false;
  }
  if (requested.some((rid) => !allowed.includes(rid))) {
    error(res, 'You do not have access to one or more selected regions.', 403);
    return true;
  }
  return false;
}

/**
 * Guard an UPDATE or DELETE. Loads the entity's current regions and enforces the
 * subset rule. Returns one of:
 *   { blocked: true }   response already sent (404 hide or 403) — caller returns
 *   { blocked: false }  proceed
 * @param {{ submittedRegionIds?: any }} [opts] regionIds present in an update body
 */
async function guardMutate(res, req, model, id, { submittedRegionIds } = {}) {
  const allowed = allowedRegionIds(req);
  if (allowed === null) return { blocked: false };

  const current = await entityRegionIds(model, id);
  if (current === null) {
    error(res, 'Not found', 404);
    return { blocked: true };
  }
  // Content shared with (or living in) a region outside the manager's scope is
  // read-only to them — hidden as 404 so they can't probe it.
  if (current.some((rid) => !allowed.includes(rid))) {
    error(res, 'Not found', 404);
    return { blocked: true };
  }
  if (submittedRegionIds !== undefined) {
    const requested = Array.isArray(submittedRegionIds) ? submittedRegionIds : [];
    if (requested.some((rid) => !allowed.includes(rid))) {
      error(res, 'You do not have access to one or more selected regions.', 403);
      return { blocked: true };
    }
  }
  return { blocked: false };
}

module.exports = { entityRegionIds, guardCreate, guardMutate };
