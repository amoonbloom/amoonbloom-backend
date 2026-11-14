const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const wishlistController = require('../controllers/wishlist.controller');
const { optionalAuth, verifyToken } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter, authLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Wishlist
 *   description: |
 *     Server wishlist for **guests** and **signed-in users**.
 *
 *     - **Guest:** send header `X-Guest-Token: <uuid>` (generate once, store on device).
 *     - **Logged in:** send `Authorization: Bearer <token>` (guest token ignored for list/add/remove).
 *     - **On login:** send the same `X-Guest-Token` on signup/signin/Google/Apple **or** call
 *       `POST /wishlist/claim` so guest items merge into the account (union by product+variant).
 *       Guest **orders** already merge by email automatically — same idea for history/tracking.
 */

const addValidation = [
  body('productId').isUUID().withMessage('Valid productId is required'),
  body('selectedOptions').optional({ nullable: true }).isObject().withMessage('selectedOptions must be an object'),
];

const removeBodyValidation = [
  body('variantKey').optional({ nullable: true }).isString(),
  body('selectedOptions').optional({ nullable: true }).isObject(),
];

/**
 * @swagger
 * /wishlist:
 *   get:
 *     summary: Get wishlist (guest or signed-in)
 *     tags: [Wishlist]
 *     parameters:
 *       - in: header
 *         name: X-Guest-Token
 *         schema: { type: string, format: uuid }
 *         description: Required when not authenticated
 *       - in: header
 *         name: X-Region
 *         schema: { type: string }
 *     responses:
 *       200: { description: Wishlist items with product snapshots }
 *       400: { description: Missing guest token when anonymous }
 */
router.get('/', publicLimiter, optionalAuth, wishlistController.list);

/**
 * @swagger
 * /wishlist:
 *   post:
 *     summary: Add a product to the wishlist
 *     tags: [Wishlist]
 *     parameters:
 *       - in: header
 *         name: X-Guest-Token
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId]
 *             properties:
 *               productId: { type: string, format: uuid }
 *               selectedOptions: { type: object, nullable: true }
 *     responses:
 *       201: { description: Added }
 *       200: { description: Already in wishlist }
 *       404: { description: Product not found }
 *       409: { description: Wishlist limit reached }
 */
router.post(
  '/',
  publicLimiter,
  optionalAuth,
  addValidation,
  handleValidationErrors,
  wishlistController.add
);

/**
 * @swagger
 * /wishlist:
 *   delete:
 *     summary: Clear the entire wishlist
 *     tags: [Wishlist]
 *     parameters:
 *       - in: header
 *         name: X-Guest-Token
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Cleared }
 */
router.delete('/', publicLimiter, optionalAuth, wishlistController.clear);

/**
 * @swagger
 * /wishlist/claim:
 *   post:
 *     summary: Claim a guest wishlist into the signed-in account
 *     description: |
 *       Auth required. Pass the device `guestToken` in `X-Guest-Token` or body.
 *       Items are union-merged; guest rows are removed. Also runs automatically on
 *       signup/signin/Google/Apple when the header/body is present.
 *     tags: [Wishlist]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               guestToken: { type: string, format: uuid }
 *     responses:
 *       200: { description: Claimed; returns full user wishlist + claimed/skipped counts }
 *       401: { description: Not authenticated }
 */
router.post('/claim', authLimiter, verifyToken, wishlistController.claim);

/**
 * @swagger
 * /wishlist/{productId}:
 *   delete:
 *     summary: Remove one product (optionally one variant) from the wishlist
 *     tags: [Wishlist]
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: X-Guest-Token
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: variantKey
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               variantKey: { type: string }
 *               selectedOptions: { type: object }
 *     responses:
 *       200: { description: Removed; returns updated wishlist }
 *       404: { description: Item not found }
 */
router.delete(
  '/:productId',
  publicLimiter,
  optionalAuth,
  [param('productId').isUUID().withMessage('Valid productId is required'), query('variantKey').optional().isString()],
  removeBodyValidation,
  handleValidationErrors,
  wishlistController.remove
);

module.exports = router;
