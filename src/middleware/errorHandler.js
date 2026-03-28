const { error } = require('../utils/response');

/**
 * Global error handler. Logs errors and returns consistent JSON.
 * Format: { success: false, message, errors? }
 * Prisma P2002 → 409, P2025 → 404; preserves status and errors array.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  if (err.code === 'P2002') {
    return error(res, 'A record with this value already exists', 409);
  }

  if (err.code === 'P2025') {
    return error(res, 'Record not found', 404);
  }

  if (!isProd) {
    console.error('[ERROR]', err.stack || err.message);
  } else if (status >= 500) {
    console.error('[ERROR]', err.message);
  }

  return error(res, err.message || 'Internal Server Error', status, err.errors);
}

module.exports = errorHandler;
