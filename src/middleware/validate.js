const { validationResult } = require('express-validator');
const { error } = require('../utils/response');

/**
 * Middleware that returns 400 with validation errors if any.
 * Format: { success: false, message: 'Validation failed', errors: [{ field, message }] }
 */
function handleValidationErrors(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const errors = result.array().map((e) => ({ field: e.path, message: e.msg }));
    return error(res, 'Validation failed', 400, errors);
  }
  next();
}

module.exports = { handleValidationErrors };
