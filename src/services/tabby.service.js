/**
 * Tabby Pay-in-4 (BNPL) integration — hosted checkout redirect.
 *
 * Flow:
 *   1. createCheckoutSession(order, …) → POST /api/v2/checkout
 *      → { paymentId, webUrl }  (redirect customer to webUrl)
 *   2. getPayment(paymentId) → GET /api/v2/payments/{id}  (authoritative status)
 *   3. capturePayment(paymentId, { amount, referenceId }) when status is AUTHORIZED
 *      → payment becomes CLOSED; only then settle the order as PAID
 *
 * Never trust the browser redirect alone. Webhooks + reconcile re-verify via getPayment.
 *
 * Env (see .env.example):
 *   TABBY_SECRET_KEY          sk_test_… / sk_…  (server only)
 *   TABBY_PUBLIC_KEY          pk_test_… / pk_…  (optional; promo snippets later)
 *   TABBY_MERCHANT_CODE       e.g. AmoonBloom
 *   TABBY_BASE_URL            default https://api.tabby.ai  (KSA: https://api.tabby.sa)
 *   TABBY_SUCCESS_URL         …/orders/payment/tabby/callback
 *   TABBY_CANCEL_URL          …/orders/payment/tabby/cancel
 *   TABBY_FAILURE_URL         …/orders/payment/tabby/failure
 *   TABBY_WEBHOOK_SECRET      value registered as webhook header (X-Tabby-Auth)
 */

const DEFAULT_BASE_URL = 'https://api.tabby.ai';
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.TABBY_TIMEOUT_MS || '15000', 10));

