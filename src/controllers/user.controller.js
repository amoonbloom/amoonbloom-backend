const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const { success, error } = require('../utils/response');
const { invalidateCachedUser } = require('../middleware/auth');

// Sentinel id that can never match a real region row — used so an unknown region
// filter returns an empty set instead of injecting an arbitrary string as a UUID
// filter (which would error or match nothing unpredictably). Mirrors the pattern
// in utils/visibilityFromReq.js and services/analytics.service.js.
const NO_MATCH_REGION_ID = '00000000-0000-0000-0000-000000000000';
const {
  normalizeManagerPermissions,
  MANAGER_PERMISSION_CATALOG,
} = require('../constants/managerPermissions');
const regionService = require('../services/region.service');
const { allowedRegionIds } = require('../utils/regionScope');

// Prisma include that hydrates a manager's access-scope regions for transformUser.
const MANAGED_REGIONS_INCLUDE = {
  managedRegions: { include: { region: { select: { id: true, code: true, name: true, name_ar: true } } } },
};

/**
 * Resolve + authorize the managedRegionIds for a manager being created/edited.
 * - Validates the ids exist.
 * - A region-scoped CALLER (a manager managing managers) may only grant regions
 *   within their own scope, and may NOT create an all-region manager (that would
 *   escalate beyond their own access) — so a non-empty subset is required.
 * Returns { ok:true, ids } or { ok:false, message }.
 */
async function resolveManagedRegionIds(req, input) {
  let ids;
  try {
    ids = await regionService.assertValidRegionIds(Array.isArray(input) ? input : []);
  } catch (e) {
    return { ok: false, message: e.message || 'Invalid region selection' };
  }
  const callerScope = allowedRegionIds(req); // null = admin / all-region manager
  if (callerScope !== null) {
    if (ids.length === 0) {
      return { ok: false, message: 'Select at least one region within your own scope for this manager.' };
    }
    const foreign = ids.filter((id) => !callerScope.includes(id));
    if (foreign.length > 0) {
      return { ok: false, message: 'You can only assign regions within your own scope.' };
    }
  }
  return { ok: true, ids };
}

/**
 * For a region-scoped CALLER, block acting on a user outside their scope. Returns
 * true (and sends 404 to avoid id-probing) when blocked, false to proceed.
 * `target` must have role + regionId, and (for MANAGER targets) managedRegions loaded.
 * ADMIN targets are handled separately by hideAdminFromManager.
 */
