const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const {
  createUserContact,
  createPublicContact,
  getAllUserContacts,
} = require('../controllers/contact.controller');
const { verifyToken } = require('../middleware/auth');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');
const { authStrictLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   - name: Contact
 *     description: In-app contact / issue submission (authenticated)
 *   - name: Contact Admin
 *     description: Admin / manager view of user-submitted contacts
 */

// ============================================
// AUTHENTICATED USER ROUTE (submit a contact / issue)
// ============================================

/**
 * @swagger
 * /contact/issue:
 *   post:
 *     summary: Submit a contact / issue as a logged-in user
 *     description: |
 *       Requires the user to have a phone number on their profile. If the user's
 *       `phone` is null/empty, the request is rejected with **400** — the app
 *       should ask the user to add their phone via `PATCH /user/profile/phone`
 *       before submitting. The user's name, email and phone are not sent in the
 *       body; they are read from the profile (via `userId` taken from the JWT).
 *     tags: [Contact]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - subject
 *               - message
 *             properties:
 *               subject:
 *                 type: string
 *                 example: "Order missing item"
 *               message:
 *                 type: string
 *                 example: "My package was missing the scarf I ordered."
 *     responses:
 *       201:
 *         description: Contact submitted successfully
 *       400:
 *         description: Missing fields, or user has no phone number on profile
 *       401:
 *         description: Unauthorized
 */
const userContactValidation = [
  body('subject').trim().notEmpty().withMessage('Subject is required'),
  body('message').trim().notEmpty().withMessage('Message is required'),
];
router.post('/issue', verifyToken, userContactValidation, handleValidationErrors, createUserContact);

// ============================================
// PUBLIC CONTACT FORM (guest — no auth)
// ============================================

/**
 * @swagger
 * /contact/public:
 *   post:
 *     summary: Submit the public contact form (guest, no login)
 *     description: Captures name, phone, email and message. Rate-limited per IP.
 *     tags: [Contact]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, phone, email, message]
 *             properties:
 *               name: { type: string, example: "Sara" }
 *               phone: { type: string, example: "+966 5x xxx xxxx" }
 *               email: { type: string, example: "sara@example.com" }
 *               message: { type: string, example: "I'd like a birthday box for Saturday." }
 *     responses:
 *       201: { description: Message sent }
 *       400: { description: Missing/invalid fields }
 *       429: { description: Too many requests }
 */
const publicContactValidation = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('email').trim().isEmail().withMessage('A valid email is required'),
  body('message').trim().notEmpty().withMessage('Message is required'),
];
router.post('/public', authStrictLimiter, publicContactValidation, handleValidationErrors, createPublicContact);

// ============================================
// ADMIN ROUTE
// ============================================

/**
 * @swagger
 * /contact/admin/issues:
 *   get:
 *     summary: List user-submitted contacts with user details
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [NEW, READ, REPLIED, ARCHIVED]
 *     responses:
 *       200:
 *         description: List of user contacts with embedded user details
 */
router.get('/admin/issues', verifyAdminOrManager,
  requireManagerPermission('CONTACT'), getAllUserContacts);

module.exports = router;
