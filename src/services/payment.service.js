/**
 * MyFatoorah payment integration (Apple Pay + cards via the hosted payment page and
 * the native/embedded session flow), resolved PER REGION.
 *
 * Flow:
 *   1. createPaymentInvoice(order, customer) → calls MyFatoorah SendPayment, returns
 *      the hosted page URL (where Apple Pay / card entry happens) + the InvoiceId.
 *   2. verifyPayment(paymentId) → calls MyFatoorah GetPaymentStatus to confirm the
 *      payment server-side. We NEVER trust the browser redirect alone — this is the
 *      authoritative check before marking an order paid.
 *   3. initiateSession() / executePayment() → the native (mobile) AND embedded (web)
 *      Apple Pay flow: the secret key stays on the server; the client only ever holds
 *      a one-time SessionId.
 *
 * PER-REGION GATEWAY (the key design point)
 * -----------------------------------------
 * Instead of one global gateway, each call resolves a "profile" from the order's region
 * code. Every field reads MYFATOORAH_<FIELD>_<CODE> and falls back to the base
 * MYFATOORAH_<FIELD>. So today, with only the base vars set, EVERY region uses the same
 * (UAE) gateway — Saudi orders simply charge in SAR (the currency always comes from the
 * order, never from a fixed global). Later, setting e.g. MYFATOORAH_API_KEY_SA +
 * MYFATOORAH_BASE_URL_SA moves Saudi onto its own dedicated gateway with ZERO code change.
 *
 * Config (env; see .env.example):
 *   MYFATOORAH_API_KEY[_<CODE>]        the account token (kept secret)
 *   MYFATOORAH_BASE_URL[_<CODE>]       which MyFatoorah server (api-ae / api-sa / …)
 *   MYFATOORAH_CALLBACK_URL[_<CODE>]   browser return URL
 *   MYFATOORAH_ERROR_URL[_<CODE>]      browser error URL
 *   MYFATOORAH_WEBHOOK_SECRET[_<CODE>] optional webhook HMAC secret
 */

const DEFAULT_BASE_URL = 'https://apitest.myfatoorah.com';
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.MYFATOORAH_TIMEOUT_MS || '15000', 10));

