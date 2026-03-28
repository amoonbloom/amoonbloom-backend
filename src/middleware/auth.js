const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { error } = require('../utils/response');

/**
 * Verify JWT token middleware. Returns consistent { success: false, message } on auth failure.
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Access denied. No token provided.', 401);
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.userRole = decoded.role;

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return error(res, 'Token expired. Please login again.', 401);
    }
    if (err.name === 'JsonWebTokenError') {
      return error(res, 'Invalid token.', 401);
    }
    next(err);
  }
};

/**
 * Verify admin token middleware. Returns consistent { success: false, message } on failure.
 */
const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Access denied. No token provided.', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true },
    });

    if (!user || user.role !== 'ADMIN') {
      return error(res, 'Access denied. Admin privileges required.', 403);
    }

    req.userId = decoded.id;
    req.user = user;
    req.isAdmin = true;

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return error(res, 'Token expired. Please login again.', 401);
    }
    if (err.name === 'JsonWebTokenError') {
      return error(res, 'Invalid token.', 401);
    }
    next(err);
  }
};

/**
 * Verify instructor or admin middleware. Returns consistent { success: false, message } on failure.
 */
const verifyInstructorOrAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Access denied. No token provided.', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true },
    });

    if (!user) {
      return error(res, 'Access denied. User not found.', 403);
    }

    if (user.role === 'ADMIN') {
      req.userId = decoded.id;
      req.user = user;
      req.isAdmin = true;
      return next();
    }

    if (user.role === 'INSTRUCTOR') {
      req.userId = decoded.id;
      req.user = user;
      req.isInstructor = true;
      return next();
    }

    return error(res, 'Access denied. Instructor or Admin privileges required.', 403);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return error(res, 'Token expired. Please login again.', 401);
    }
    if (err.name === 'JsonWebTokenError') {
      return error(res, 'Invalid token.', 401);
    }
    next(err);
  }
};

module.exports = {
  verifyToken,
  verifyAdmin,
  verifyInstructorOrAdmin,
};
