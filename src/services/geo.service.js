/**
 * Coarse IP → country geolocation for storefront region auto-selection.
 *
 * Country-only (by product decision): we resolve just the visitor's country
 * code and map it to a storefront region; the delivery zone is always chosen by
 * the user. Uses a free HTTPS lookup (ipwho.is — no key) with a short timeout
 * and an in-memory per-IP cache so repeat visits and bursts don't re-hit it.
 *
 * NEVER throws — geolocation is best-effort. On any failure (timeout, private
 * IP, provider down) it returns null and the caller falls back to the default
 * region + the manual picker.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // a visitor's country rarely changes within a day
const CACHE_MAX = 5000;
const LOOKUP_TIMEOUT_MS = 2000;
const cache = new Map(); // ip -> { value: {countryCode, country, city}|null, at }

function getCached(ip) {
  const e = cache.get(ip);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(ip); return undefined; }
  return e.value;
}
function setCached(ip, value) {
  if (cache.size >= CACHE_MAX) {
    // cheap eviction: drop the oldest quarter
    const rows = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < Math.floor(rows.length / 4); i++) cache.delete(rows[i][0]);
  }
  cache.set(ip, { value, at: Date.now() });
}

/** True for loopback / RFC1918 / link-local / unique-local addresses — no point
 *  asking a geo provider about a non-routable address (dev, internal calls). */
function isPrivateOrLocal(ip) {
  if (!ip) return true;
  const a = ip.replace(/^::ffff:/i, ''); // unwrap IPv4-mapped IPv6
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;      // link-local
  if (/^(fc|fd)/i.test(a)) return true;         // unique-local IPv6
  if (/^fe80:/i.test(a)) return true;           // link-local IPv6
  return false;
}

/**
 * Resolve { countryCode, country, city } for an IP, or null when unknown.
 * countryCode is upper-case ISO-3166 alpha-2 (e.g. "SA", "AE").
 */
async function detectCountry(ip) {
  const clean = (ip || '').replace(/^::ffff:/i, '').trim();
  if (isPrivateOrLocal(clean)) return null;

  const cached = getCached(clean);
  if (cached !== undefined) return cached;

  let value = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const res = await fetch(
      `https://ipwho.is/${encodeURIComponent(clean)}?fields=success,country_code,country,city`,
      { signal: controller.signal, headers: { Accept: 'application/json' } }
    );
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.country_code) {
        value = {
          countryCode: String(data.country_code).toUpperCase(),
          country: data.country || null,
          city: data.city || null,
        };
      }
    }
  } catch (_) {
    value = null; // timeout / network / abort — stay silent, fall back
  }
  setCached(clean, value);
  return value;
}

module.exports = { detectCountry, isPrivateOrLocal };
