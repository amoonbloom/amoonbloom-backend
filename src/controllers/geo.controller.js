const geoService = require('../services/geo.service');
const regionService = require('../services/region.service');
const { success } = require('../utils/response');

/** Left-most client IP. `trust proxy` is set (server.js), so req.ip already
 *  resolves the real caller behind Railway's edge; fall back to X-Forwarded-For. */
function clientIp(req) {
  let ip = req.ip || '';
  if (!ip && req.headers['x-forwarded-for']) {
    ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return (ip || '').replace(/^::ffff:/i, '').trim();
}

/**
 * GET /geo/detect
 * Best-effort region hint from the caller's IP country. Country-only: maps the
 * detected ISO country to an ACTIVE region via `Region.iso2`. The delivery zone
 * is always picked by the user. Always 200 — a null regionCode just means the
 * storefront keeps its default region and opens the manual picker.
 */
async function detect(req, res, next) {
  try {
    const geo = await geoService.detectCountry(clientIp(req));
    if (!geo) {
      return success(res, { detected: false, countryCode: null, regionCode: null, isSupported: false }, 'No geolocation');
    }
    const regions = await regionService.listRegions({ includeInactive: false });
    const region = regions.find((r) => (r.iso2 || '').toUpperCase() === geo.countryCode) || null;
    return success(res, {
      detected: true,
      countryCode: geo.countryCode,
      country: geo.country,
      city: geo.city,
      regionCode: region ? region.code : null,
      isSupported: !!region,
    }, 'Geolocation resolved');
  } catch (err) {
    next(err);
  }
}

module.exports = { detect };