function config() {
  return {
    secretKey: (process.env.TABBY_SECRET_KEY || '').trim(),
    publicKey: (process.env.TABBY_PUBLIC_KEY || '').trim(),
    merchantCode: (process.env.TABBY_MERCHANT_CODE || 'AmoonBloom').trim(),
    baseUrl: (process.env.TABBY_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    successUrl: (process.env.TABBY_SUCCESS_URL || '').trim(),
    cancelUrl: (process.env.TABBY_CANCEL_URL || process.env.TABBY_FAILURE_URL || '').trim(),
    failureUrl: (process.env.TABBY_FAILURE_URL || process.env.TABBY_CANCEL_URL || '').trim(),
    webhookSecret: (process.env.TABBY_WEBHOOK_SECRET || '').trim(),
  };
}

function isConfigured() {
  return Boolean(config().secretKey && config().merchantCode);
}

/** Currencies this Tabby merchant account accepts (comma-separated env). Default SAR —
 *  the KSA sandbox/live keys from Tabby onboarding reject AED. Override e.g. TABBY_CURRENCIES=SAR,AED
 *  once Tabby issues multi-currency / UAE keys. Empty/unset still defaults to SAR for safety. */
function supportedCurrencies() {
  const raw = (process.env.TABBY_CURRENCIES || 'SAR').trim();
  return raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

function isCurrencySupported(currency) {
  const cur = String(currency || '').toUpperCase();
  const allowed = supportedCurrencies();
  return allowed.length === 0 || allowed.includes(cur);
}

{
  const c = config();
  console.log(
    `[tabby] config: baseUrl="${c.baseUrl}" merchant="${c.merchantCode}" keyPrefix="${c.secretKey.slice(0, 12)}" configured=${isConfigured()}`
  );
  if (isConfigured() && !c.webhookSecret) {
    console.warn(
      '[tabby] TABBY_WEBHOOK_SECRET is unset — webhook endpoint accepts unauthenticated POSTs. ' +
        'Always re-verify via GET payment (safe), but set a secret before production go-live.'
    );
  }
}

function gatewayError(message, { retryable = false, code = 'PAYMENT_GATEWAY_ERROR' } = {}) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

function appendQuery(url, params) {
  if (!url) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Money as Tabby expects: string with up to 2 decimals. */
function moneyStr(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toFixed(2);
}

/** National-ish phone digits for Tabby buyer.phone (strip non-digits). */
function phoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function callTabby(method, path, body = undefined) {
  const c = config();
  if (!c.secretKey) {
    const err = new Error('Tabby is not configured (TABBY_SECRET_KEY missing)');
    err.code = 'PAYMENT_NOT_CONFIGURED';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${c.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    throw gatewayError(`Tabby request failed: ${e.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (res.status >= 500) {
    console.warn(`[tabby] HTTP ${res.status} from ${c.baseUrl}${path}`);
    throw gatewayError(`Tabby returned HTTP ${res.status}`, { retryable: true });
  }

  if (!res.ok) {
    const detail =
      (json && (json.error || json.message || json.statusText)) ||
      (typeof json === 'object' && json !== null ? JSON.stringify(json).slice(0, 300) : text.slice(0, 300)) ||
      `HTTP ${res.status}`;
    throw gatewayError(`Tabby error: ${detail}`);
  }

  return json;
}

/**
 * Build Tabby checkout payload from an order + customer + line items.
 * `items` should be [{ title, quantity, unitPrice, category?, referenceId? }].
 */
function buildSessionPayload(order, customer, items, { returnUrl = null, lang = 'en' } = {}) {
  const c = config();
  const name = (customer.name || order.shippingFullName || '').trim();
  const email = (customer.email || order.guestEmail || '').trim();
  const phone = phoneDigits(customer.phone || order.shippingPhone);
  // Never invent buyer identity — Tabby scoring + fraud checks need the real customer.
  // Fake fallbacks (noreply@ / 500000001) would pass sandbox OTP flows incorrectly.
  if (!name) throw gatewayError('Tabby requires the customer full name');
  if (!email || !email.includes('@')) throw gatewayError('Tabby requires a valid customer email');
  if (!phone || phone.length < 8) throw gatewayError('Tabby requires a valid customer phone');

  const city = (order.shippingCity || order.shippingArea || 'City').trim() || 'City';
  const address = [order.shippingStreetAddress, order.shippingApartment].filter(Boolean).join(', ').trim() || city;
  const zip = (order.shippingPostalCode || order.shippingShortAddress || '00000').trim() || '00000';

  const lineItems =
    Array.isArray(items) && items.length > 0
      ? items.map((it, idx) => ({
          reference_id: it.referenceId || it.productId || `line-${idx + 1}`,
          title: String(it.title || 'Item').slice(0, 255),
          quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
          unit_price: moneyStr(it.unitPrice),
          category: String(it.category || 'General').slice(0, 100),
        }))
      : [
          {
            reference_id: order.id,
            title: `Order ${order.orderNumber || order.id}`,
            quantity: 1,
            unit_price: moneyStr(order.totalAmount),
            category: 'General',
          },
        ];

  const registeredSince =
    customer.registeredSince instanceof Date
      ? customer.registeredSince.toISOString()
      : customer.registeredSince || new Date().toISOString();

  const successBase = c.successUrl;
  const cancelBase = c.cancelUrl || c.failureUrl || c.successUrl;
  const failureBase = c.failureUrl || c.cancelUrl || c.successUrl;

  const withMeta = (base) =>
    appendQuery(base, {
      oid: order.id,
      ...(returnUrl ? { ret: returnUrl } : {}),
    });

  return {
    payment: {
      amount: moneyStr(order.totalAmount),
      currency: order.currency || 'AED',
      description: `Order ${order.orderNumber || order.id}`,
      buyer: {
        name,
        email,
        phone,
      },
      shipping_address: {
        city,
        address,
        zip,
      },
      order: {
        reference_id: order.id,
        tax_amount: moneyStr(order.taxAmount || 0),
        shipping_amount: moneyStr(order.shippingAmount || 0),
        discount_amount: moneyStr(order.discountAmount || 0),
        items: lineItems,
      },
      buyer_history: {
        registered_since: registeredSince,
        loyalty_level: 0,
      },
      order_history: [],
      meta: {
        order_id: order.id,
        customer: customer.userId || null,
      },
    },
    lang: lang === 'ar' ? 'ar' : 'en',
    merchant_code: c.merchantCode,
    merchant_urls: {
      success: withMeta(successBase),
      cancel: withMeta(cancelBase),
      failure: withMeta(failureBase),
    },
  };
}

/**
 * Create a Tabby checkout session. Returns { paymentId, webUrl, status, rejectionReason }.
 * On status "rejected" / missing webUrl, caller should show another payment method.
 */
async function createCheckoutSession(order, customer = {}, items = [], opts = {}) {
  if (!isConfigured()) {
    const err = new Error('Tabby is not configured (TABBY_SECRET_KEY missing)');
    err.code = 'PAYMENT_NOT_CONFIGURED';
    throw err;
  }
  const c = config();
  if (!c.successUrl) {
    throw gatewayError('Tabby success URL is not configured (TABBY_SUCCESS_URL)');
  }
  if (!isCurrencySupported(order.currency)) {
    throw gatewayError(
      `Tabby does not support ${order.currency || 'this'} currency for this merchant (allowed: ${supportedCurrencies().join(', ')})`
    );
  }

  const payload = buildSessionPayload(order, customer, items, opts);
  const session = await callTabby('POST', '/api/v2/checkout', payload);

  const status = session?.status || null;
  const paymentId = session?.payment?.id != null ? String(session.payment.id) : null;
  const installments = session?.configuration?.available_products?.installments;
  const webUrl =
    Array.isArray(installments) && installments[0]?.web_url ? String(installments[0].web_url) : null;
  const rejectionReason =
    session?.configuration?.products?.installments?.rejection_reason || null;

  if (status === 'rejected' || !webUrl || !paymentId) {
    const err = gatewayError(
      rejectionReason
        ? `Tabby declined this payment: ${rejectionReason}`
        : 'Tabby did not return a checkout URL for this order'
    );
    err.tabbyStatus = status;
    err.rejectionReason = rejectionReason;
    throw err;
  }

  return { paymentId, webUrl, status, sessionId: session?.id || null };
}

/** Retrieve payment by id. Statuses: CREATED | AUTHORIZED | CLOSED | REJECTED | EXPIRED */
async function getPayment(paymentId) {
  if (!paymentId) throw gatewayError('paymentId is required');
  const data = await callTabby('GET', `/api/v2/payments/${encodeURIComponent(paymentId)}`);
  return {
    id: data?.id != null ? String(data.id) : String(paymentId),
    status: String(data?.status || '').toUpperCase(),
    amount: data?.amount != null ? Number(data.amount) : null,
    currency: data?.currency || null,
    orderId: data?.order?.reference_id || data?.meta?.order_id || null,
    captures: Array.isArray(data?.captures) ? data.captures : [],
    isTest: Boolean(data?.is_test),
    raw: data,
  };
}

/**
 * Capture an AUTHORIZED payment (full amount). Idempotent via reference_id.
 * Returns the updated payment summary from Tabby.
 */
async function capturePayment(paymentId, { amount, referenceId }) {
  if (!paymentId) throw gatewayError('paymentId is required');
  const body = {
    amount: moneyStr(amount),
    reference_id: referenceId || `capture-${paymentId}`,
  };
  const data = await callTabby('POST', `/api/v2/payments/${encodeURIComponent(paymentId)}/captures`, body);
  return {
    id: data?.id != null ? String(data.id) : String(paymentId),
    status: String(data?.status || '').toUpperCase(),
    amount: data?.amount != null ? Number(data.amount) : null,
    currency: data?.currency || null,
    orderId: data?.order?.reference_id || data?.meta?.order_id || null,
    captures: Array.isArray(data?.captures) ? data.captures : [],
    raw: data,
  };
}

/**
 * Verify webhook auth header.
 * - When TABBY_WEBHOOK_SECRET is set: require X-Tabby-Auth to match (defense in depth;
 *   payment status is still always re-verified via GET with the secret key).
 * - When unset in production: reject (force operators to configure a secret).
 * - When unset in non-production: allow (local/dev), relying on GET re-verify alone.
 */
function verifyWebhookAuth(req) {
  const secret = config().webhookSecret;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[tabby] rejecting webhook: TABBY_WEBHOOK_SECRET required in production');
      return false;
    }
    return true;
  }
  const header =
    req.get?.('x-tabby-auth') ||
    req.get?.('X-Tabby-Auth') ||
    req.headers?.['x-tabby-auth'] ||
    req.headers?.['X-Tabby-Auth'];
  return Boolean(header && String(header) === secret);
}

module.exports = {
  isConfigured,
  isCurrencySupported,
  supportedCurrencies,
  config,
  createCheckoutSession,
  getPayment,
  capturePayment,
  verifyWebhookAuth,
  buildSessionPayload,
};