function assertUserRegionAccess(req, res, target) {
  const scope = allowedRegionIds(req);
  if (scope === null) return false; // admin / all-region manager
  if (target.role === 'CUSTOMER') {
    if (!scope.includes(target.regionId)) {
      error(res, 'User not found', 404);
      return true;
    }
    return false;
  }
  if (target.role === 'MANAGER') {
    const targetRegions = (target.managedRegions || []).map((mr) => mr.regionId);
    // An all-region manager (empty scope), or one managing any region the caller
    // doesn't, is off-limits — a scoped manager can't touch broader/other access.
    if (targetRegions.length === 0 || targetRegions.some((rid) => !scope.includes(rid))) {
      error(res, 'User not found', 404);
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Row-level authorization for the Users admin section. The route middleware
 * only checks "does this caller hold USERS and/or MANAGERS at all" — it can't
 * know which one is needed until we know the ROLE of the row being touched.
 * This is where that's enforced, plus the one rule that never bends: no
 * manager, no matter which permissions they hold, may ever see, create,
 * modify, or delete an ADMIN account, or set anyone's role to ADMIN. Only an
 * actual admin (req.isAdmin) can touch ADMIN rows or the ADMIN role.
 */
const ADMIN_ROLE = 'ADMIN';
const ROLE_PERMISSION = { CUSTOMER: 'USERS', MANAGER: 'MANAGERS' };

/** Permission key required to touch a user of this role, or null if the role
 *  (ADMIN) is off-limits to every manager regardless of permissions. */
function permissionForRole(role) {
  return ROLE_PERMISSION[role] || null;
}

/** True if the caller (admin or manager) is allowed to act on a row/role. */
function canAccessRole(req, role) {
  if (req.isAdmin) return true;
  const needed = permissionForRole(role);
  if (!needed) return false; // ADMIN — no manager permission ever unlocks this
  return Array.isArray(req.managerPermissions) && req.managerPermissions.includes(needed);
}

/** Roles a manager caller is allowed to see/act on, given their permissions.
 *  Admin callers get null (meaning "unrestricted"). ADMIN is never included. */
function allowedRolesFor(req) {
  if (req.isAdmin) return null;
  const perms = Array.isArray(req.managerPermissions) ? req.managerPermissions : [];
  const roles = [];
  if (perms.includes('USERS')) roles.push('CUSTOMER');
  if (perms.includes('MANAGERS')) roles.push('MANAGER');
  return roles;
}

/** Hides ADMIN rows from a manager as "not found" (rather than 403) so a
 *  manager can't even confirm an admin account exists by probing an id. */
function hideAdminFromManager(req, res, targetRole) {
  if (req.isAdmin) return false;
  if (targetRole === ADMIN_ROLE) {
    error(res, 'User not found', 404);
    return true;
  }
  return false;
}

/**
 * Capitalize first letter, lowercase rest (e.g., "ADMIN" -> "Admin")
 */
const capitalize = (str) => {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

const getAvatarInitials = (displayName) => {
  const parts = (displayName || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0)?.toUpperCase() || '';
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0).toUpperCase() : '';
  return `${first}${last}`;
};

/**
 * Helper to transform user data for frontend
 */
const transformUser = (user) => {
  const displayName = (user.fullName || '').trim();
  return {
    id: user.id,
    name: displayName,
    fullName: displayName || null,
    email: user.email,
    avatar: user.avatar || getAvatarInitials(displayName),
    role: capitalize(user.role) || 'Customer',
    managerTitle: user.role === 'MANAGER' ? user.managerTitle || null : null,
    managerPermissions: user.role === 'MANAGER' ? user.managerPermissions || [] : [],
    // Region access-scope (managers only). Empty array = all regions (super-manager).
    managedRegionIds:
      user.role === 'MANAGER'
        ? (user.managedRegions || []).map((mr) => mr.regionId ?? mr.region?.id).filter(Boolean)
        : [],
    managedRegions:
      user.role === 'MANAGER'
        ? (user.managedRegions || [])
            .map((mr) => mr.region && { id: mr.region.id, code: mr.region.code, name: mr.region.name, name_ar: mr.region.name_ar ?? null })
            .filter(Boolean)
        : [],
    status: capitalize(user.status) || 'Active',
    isEmailVerified: user.isEmailVerified,
    regionId: user.regionId || null,
    region: user.region
      ? { id: user.region.id, code: user.region.code, name: user.region.name, name_ar: user.region.name_ar ?? null }
      : null,
    joinedAt: user.createdAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

/**
 * @desc    Create a new user
 * @route   POST /api/users
 * @access  Admin
 */
const createUser = async (req, res, next) => {
  try {
    const {
      email,
      fullName,
      password,
      role,
      status,
      avatar,
      managerTitle,
      managerPermissions,
    } = req.body;

    const trimmedFullName = (fullName || '').trim();

    if (!email || !trimmedFullName || !password) {
      return error(res, 'Email, full name, and password are required', 400);
    }

    const resolvedRole = (role && String(role).toUpperCase()) || 'CUSTOMER';

    if (resolvedRole === 'ADMIN') {
      return error(res, 'Administrator accounts cannot be created through this API', 403);
    }

    if (!['CUSTOMER', 'MANAGER'].includes(resolvedRole)) {
      return error(res, 'Invalid role. Allowed values: CUSTOMER, MANAGER', 400);
    }

    if (!canAccessRole(req, resolvedRole)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }

    let managerData = {};
    if (resolvedRole === 'MANAGER') {
      const title = managerTitle != null ? String(managerTitle).trim() : '';
      if (!title) {
        return error(res, 'managerTitle is required when creating a manager', 400);
      }
      const norm = normalizeManagerPermissions(managerPermissions);
      if (!norm.ok) {
        return error(res, norm.message, 400);
      }
      // Region access-scope. Empty [] = all regions, but a region-scoped caller may
      // not create an all-region manager (see resolveManagedRegionIds).
      const scope = await resolveManagedRegionIds(req, req.body.managedRegionIds);
      if (!scope.ok) return error(res, scope.message, 400);
      managerData = {
        managerTitle: title,
        managerPermissions: norm.value,
        ...(scope.ids.length > 0
          ? { managedRegions: { create: scope.ids.map((regionId) => ({ regionId })) } }
          : {}),
      };
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        fullName: trimmedFullName,
        password: hashedPassword,
        role: resolvedRole,
        status: status?.toUpperCase() || 'ACTIVE',
        avatar: avatar || null,
        ...managerData,
      },
      include: MANAGED_REGIONS_INCLUDE,
    });

    return success(res, transformUser(user), 'User created successfully', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get all users with pagination, search, and filters
 * @route   GET /api/users
 * @access  Admin
 */
const getAllUsers = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      role,
      status,
      region,
      sortBy = 'createdAt',
      order = 'desc',
    } = req.query;

    // Clamp pagination: default page to 1 when NaN/<1, default limit to 10 when
    // NaN, and cap limit at 100 to avoid unbounded scans. Mirrors product.service.
    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const safeLimit = Math.min(100, Math.max(1, Number.isNaN(parsedLimit) ? 10 : parsedLimit));

    const skip = (safePage - 1) * safeLimit;
    const take = safeLimit;

    // Build where clause
    const where = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Manager callers are scoped to the roles their permissions cover (never
    // ADMIN, regardless of permissions). An explicit ?role= outside that scope
    // is a permission error, not a silent empty result — mirrors requireManagerPermission's 403.
    const allowedRoles = allowedRolesFor(req);
    if (role) {
      const requestedRole = role.toUpperCase();
      if (allowedRoles && !allowedRoles.includes(requestedRole)) {
        return error(res, 'You do not have permission to perform this action.', 403);
      }
      where.role = requestedRole;
    } else if (allowedRoles) {
      where.role = { in: allowedRoles };
    }

    if (status) {
      where.status = status.toUpperCase();
    }

    // Region filter accepts a region code (e.g. UAE) or a region id.
    if (region) {
      const matched = await regionService.getRegionByCode(region);
      where.regionId = matched ? matched.id : NO_MATCH_REGION_ID;
    }

    // Region-scoped managers may only see CUSTOMERS who belong to one of their
    // regions. Manager rows (the staff roster) are matched by role only — they're
    // scoped by managedRegions, not a belonging region. Admins / all-region
    // managers are unaffected (scope === null).
    const scope = allowedRegionIds(req);
    if (scope !== null) {
      where.AND = [
        ...(where.AND || []),
        { OR: [{ role: { not: 'CUSTOMER' } }, { regionId: { in: scope } }] },
      ];
    }

    // Build orderBy
    const validSortFields = ['fullName', 'email', 'createdAt', 'role', 'status'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortOrder },
        include: { region: { select: { id: true, code: true, name: true, name_ar: true } }, ...MANAGED_REGIONS_INCLUDE },
        }),
      prisma.user.count({ where }),
    ]);

    const pagination = {
      page: safePage,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
      hasNext: skip + take < total,
      hasPrev: safePage > 1,
    };
    return success(res, users.map(transformUser), 'Users fetched successfully', 200, { pagination });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get user by ID
 * @route   GET /api/users/:id
 * @access  Admin
 */
const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      include: { region: { select: { id: true, code: true, name: true, name_ar: true } }, ...MANAGED_REGIONS_INCLUDE },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (hideAdminFromManager(req, res, user.role)) return;
    if (!canAccessRole(req, user.role)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }

    // A region-scoped manager may not open a CUSTOMER from outside their region(s) —
    // hidden as 404 (mirrors hideAdminFromManager) so they can't probe by id.
    const scope = allowedRegionIds(req);
    if (scope !== null && user.role === 'CUSTOMER' && !scope.includes(user.regionId)) {
      return error(res, 'User not found', 404);
    }

    return success(res, transformUser(user), 'User fetched successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Update user
 * @route   PUT /api/users/:id
 * @access  Admin
 */
const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      email,
      fullName,
      password,
      role,
      status,
      avatar,
      managerTitle,
      managerPermissions,
    } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { id },
      include: MANAGED_REGIONS_INCLUDE,
    });

    if (!existingUser) {
      return error(res, 'User not found', 404);
    }

    const nextRole = role ? String(role).toUpperCase() : existingUser.role;

    if (role && !['CUSTOMER', 'ADMIN', 'MANAGER'].includes(nextRole)) {
      return error(res, 'Invalid role', 400);
    }

    if (hideAdminFromManager(req, res, existingUser.role)) return;
    if (!canAccessRole(req, existingUser.role)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }
    // Region-scoped callers may only touch users within their scope.
    if (assertUserRegionAccess(req, res, existingUser)) return;
    // Changing role: a manager needs permission over the DESTINATION role too
    // (e.g. USERS alone can't turn a customer into a manager), and can never
    // set anyone's role to ADMIN, regardless of which permissions they hold.
    if (role && nextRole !== existingUser.role && !canAccessRole(req, nextRole)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }

    const updateData = {};

    if (email) updateData.email = email;
    if (fullName !== undefined) {
      const trimmed = String(fullName).trim();
      if (!trimmed) {
        return error(res, 'fullName cannot be empty', 400);
      }
      updateData.fullName = trimmed;
    }
    if (status) updateData.status = status.toUpperCase();
    if (avatar !== undefined) updateData.avatar = avatar;

    // Admin may reassign a user's region by regionId or region code. Empty/null clears it.
    if (req.body.regionId !== undefined || req.body.region !== undefined) {
      const ref = req.body.regionId ?? req.body.region;
      if (!ref) {
        updateData.regionId = null;
      } else {
        const byId = await regionService.getRegionById(String(ref));
        const matched = byId || (await regionService.getRegionByCode(String(ref)));
        if (!matched) return error(res, `Unknown region: ${ref}`, 400);
        updateData.regionId = matched.id;
      }
    }

    if (password) {
      updateData.password = await bcrypt.hash(password, 12);
    }

    if (nextRole === 'MANAGER') {
      const title =
        managerTitle !== undefined
          ? String(managerTitle).trim()
          : (existingUser.managerTitle || '');
      let perms = existingUser.managerPermissions || [];
      if (managerPermissions !== undefined) {
        const norm = normalizeManagerPermissions(managerPermissions);
        if (!norm.ok) {
          return error(res, norm.message, 400);
        }
        perms = norm.value;
      }
      if (!title) {
        return error(res, 'managerTitle is required for managers', 400);
      }
      if (!perms || perms.length === 0) {
        return error(res, 'At least one permission is required for managers', 400);
      }
      updateData.managerTitle = title;
      updateData.managerPermissions = perms;

      // Region access-scope. Replace the manager's regions wholesale when the
      // caller sends managedRegionIds. A region-scoped caller may only assign
      // regions within their own scope and can never leave the manager all-region.
      const callerScoped = allowedRegionIds(req) !== null;
      if (req.body.managedRegionIds !== undefined) {
        const scope = await resolveManagedRegionIds(req, req.body.managedRegionIds);
        if (!scope.ok) return error(res, scope.message, 400);
        updateData.managedRegions = {
          deleteMany: {},
          ...(scope.ids.length ? { create: scope.ids.map((regionId) => ({ regionId })) } : {}),
        };
      } else if (callerScoped && existingUser.role !== 'MANAGER') {
        // Promoting a customer to manager: a scoped caller must scope them explicitly,
        // otherwise the new manager would inherit all-region access (escalation).
        return error(res, 'Select at least one region within your own scope for this manager.', 400);
      }
    } else {
      updateData.managerTitle = null;
      updateData.managerPermissions = [];
      // Leaving the manager role clears the access-scope rows too.
      updateData.managedRegions = { deleteMany: {} };
    }

    if (role) {
      updateData.role = nextRole;
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      include: MANAGED_REGIONS_INCLUDE,
    });

    // Privilege-relevant fields (role/status/managerPermissions) may have changed —
    // drop the cached auth entry so the change takes effect without the 30s TTL.
    invalidateCachedUser(id);

    return success(res, transformUser(user), 'User updated successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Delete user
 * @route   DELETE /api/users/:id
 * @access  Admin
 */
const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      include: MANAGED_REGIONS_INCLUDE,
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (user.role === 'ADMIN') {
      return error(res, 'Admin users cannot be deleted', 403);
    }

    if (!canAccessRole(req, user.role)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }
    if (assertUserRegionAccess(req, res, user)) return;

    await prisma.user.delete({
      where: { id },
    });

    return success(res, null, 'User deleted successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Toggle user status (Active/Inactive)
 * @route   PATCH /api/users/:id/status
 * @access  Admin
 */
const toggleUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const user = await prisma.user.findUnique({
      where: { id },
      include: MANAGED_REGIONS_INCLUDE,
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (hideAdminFromManager(req, res, user.role)) return;
    if (!canAccessRole(req, user.role)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }
    if (assertUserRegionAccess(req, res, user)) return;

    const newStatus = status
      ? status.toUpperCase()
      : user.status === 'ACTIVE'
        ? 'INACTIVE'
        : 'ACTIVE';

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status: newStatus },
    });

    // Status changed — drop the cached auth entry so it takes effect immediately.
    invalidateCachedUser(id);

    return success(res, transformUser(updatedUser), `User ${newStatus.toLowerCase()} successfully`, 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Change user role
 * @route   PATCH /api/users/:id/role
 * @access  Admin
 */
const changeUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role, managerTitle, managerPermissions } = req.body;

    if (!role) {
      return error(res, 'Role is required', 400);
    }

    const upper = String(role).toUpperCase();
    const validRoles = ['CUSTOMER', 'ADMIN', 'MANAGER'];
    if (!validRoles.includes(upper)) {
      return error(res, `Invalid role. Must be one of: ${validRoles.join(', ')}`, 400);
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: MANAGED_REGIONS_INCLUDE,
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (hideAdminFromManager(req, res, user.role)) return;
    if (!canAccessRole(req, user.role)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }
    if (assertUserRegionAccess(req, res, user)) return;
    // Changing role: a manager needs permission over the DESTINATION role too,
    // and can never set anyone's role to ADMIN, regardless of permissions held.
    if (upper !== user.role && !canAccessRole(req, upper)) {
      return error(res, 'You do not have permission to perform this action.', 403);
    }

    let data = { role: upper };

    if (upper === 'MANAGER') {
      const title = managerTitle != null ? String(managerTitle).trim() : '';
      if (!title) {
        return error(res, 'managerTitle is required when assigning the manager role', 400);
      }
      const norm = normalizeManagerPermissions(managerPermissions);
      if (!norm.ok) {
        return error(res, norm.message, 400);
      }
      data.managerTitle = title;
      data.managerPermissions = norm.value;

      // Region access-scope (optional). A scoped caller must scope the manager
      // within their own regions and can never promote to an all-region manager.
      const callerScoped = allowedRegionIds(req) !== null;
      if (req.body.managedRegionIds !== undefined) {
        const scope = await resolveManagedRegionIds(req, req.body.managedRegionIds);
        if (!scope.ok) return error(res, scope.message, 400);
        data.managedRegions = {
          deleteMany: {},
          ...(scope.ids.length ? { create: scope.ids.map((regionId) => ({ regionId })) } : {}),
        };
      } else if (callerScoped && user.role !== 'MANAGER') {
        return error(res, 'Select at least one region within your own scope for this manager.', 400);
      }
    } else {
      data.managerTitle = null;
      data.managerPermissions = [];
      data.managedRegions = { deleteMany: {} };
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data,
      include: MANAGED_REGIONS_INCLUDE,
    });

    // Role/managerPermissions changed — drop the cached auth entry so it takes
    // effect immediately rather than after the 30s TTL.
    invalidateCachedUser(id);

    return success(res, transformUser(updatedUser), `User role changed to ${upper}`, 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get user statistics
 * @route   GET /api/users/stats
 * @access  Admin
 */
const getUserStats = async (req, res, next) => {
  try {
    // Scoped the same way as getAllUsers: a manager only sees counts for the
    // roles their permissions cover. Admin count is never shown to a manager,
    // even one with both USERS and MANAGERS — and total/active/inactive are
    // summed over the visible scope only, so they can't be used to infer the
    // size of the invisible (admin, or other-permission) population.
    const allowedRoles = allowedRolesFor(req);
    const canSeeCustomers = !allowedRoles || allowedRoles.includes('CUSTOMER');
    const canSeeManagers = !allowedRoles || allowedRoles.includes('MANAGER');
    const canSeeAdmins = !!req.isAdmin;

    // Region scope: a region-scoped manager only counts CUSTOMERS in their region(s);
    // manager rows (staff) are counted by role only. Mirrors getAllUsers.
    const regionScope = allowedRegionIds(req);
    const customerRegionWhere = regionScope !== null ? { regionId: { in: regionScope } } : {};
    const scopeWhere = allowedRoles ? { role: { in: allowedRoles } } : {};
    if (regionScope !== null) {
      scopeWhere.AND = [{ OR: [{ role: { not: 'CUSTOMER' } }, { regionId: { in: regionScope } }] }];
    }

    const [totalUsers, customers, admins, managers, activeUsers, inactiveUsers] =
      await Promise.all([
        prisma.user.count({ where: scopeWhere }),
        canSeeCustomers ? prisma.user.count({ where: { role: 'CUSTOMER', ...customerRegionWhere } }) : Promise.resolve(0),
        canSeeAdmins ? prisma.user.count({ where: { role: 'ADMIN' } }) : Promise.resolve(0),
        canSeeManagers ? prisma.user.count({ where: { role: 'MANAGER' } }) : Promise.resolve(0),
        prisma.user.count({ where: { ...scopeWhere, status: 'ACTIVE' } }),
        prisma.user.count({ where: { ...scopeWhere, status: 'INACTIVE' } }),
      ]);

    return success(res, {
      total: totalUsers,
      customers,
      admins,
      managers,
      active: activeUsers,
      inactive: inactiveUsers,
    }, 'Stats fetched successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    List valid manager permission keys for admin UI
 * @route   GET /api/users/manager-permissions
 * @access  Admin
 */
const getManagerPermissionCatalog = async (req, res, next) => {
  try {
    return success(
      res,
      { permissions: [...MANAGER_PERMISSION_CATALOG] },
      'Manager permission catalog fetched successfully',
      200
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  toggleUserStatus,
  changeUserRole,
  getUserStats,
  getManagerPermissionCatalog,
};
