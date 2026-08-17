/**
 * Per-region physical branches shown on the storefront Branches page (EN + AR).
 * Replaces the old hardcoded UAE-only branch list — any region can now have its
 * own branches with their own opening/closing hours. A region with no active
 * branches shows the storefront's delivery-only card instead. Mirrors the shape
 * of deliveryZone.service.js (per-region CRUD + reorder), minus delivery config.
 */
const prisma = require('../config/db');
const regionService = require('./region.service');

const BRANCH_SELECT = {
  id: true,
  regionId: true,
  name: true,
  name_ar: true,
  address: true,
  address_ar: true,
  phone: true,
  hours: true,
  hours_ar: true,
  note: true,
  note_ar: true,
  mapUrl: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
};

function trimOrNull(value) {
  return value != null ? String(value).trim() || null : null;
}

/** Build the writable branch payload. `partial` (update) only sets sent keys. */
function buildBranchPayload(data, { partial = false } = {}) {
  const payload = {};
  const set = (key, present, value) => {
    if (!partial || present) payload[key] = value;
  };
  set('name_ar', data.name_ar !== undefined, trimOrNull(data.name_ar));
  set('address', data.address !== undefined, trimOrNull(data.address));
  set('address_ar', data.address_ar !== undefined, trimOrNull(data.address_ar));
  set('phone', data.phone !== undefined, trimOrNull(data.phone));
  set('hours', data.hours !== undefined, trimOrNull(data.hours));
  set('hours_ar', data.hours_ar !== undefined, trimOrNull(data.hours_ar));
  set('note', data.note !== undefined, trimOrNull(data.note));
  set('note_ar', data.note_ar !== undefined, trimOrNull(data.note_ar));
  set('mapUrl', data.mapUrl !== undefined, trimOrNull(data.mapUrl));
  return payload;
}

// ---- Public (storefront) ----

/** Active branches for the region behind `regionCode`, ordered for display. */
async function listPublicBranches(regionCode) {
  const region = await regionService.resolveRegion(regionCode);
  if (!region) return [];
  return prisma.regionBranch.findMany({
    where: { regionId: region.id, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: BRANCH_SELECT,
  });
}

// ---- Admin CRUD ----

async function getBranchById(id) {
  if (!id) return null;
  return prisma.regionBranch.findUnique({ where: { id }, select: BRANCH_SELECT });
}

async function listBranches({ regionId, includeInactive = true } = {}) {
  const regionWhere =
    regionId == null ? {} : { regionId: Array.isArray(regionId) ? { in: regionId } : regionId };
  return prisma.regionBranch.findMany({
    where: { ...regionWhere, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: [{ regionId: 'asc' }, { sortOrder: 'asc' }],
    select: BRANCH_SELECT,
  });
}

/** Next sortOrder for a region = one past its current max (new branches append). */
async function nextSortOrder(regionId, client = prisma) {
  const agg = await client.regionBranch.aggregate({
    where: { regionId },
    _max: { sortOrder: true },
  });
  return (agg._max.sortOrder ?? -1) + 1;
}

async function createBranch(data) {
  const regionId = String(data.regionId ?? '').trim();
  if (!regionId) throw Object.assign(new Error('regionId is required'), { code: 'VALIDATION' });
  const name = String(data.name ?? '').trim();
  if (!name) throw Object.assign(new Error('Branch name is required'), { code: 'VALIDATION' });

  return prisma.regionBranch.create({
    data: {
      regionId,
      name,
      isActive: data.isActive === undefined ? true : !!data.isActive,
      sortOrder: data.sortOrder != null ? Number(data.sortOrder) : await nextSortOrder(regionId),
      ...buildBranchPayload(data, { partial: false }),
    },
    select: BRANCH_SELECT,
  });
}

async function updateBranch(id, data) {
  const existing = await prisma.regionBranch.findUnique({ where: { id } });
  if (!existing) return null;

  const payload = {};
  if (data.regionId !== undefined) {
    const regionId = String(data.regionId ?? '').trim();
    if (!regionId) throw Object.assign(new Error('regionId cannot be empty'), { code: 'VALIDATION' });
    payload.regionId = regionId;
  }
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw Object.assign(new Error('Branch name cannot be empty'), { code: 'VALIDATION' });
    payload.name = name;
  }
  if (data.isActive !== undefined) payload.isActive = !!data.isActive;
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder);
  Object.assign(payload, buildBranchPayload(data, { partial: true }));

  return prisma.regionBranch.update({ where: { id }, data: payload, select: BRANCH_SELECT });
}

async function deleteBranch(id) {
  const branch = await prisma.regionBranch.findUnique({ where: { id } });
  if (!branch) return null;
  await prisma.regionBranch.delete({ where: { id } });
  return branch;
}

/** Reorder branches (admin drag-and-drop) — writes each id's sortOrder. */
async function reorderBranches(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };
  await prisma.$transaction(
    clean.map((it) => prisma.regionBranch.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } }))
  );
  return { count: clean.length };
}

module.exports = {
  listPublicBranches,
  getBranchById,
  listBranches,
  createBranch,
  updateBranch,
  deleteBranch,
  reorderBranches,
};
