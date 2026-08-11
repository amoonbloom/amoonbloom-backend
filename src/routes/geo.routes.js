const express = require('express');
const router = express.Router();
const geoController = require('../controllers/geo.controller');

/**
 * @swagger
 * tags:
 *   name: Geo
 *   description: Coarse IP geolocation for storefront region auto-selection.
 */

/**
 * @swagger
 * /geo/detect:
 *   get:
 *     summary: Detect the caller's country and matching storefront region
 *     description: >
 *       Country-only, best-effort. Resolves the caller IP to an ISO country and maps it to an
 *       ACTIVE region via Region.iso2. Public, no auth. Always 200; `regionCode` is null when the
 *       country has no configured region (storefront keeps its default and prompts manually).
 *     tags: [Geo]
 *     responses:
 *       200:
 *         description: Detection result
 */
router.get('/detect', geoController.detect);

module.exports = router;
