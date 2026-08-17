const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const legalPageController = require('../controllers/legalPage.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: LegalPages
 *   description: Per-region, admin-authored legal pages (terms, privacy, refund-policy, shipping-policy, product-disclaimer). Public single-page read; admin/manager list/upsert/delete (REGIONS permission).
 */

const MAX_CONTENT = 300000; // generous cap for rich-text HTML; express.json limit is 10mb.

const upsertValidation = [
  param('regionId').isUUID().withMessage('Valid regionId required'),
  param('slug').isString().trim().notEmpty().withMessage('slug required'),
  body('title').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
  body('title_ar').optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
  body('content').optional({ nullable: true }).isString().isLength({ max: MAX_CONTENT }),
  body('content_ar').optional({ nullable: true }).isString().isLength({ max: MAX_CONTENT }),
  body('isPublished').optional().isBoolean(),
];

const modifyParams = [
  param('regionId').isUUID().withMessage('Valid regionId required'),
  param('slug').isString().trim().notEmpty().withMessage('slug required'),
];

/**
 * @swagger
 * /legal-pages/{region}/{slug}:
 *   get:
 *     summary: Get a published legal page (public)
 *     description: "`region` is a region CODE (e.g. UAE, SA); `slug` is one of terms, privacy, refund-policy, shipping-policy, product-disclaimer. 404 when the page isn't published or has no content."
 *     tags: [LegalPages]
 *     responses:
 *       200: { description: Page content (both languages) }
 *       404: { description: Page not set for this region }
 */
router.get('/:region/:slug', publicLimiter, legalPageController.getPublicPage);

/**
 * @swagger
 * /legal-pages:
 *   get:
 *     summary: List a region's authored legal pages (admin/manager)
 *     tags: [LegalPages]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: regionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Legal pages list }
 */
router.get(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  [query('regionId').isUUID().withMessage('Valid regionId query param required')],
  handleValidationErrors,
  legalPageController.listPages
);

/**
 * @swagger
 * /legal-pages/{regionId}/{slug}:
 *   put:
 *     summary: Create/update a legal page (admin/manager)
 *     tags: [LegalPages]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Page saved }
 *       404: { description: Region not found }
 */
router.put(
  '/:regionId/:slug',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  upsertValidation,
  handleValidationErrors,
  legalPageController.upsertPage
);

/**
 * @swagger
 * /legal-pages/{regionId}/{slug}:
 *   delete:
 *     summary: Delete a legal page — reverts to "not set" (admin/manager)
 *     tags: [LegalPages]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Page deleted }
 *       404: { description: Page not found }
 */
router.delete(
  '/:regionId/:slug',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  modifyParams,
  handleValidationErrors,
  legalPageController.deletePage
);

module.exports = router;
