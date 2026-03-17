/**
 * Sign in with Apple - server-side identity token verification.
 * Verifies JWT using Apple's JWKS; caches keys for performance.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISS = 'https://appleid.apple.com';
const JWKS_CACHE_TTL_MS = 3600 * 1000; // 1 hour
let jwksCache = null;
let jwksCacheExpiry = 0;

/**
 * Fetch Apple's public keys (JWKS). Cached for TTL to reduce network calls.
 * @returns {Promise<Array>} Array of key objects
 */
async function getAppleJWKS() {
  if (jwksCache && Date.now() < jwksCacheExpiry) {
    return jwksCache;
  }
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) {
    throw new Error('Failed to fetch Apple signing keys');
  }
  const { keys } = await response.json();
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('Invalid Apple JWKS response');
  }
  jwksCache = keys;
  jwksCacheExpiry = Date.now() + JWKS_CACHE_TTL_MS;
  return keys;
}

/**
 * Get public key for verification from JWKS by key id.
 * @param {string} kid - Key ID from JWT header
 * @returns {Promise<import('crypto').KeyObject>}
 */
async function getAppleSigningKey(kid) {
  const keys = await getAppleJWKS();
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    throw new Error('Apple signing key not found');
  }
  return crypto.createPublicKey({
    key: jwk,
    format: 'jwk',
  });
}

/**
 * Verify Apple identity token and return payload.
 * Validates: signature, iss, aud, exp. Returns sub (Apple user id), email (optional), email_verified.
 * @param {string} identityToken - JWT from client (Apple Sign In)
 * @param {string} clientId - Your Apple Services ID or Bundle ID (APPLE_CLIENT_ID)
 * @returns {Promise<{ sub: string, email?: string, email_verified?: boolean }>}
 */
async function verifyAppleToken(identityToken, clientId) {
  if (!identityToken || typeof identityToken !== 'string') {
    throw new Error('Identity token is required');
  }
  if (!clientId) {
    throw new Error('Apple client ID is required');
  }

  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new Error('Invalid Apple identity token');
  }

  const key = await getAppleSigningKey(decoded.header.kid);
  const payload = jwt.verify(identityToken, key, {
    algorithms: ['RS256'],
    issuer: APPLE_ISS,
    audience: clientId,
  });

  return {
    sub: payload.sub,
    email: payload.email || null,
    email_verified: payload.email_verified === true,
  };
}

module.exports = {
  getAppleJWKS,
  getAppleSigningKey,
  verifyAppleToken,
};
