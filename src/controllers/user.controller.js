const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const { success, error } = require('../utils/response');

/**
 * Capitalize first letter, lowercase rest (e.g., "ADMIN" -> "Admin")
 */
const capitalize = (str) => {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

/**
 * Helper to generate avatar initials from name
 */
const getAvatarInitials = (firstName, lastName) => {
  const first = firstName?.charAt(0)?.toUpperCase() || '';
  const last = lastName?.charAt(0)?.toUpperCase() || '';
  return `${first}${last}`;
};

/**
 * Helper to transform user data for frontend
 */
const transformUser = (user) => ({
  id: user.id,
  name: `${user.firstName} ${user.lastName}`,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  avatar: user.avatar || getAvatarInitials(user.firstName, user.lastName),
  role: capitalize(user.role) || 'Customer',
  status: capitalize(user.status) || 'Active',
  isEmailVerified: user.isEmailVerified,
  joinedAt: user.createdAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

/**
 * @desc    Create a new user
 * @route   POST /api/users
 * @access  Admin
 */
const createUser = async (req, res, next) => {
  try {
    const { email, firstName, lastName, password, role, status, avatar } = req.body;

    if (!email || !firstName || !lastName || !password) {
      return error(res, 'Email, first name, last name, and password are required', 400);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        password: hashedPassword,
        role: role?.toUpperCase() || 'CUSTOMER',
        status: status?.toUpperCase() || 'ACTIVE',
        avatar: avatar || null,
      },
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
      sortBy = 'createdAt',
      order = 'desc',
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Build where clause
    const where = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.role = role.toUpperCase();
    }

    if (status) {
      where.status = status.toUpperCase();
    }

    // Build orderBy
    const validSortFields = ['firstName', 'lastName', 'email', 'createdAt', 'role', 'status'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortOrder },
        }),
      prisma.user.count({ where }),
    ]);

    const pagination = {
      page: parseInt(page),
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
      hasNext: skip + take < total,
      hasPrev: parseInt(page) > 1,
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
          });

    if (!user) {
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
    const { email, firstName, lastName, password, role, status, avatar } = req.body;

    // Check user exists
    const existingUser = await prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      return error(res, 'User not found', 404);
    }

    const updateData = {};

    if (email) updateData.email = email;
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (role) updateData.role = role.toUpperCase();
    if (status) updateData.status = status.toUpperCase();
    if (avatar !== undefined) updateData.avatar = avatar;

    if (password) {
      updateData.password = await bcrypt.hash(password, 12);
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
    });

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
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

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
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    const newStatus = status
      ? status.toUpperCase()
      : user.status === 'ACTIVE'
        ? 'INACTIVE'
        : 'ACTIVE';

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status: newStatus },
    });

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
    const { role } = req.body;

    if (!role) {
      return error(res, 'Role is required', 400);
    }

    const validRoles = ['CUSTOMER', 'ADMIN'];
    if (!validRoles.includes(role.toUpperCase())) {
      return error(res, 'Invalid role. Must be CUSTOMER or ADMIN', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role: role.toUpperCase() },
    });

    return success(res, transformUser(updatedUser), `User role changed to ${role}`, 200);
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
    const [totalUsers, customers, admins, activeUsers, inactiveUsers] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { role: 'CUSTOMER' } }),
        prisma.user.count({ where: { role: 'ADMIN' } }),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.user.count({ where: { status: 'INACTIVE' } }),
      ]);

    return success(res, {
      total: totalUsers,
      customers,
      admins,
      active: activeUsers,
      inactive: inactiveUsers,
    }, 'Stats fetched successfully', 200);
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
};
