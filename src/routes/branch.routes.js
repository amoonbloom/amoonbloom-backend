const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const branchController = require('../controllers/branch.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { attachStaffIfPresent } = require('../middleware/optionalStaff');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Branches
 *   description: Per-region physical store branches shown on the storefront Branches page. Public list (active, scoped to ?region=); admin/manager CRUD (REGIONS permission).
 */

const listValidation = [query('region').optional().isString().trim()];

const branchFieldsValidation = [
  body('name_ar').optional({ nullable: true }).isString().trim(),
  body('address').optional({ nullable: true }).isString().trim(),
  body('address_ar').optional({ nullable: true }).isString().trim(),
  body('phone').optional({ nullable: true }).isString().trim().isLength({ max: 40 }),
  body('hours').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
  body('hours_ar').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
  body('note').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('note_ar').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('mapUrl').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
];

const createValidation = [
  body('regionId').isUUID().withMessage('Valid regionId is required'),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  ...branchFieldsValidation,
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid branch ID required'),
  body('regionId').optional().isUUID(),
  body('name').optional().isString().trim().notEmpty(),
  ...branchFieldsValidation,
];

const idParam = [param('id').isUUID().withMessage('Valid branch ID required')];

const reorderValidation = [
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.id').isUUID().withMessage('Each item.id must be a valid branch ID'),
  body('items.*.sortOrder').isInt({ min: 0 }).withMessage('Each item.sortOrder must be a non-negative integer'),
];

router.get('/', publicLimiter, attachStaffIfPresent, listValidation, handleValidationErrors, branchController.listBranches);

router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  createValidation,
  handleValidationErrors,
  branchController.createBranch
);

router.patch(
  '/order',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  reorderValidation,
  handleValidationErrors,
  branchController.reorderBranches
);

router.put(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  updateValidation,
  handleValidationErrors,
  branchController.updateBranch
);

router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  idParam,
  handleValidationErrors,
  branchController.deleteBranch
);

module.exports = router;