// Normalize a region code into an env-var suffix: "sa" -> "SA", "ZZ-SA" -> "ZZSA".
function envSuffix(regionCode) {
  return String(regionCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Read a MyFatoorah env field for a region: MYFATOORAH_<FIELD>_<CODE> if set (non-empty),
// else the base MYFATOORAH_<FIELD>. This single rule gives per-region gateways with a
// UAE/base fallback — see the header comment.
function envForRegion(field, regionCode) {
  const base = process.env[`MYFATOORAH_${field}`];
  const suffix = envSuffix(regionCode);
  if (suffix) {
    const scoped = process.env[`MYFATOORAH_${field}_${suffix}`];
    if (scoped != null && String(scoped).trim() !== '') return scoped;
  }
  return base;
}

/**
 * Resolve the gateway profile for a region. `regionCode` is the Region.code the order
 * belongs to (null = the base/default gateway, used by callers that don't know the region
 * yet — e.g. a callback with no region tag — which keeps today's single-gateway behavior).
 *
 * Note: currency is deliberately NOT part of the profile. The charge currency is always the
 * order's own currency (order.currency), so each region charges correctly through whatever
 * gateway it resolves to.
 */
function resolveProfile(regionCode = null) {
  // .trim() every value: a stray trailing space in a Railway env var (esp. BASE_URL — it
  // becomes part of the request host and yields a 502) is otherwise silent and painful.
  return {
    regionCode: regionCode || null,
    apiKey: (envForRegion('API_KEY', regionCode) || '').trim(),
    baseUrl: (envForRegion('BASE_URL', regionCode) || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    callbackUrl: (envForRegion('CALLBACK_URL', regionCode) || '').trim(),
    errorUrl: (envForRegion('ERROR_URL', regionCode) || '').trim(),
    webhookSecret: (envForRegion('WEBHOOK_SECRET', regionCode) || '').trim(),
  };
}

// Startup visibility: which host/key the DEFAULT (base) profile resolved from env. A wrong
// or stale MYFATOORAH_BASE_URL / MYFATOORAH_API_KEY otherwise only surfaces as an opaque
// HTTP 500 from the gateway — this line makes it obvious in the deploy logs. The key is
// shown as a short non-secret prefix only (enough to tell SK_ARE_… from a stale key).
{
  const base = resolveProfile(null);
  console.log(
    `[payment] MyFatoorah default config: baseUrl="${base.baseUrl}" keyPrefix="${base.apiKey.slice(0, 10)}" configured=${Boolean(base.apiKey)}`
  );
}

/**
 * Is online payment configured for this region? A region with no scoped key falls back to
 * the base key, so this is true whenever ANY key is set — the per-region admin toggle
 * (Region.onlinePaymentEnabled) is what decides whether it's OFFERED.
 */
function isConfigured(regionCode = null) {
  return Boolean(resolveProfile(regionCode).apiKey);
}

// Append a region tag to a browser return URL so the callback/webhook can resolve the SAME
// gateway the invoice was created on (needed once a region gets its own server; harmless
// while regions share one). Safe with or without an existing query string.
function appendRegion(url, regionCode) {
  if (!url || !regionCode) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}region=${encodeURIComponent(String(regionCode).toLowerCase())}`;
}

function gatewayError(message, { retryable = false } = {}) {
  const err = new Error(message);
  err.code = 'PAYMENT_GATEWAY_ERROR';
  err.retryable = retryable;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP round-trip to MyFatoorah's JSON API for a resolved `profile`. Throws a tagged
 * Error on network failure, HTTP 5xx, non-JSON, or IsSuccess=false. Network/5xx errors are
 * marked `retryable` so idempotent reads (GetPaymentStatus) can be retried safely.
 */
async function callOnce(profile, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${profile.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // Network failure / timeout — transient, safe to retry on idempotent calls.
    throw gatewayError(`MyFatoorah request failed: ${e.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500) {
    // Log the exact host+path hit — a 5xx from MyFatoorah almost always means a wrong
    // base URL (e.g. api vs api-ae) or a stale key, and this pins down which host was called.
    console.warn(`[payment] MyFatoorah ${res.status} from ${profile.baseUrl}${path} (keyPrefix="${profile.apiKey.slice(0, 10)}")`);
    throw gatewayError(`MyFatoorah returned HTTP ${res.status}`, { retryable: true });
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw gatewayError('MyFatoorah returned a non-JSON response', { retryable: res.status >= 500 });
  }

  // MyFatoorah wraps results as { IsSuccess, Message, ValidationErrors, Data }.
  if (!json || json.IsSuccess !== true) {
    const detail =
      json?.Message ||
      (Array.isArray(json?.ValidationErrors)
        ? json.ValidationErrors.map((v) => v.Error).join('; ')
        : 'Unknown error');
    throw gatewayError(`MyFatoorah error: ${detail}`);
  }

  return json.Data;
}

/**
 * callOnce + optional retry with backoff for transient (retryable) failures.
 * `retries` should be > 0 ONLY for idempotent calls (GetPaymentStatus) — never for
 * SendPayment, where a retried network failure could create a duplicate invoice.
 */
async function callMyFatoorah(profile, path, body, { retries = 0 } = {}) {
  if (!profile.apiKey) {
    const err = new Error('MyFatoorah is not configured (MYFATOORAH_API_KEY missing)');
    err.code = 'PAYMENT_NOT_CONFIGURED';
    throw err;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callOnce(profile, path, body);
    } catch (e) {
      lastErr = e;
      if (!e.retryable || attempt === retries) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Create a payment for an order. Returns { invoiceId, paymentUrl }.
 * paymentUrl is the hosted page — open it in the app/browser; Apple Pay shows on iOS/Safari,
 * card entry everywhere. order.id is passed as CustomerReference so the callback (and
 * GetPaymentStatus) can be tied back to the right order.
 *
 * @param {object} opts.regionCode  the order's Region.code — selects the gateway profile.
 */
async function createPaymentInvoice(order, customer = {}, { regionCode = null } = {}) {
  const profile = resolveProfile(regionCode);

  // MyFatoorah validates CustomerMobile against the account's country, so a number
  // from another country (e.g. a UAE number on the Kuwait sandbox) triggers
  // "Invalid data". The mobile is only metadata here (NotificationOption=LNK means
  // no SMS), so we send it best-effort and retry without it if the gateway rejects.
  const rawMobile = customer.phone || order.shippingPhone || '';
  const mobileDigits = String(rawMobile).replace(/\D/g, '');

  const baseBody = {
    CustomerName: customer.name || order.shippingFullName || 'Customer',
    CustomerEmail: customer.email || undefined,
    InvoiceValue: Number(order.totalAmount),
    // Charge in the order's own region currency (stamped on Order.currency at checkout).
    // Lets each enabled region charge correctly through its resolved gateway.
    DisplayCurrencyIso: order.currency,
    CallBackUrl: appendRegion(profile.callbackUrl, regionCode),
    ErrorUrl: appendRegion(profile.errorUrl || profile.callbackUrl, regionCode),
    CustomerReference: order.id,
    NotificationOption: 'LNK', // return a link instead of sending SMS/email
    Language: 'en',
  };

  let data;
  try {
    data = await callMyFatoorah(profile, '/v2/SendPayment', {
      ...baseBody,
      ...(mobileDigits ? { CustomerMobile: mobileDigits } : {}),
    });
  } catch (e) {
    // Retry once without the mobile — a bad/foreign number must not block payment.
    if (mobileDigits && e.code === 'PAYMENT_GATEWAY_ERROR') {
      console.warn(`[payment] SendPayment rejected with mobile for order ${order.id}; retrying without it`);
      data = await callMyFatoorah(profile, '/v2/SendPayment', baseBody);
    } else {
      throw e;
    }
  }

  return {
    invoiceId: data.InvoiceId != null ? String(data.InvoiceId) : null,
    paymentUrl: data.InvoiceURL,
  };
}

/**
 * Confirm a payment with MyFatoorah (the authoritative server-side check). `key` is
 * the PaymentId from the callback URL, or the InvoiceId from a webhook — `keyType`
 * selects which. Idempotent read, so we retry transient failures. Returns a
 * normalized result the order layer can trust.
 *
 * @param {string|null} regionCode  resolves the gateway to confirm against. Must be the
 *   SAME gateway the invoice was created on — the caller passes it from the region-tagged
 *   callback (?region=…) or from the known order. Null falls back to the base gateway.
 */
async function verifyPayment(key, keyType = 'PaymentId', regionCode = null) {
  const profile = resolveProfile(regionCode);
  const data = await callMyFatoorah(
    profile,
    '/v2/GetPaymentStatus',
    { Key: String(key), KeyType: keyType },
    { retries: 2 }
  );

  const status = data.InvoiceStatus; // 'Paid' | 'Failed' | 'Pending' | 'Expired' | ...
  const txns = Array.isArray(data.InvoiceTransactions) ? data.InvoiceTransactions : [];
  // Prefer the successful transaction's id when present.
  const paidTxn = txns.find((t) => t.TransactionStatus === 'Succss' || t.TransactionStatus === 'Success') || txns[0] || null;

  // The currency `invoiceValue` is expressed in. We requested DisplayCurrencyIso=order.currency
  // at SendPayment, so on a same-currency account this equals our charge currency and
  // invoiceValue is directly comparable to order.totalAmount. On a cross-currency account
  // MyFatoorah may settle/return a different currency — surfaced here so the order layer
  // can avoid an invalid numeric comparison.
  const currency = data.DisplayCurrencyIso || paidTxn?.Currency || paidTxn?.PaidCurrency || null;

  return {
    isPaid: status === 'Paid',
    status,
    invoiceId: data.InvoiceId != null ? String(data.InvoiceId) : null,
    invoiceValue: data.InvoiceValue != null ? Number(data.InvoiceValue) : null,
    currency,
    orderId: data.CustomerReference || null, // we set this to order.id at creation
    transactionId: paidTxn?.TransactionId != null ? String(paidTxn.TransactionId) : null,
  };
}

/**
 * Optional webhook signature check. MyFatoorah signs the webhook body with an
 * account secret (HMAC-SHA256, base64) sent in the `myfatoorah-signature` header.
 * If the region's webhook secret is unset we skip this — the webhook handler still
 * re-verifies every event via GetPaymentStatus, so a forged event can't mark an
 * order paid; the signature is defense-in-depth.
 */
function verifyWebhookSignature(rawBody, signature, regionCode = null) {
  const secret = resolveProfile(regionCode).webhookSecret;
  if (!secret) return true; // not configured → rely on GetPaymentStatus re-verification
  if (!signature) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Native/embedded Apple Pay flow — step 1.
 * Create a payment session on the region's gateway. The SessionId is handed to the client
 * (mobile app OR the web checkout), which attaches the Apple Pay token to it and shows the
 * Apple Pay sheet. Our secret API key never leaves the server. Returns { sessionId, countryCode }.
 *
 * @param {string|null} regionCode  selects the gateway profile (its key determines the
 *   session's country — e.g. a shared UAE key yields an "ARE" session).
 */
async function initiateSession(regionCode = null) {
  const profile = resolveProfile(regionCode);
  // Request-time proof of what we actually send (Apple Pay session diagnosis): the exact
  // URL, the live key's 12-char prefix, and the body. The Apple Pay certificate is bound to
  // a specific MyFatoorah key/merchant, so a valid-but-wrong SK_ARE_ key still creates an
  // "ARE" session yet fails merchant validation. keyPrefix must match the configured key.
  console.log(
    `[payment] InitiateSession -> ${profile.baseUrl}/v2/InitiateSession | region="${regionCode || 'default'}" | keyPrefix="${profile.apiKey.slice(0, 12)}" | body={}`
  );
  const data = await callMyFatoorah(profile, '/v2/InitiateSession', {}, { retries: 1 });
  return {
    sessionId: data.SessionId,
    countryCode: data.CountryCode || null,
  };
}

/**
 * Native/embedded Apple Pay flow — step 2.
 * After the client's SDK has attached the Apple Pay token to the session, the client sends
 * the SessionId back here and we execute the charge server-side (so the key stays on the
 * server). For Apple Pay this settles directly (no redirect). Returns
 * { invoiceId, paymentUrl, isDirectPayment }. The caller then re-verifies with
 * GetPaymentStatus before trusting it as paid.
 *
 * @param {string|null} opts.regionCode  selects the gateway profile.
 */
async function executePayment({ sessionId, order, customer = {}, regionCode = null }) {
  if (!sessionId) {
    const err = new Error('sessionId is required to execute payment');
    err.code = 'PAYMENT_GATEWAY_ERROR';
    throw err;
  }
  const profile = resolveProfile(regionCode);
  const body = {
    SessionId: sessionId,
    InvoiceValue: Number(order.totalAmount),
    DisplayCurrencyIso: order.currency, // order's region currency (see createPaymentInvoice)
    CustomerName: customer.name || order.shippingFullName || 'Customer',
    CustomerReference: order.id, // ties the payment back to our order
    CallBackUrl: appendRegion(profile.callbackUrl, regionCode),
    ErrorUrl: appendRegion(profile.errorUrl || profile.callbackUrl, regionCode),
    ...(customer.email ? { CustomerEmail: customer.email } : {}),
  };
  // Do NOT retry: ExecutePayment is not idempotent (a retry could double-charge).
  const data = await callMyFatoorah(profile, '/v2/ExecutePayment', body);
  return {
    invoiceId: data.InvoiceId != null ? String(data.InvoiceId) : null,
    paymentUrl: data.PaymentURL || null,
    isDirectPayment: data.IsDirectPayment === true,
  };
}

module.exports = {
  isConfigured,
  createPaymentInvoice,
  verifyPayment,
  verifyWebhookSignature,
  initiateSession,
  executePayment,
  // exported for tests / diagnostics
  resolveProfile,
};
