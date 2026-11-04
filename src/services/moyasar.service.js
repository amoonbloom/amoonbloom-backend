/**
 * Moyasar payment integration (mada / Visa / Mastercard / Apple Pay).
 *
 * Primary flow — embedded Moyasar Form (customer stays on our storefront):
 *   1. initiateOrderPayment returns form config (publishable key + amount + callback_url).
 *   2. Storefront mounts Moyasar.init on /order/pay (no redirect to checkout.moyasar.com).
 *   3. on_completed → attach payment id on the order; 3DS may briefly leave then return
 *      to our storefront callback_url.
 *   4. We re-fetch the payment with the secret key and confirm (never trust the client).
 *   5. Webhook payment_paid is the safety net when the browser never returns.
 *
 * Legacy: createInvoice() still available for hosted invoice links if needed.
 *
 * Amounts are in the currency's smallest unit (1.00 SAR = 100 halalas).
 *
 * Config (env; see .env.example):
 *   MOYASAR_SECRET_KEY          sk_test_… / sk_live_…  (server only)
 *   MOYASAR_PUBLISHABLE_KEY     pk_test_… / pk_live_…  (safe for form init)
 *   MOYASAR_BASE_URL            default https://api.moyasar.com
 *   MOYASAR_SUCCESS_URL         legacy hosted-invoice browser return
 *   MOYASAR_BACK_URL            legacy hosted-invoice back button
 *   MOYASAR_WEBHOOK_SECRET      shared_secret when registering the webhook
 *   MOYASAR_APPLE_PAY_LABEL     Apple Pay sheet label (default: Amoon Bloom)
 */

const DEFAULT_BASE_URL = 'https://api.moyasar.com';
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.MOYASAR_TIMEOUT_MS || '15000', 10));

function config() {
  return {
    secretKey: (process.env.MOYASAR_SECRET_KEY || '').trim(),
    publishableKey: (process.env.MOYASAR_PUBLISHABLE_KEY || '').trim(),
    baseUrl: (process.env.MOYASAR_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    successUrl: (process.env.MOYASAR_SUCCESS_URL || '').trim(),
    backUrl: (process.env.MOYASAR_BACK_URL || '').trim(),
    webhookSecret: (process.env.MOYASAR_WEBHOOK_SECRET || '').trim(),
    invoiceCallbackUrl: (process.env.MOYASAR_INVOICE_CALLBACK_URL || '').trim(),
    applePayLabel: (process.env.MOYASAR_APPLE_PAY_LABEL || 'Amoon Bloom').trim() || 'Amoon Bloom',
  };
}

{
  const c = config();
  console.log(
    `[moyasar] config: baseUrl="${c.baseUrl}" keyPrefix="${c.secretKey.slice(0, 10)}" ` +
      `pkPrefix="${c.publishableKey.slice(0, 10)}" configured=${Boolean(c.secretKey && c.publishableKey)}`
  );
}

function isConfigured() {
  const c = config();
  return Boolean(c.secretKey && c.publishableKey);
}

/** SAR/AED/etc. → integer minor units. Moyasar minimum is 100. */
function toMinorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw gatewayError('Invalid payment amount');
  }
  return Math.round(n * 100);
}

function fromMinorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

function gatewayError(message, { retryable = false, code = 'PAYMENT_GATEWAY_ERROR' } = {}) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appendQuery(url, params) {
  if (!url) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Basic Auth with secret key as username (Moyasar convention: `-u sk_…:`).
 */
async function callOnce(method, path, body = undefined) {
  const c = config();
  if (!c.secretKey) {
    const err = new Error('Moyasar is not configured (MOYASAR_SECRET_KEY missing)');
    err.code = 'PAYMENT_NOT_CONFIGURED';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const auth = Buffer.from(`${c.secretKey}:`).toString('base64');

  let res;
  try {
    res = await fetch(`${c.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    throw gatewayError(`Moyasar request failed: ${e.message}`, { retryable: true });
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
    console.warn(`[moyasar] HTTP ${res.status} from ${c.baseUrl}${path}`);
    throw gatewayError(`Moyasar returned HTTP ${res.status}`, { retryable: true });
  }

  if (!res.ok) {
    const detail =
      json?.message ||
      (json?.errors ? JSON.stringify(json.errors) : null) ||
      text?.slice(0, 200) ||
      `HTTP ${res.status}`;
    throw gatewayError(`Moyasar error: ${detail}`);
  }

  return json;
}

async function callMoyasar(method, path, body, { retries = 0 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callOnce(method, path, body);
    } catch (e) {
      lastErr = e;
      if (!e.retryable || attempt === retries) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Config for Moyasar.init on the storefront (embedded form — no hosted invoice redirect).
 *
 * @param {object} order
 * @param {{ callbackUrl: string, lang?: string, applePayEnabled?: boolean, cardPaymentEnabled?: boolean }} opts
 */
function buildEmbeddedFormConfig(
  order,
  { callbackUrl, lang = 'en', applePayEnabled = true, cardPaymentEnabled = true } = {}
) {
  const c = config();
  if (!c.publishableKey) {
    throw gatewayError('Moyasar publishable key is not configured (MOYASAR_PUBLISHABLE_KEY)', {
      code: 'PAYMENT_NOT_CONFIGURED',
    });
  }
  if (!callbackUrl) {
    throw gatewayError('Moyasar form callback URL is required');
  }

  const amount = toMinorUnits(order.totalAmount);
  if (amount < 100) {
    throw gatewayError('Order total is below Moyasar minimum (1.00)');
  }

  const methods = [];
  if (cardPaymentEnabled !== false) methods.push('creditcard');
  if (applePayEnabled !== false) methods.push('applepay');
  if (methods.length === 0) {
    throw gatewayError('No Moyasar payment methods enabled for this region');
  }

  const form = {
    publishableApiKey: c.publishableKey,
    amount,
    currency: String(order.currency || 'SAR').toUpperCase(),
    description: `Order ${order.orderNumber || order.id}`,
    callbackUrl: String(callbackUrl),
    language: lang === 'ar' ? 'ar' : 'en',
    methods,
    supportedNetworks: ['mada', 'visa', 'mastercard', 'amex'],
    metadata: {
      order_id: String(order.id),
      order_number: order.orderNumber != null ? String(order.orderNumber) : '',
    },
    // CDN pinned — bump deliberately when upgrading the form.
    scriptUrl: 'https://cdn.moyasar.com/mpf/1.15.0/moyasar.js',
    cssUrl: 'https://cdn.moyasar.com/mpf/1.15.0/moyasar.css',
  };

  if (methods.includes('applepay')) {
    form.applePay = {
      country: 'SA',
      label: c.applePayLabel,
      // Moyasar-hosted merchant validation (domain must be registered in dashboard for live).
      validateMerchantUrl: `${c.baseUrl}/v1/applepay/initiate`,
    };
  }

  return form;
}

/**
 * Create a Moyasar hosted invoice (legacy / payment-link). Prefer buildEmbeddedFormConfig for web.
 * @returns {{ invoiceId: string, paymentUrl: string }}
 */
async function createInvoice(order, { returnUrl = null, lang = 'en' } = {}) {
  const c = config();
  if (!c.successUrl) {
    throw gatewayError('Moyasar success URL is not configured (MOYASAR_SUCCESS_URL)');
  }

  const amount = toMinorUnits(order.totalAmount);
  if (amount < 100) {
    throw gatewayError('Order total is below Moyasar minimum (1.00)');
  }

  const currency = String(order.currency || 'SAR').toUpperCase();
  const orderId = order.id;
  const description = `Order ${order.orderNumber || orderId}`;

  const successUrl = appendQuery(c.successUrl, {
    oid: orderId,
    ...(returnUrl ? { ret: returnUrl } : {}),
  });
  const backUrl = appendQuery(c.backUrl || c.successUrl, {
    oid: orderId,
    unpaid: '1',
    ...(returnUrl ? { ret: returnUrl } : {}),
  });

  const body = {
    amount,
    currency,
    description,
    success_url: successUrl,
    back_url: backUrl,
    metadata: {
      order_id: String(orderId),
      order_number: order.orderNumber != null ? String(order.orderNumber) : '',
      lang: lang === 'ar' ? 'ar' : 'en',
    },
  };

  if (c.invoiceCallbackUrl) {
    body.callback_url = c.invoiceCallbackUrl;
  }

  const data = await callMoyasar('POST', '/v1/invoices', body, { retries: 0 });

  const invoiceId = data?.id != null ? String(data.id) : null;
  let paymentUrl = data?.url || null;
  if (paymentUrl && lang === 'ar') {
    paymentUrl = appendQuery(paymentUrl, { lang: 'ar' });
  }

  if (!invoiceId || !paymentUrl) {
    throw gatewayError('Moyasar did not return an invoice URL');
  }

  return { invoiceId, paymentUrl };
}

async function fetchInvoice(invoiceId) {
  return callMoyasar('GET', `/v1/invoices/${encodeURIComponent(invoiceId)}`, undefined, {
    retries: 2,
  });
}

async function fetchPayment(paymentId) {
  return callMoyasar('GET', `/v1/payments/${encodeURIComponent(paymentId)}`, undefined, {
    retries: 2,
  });
}

async function verifyInvoice(invoiceId) {
  const inv = await fetchInvoice(invoiceId);
  const status = String(inv?.status || '').toLowerCase();
  const isPaid = status === 'paid';
  const meta = inv?.metadata && typeof inv.metadata === 'object' ? inv.metadata : {};
  const orderId = meta.order_id ? String(meta.order_id) : null;

  const payments = Array.isArray(inv?.payments) ? inv.payments : [];
  const paidPay =
    payments.find((p) => String(p.status || '').toLowerCase() === 'paid') || payments[0] || null;

  return {
    isPaid,
    status: inv?.status || null,
    orderId,
    invoiceId: inv?.id != null ? String(inv.id) : String(invoiceId),
    paymentId: paidPay?.id != null ? String(paidPay.id) : null,
    amountMajor: fromMinorUnits(inv?.amount),
    currency: inv?.currency ? String(inv.currency).toUpperCase() : null,
    raw: inv,
  };
}

async function verifyPayment(paymentId) {
  const pay = await fetchPayment(paymentId);
  const status = String(pay?.status || '').toLowerCase();
  const isPaid = status === 'paid';
  const meta = pay?.metadata && typeof pay.metadata === 'object' ? pay.metadata : {};
  let orderId = meta.order_id ? String(meta.order_id) : null;
  const invoiceId = pay?.invoice_id != null ? String(pay.invoice_id) : null;

  if (!orderId && invoiceId) {
    try {
      const inv = await verifyInvoice(invoiceId);
      orderId = inv.orderId;
    } catch (e) {
      console.warn(`[moyasar] could not resolve order via invoice ${invoiceId}: ${e.message}`);
    }
  }

  return {
    isPaid,
    status: pay?.status || null,
    orderId,
    invoiceId,
    paymentId: pay?.id != null ? String(pay.id) : String(paymentId),
    amountMajor: fromMinorUnits(pay?.amount),
    currency: pay?.currency ? String(pay.currency).toUpperCase() : null,
    raw: pay,
  };
}

/**
 * Embedded flow stores a payment id on Order.paymentInvoiceId; legacy hosted flow stores
 * an invoice id. Try payment first, then invoice.
 */
async function verifyPaymentOrInvoice(id) {
  if (!id) return null;
  try {
    return await verifyPayment(String(id));
  } catch (payErr) {
    try {
      return await verifyInvoice(String(id));
    } catch (invErr) {
      console.warn(
        `[moyasar] verifyPaymentOrInvoice failed for ${id}: payment=${payErr.message}; invoice=${invErr.message}`
      );
      throw payErr;
    }
  }
}

/**
 * Moyasar sends `secret_token` in the webhook JSON body (not an HTTP signature header).
 * When MOYASAR_WEBHOOK_SECRET is set, it must match. When unset in production, reject.
 */
function verifyWebhookSecret(body) {
  const secret = config().webhookSecret;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[moyasar] rejecting webhook: MOYASAR_WEBHOOK_SECRET required in production');
      return false;
    }
    console.warn('[moyasar] webhook accepted without secret (dev only)');
    return true;
  }
  const token = body?.secret_token != null ? String(body.secret_token) : '';
  if (!token || token !== secret) return false;
  return true;
}

module.exports = {
  isConfigured,
  buildEmbeddedFormConfig,
  createInvoice,
  fetchInvoice,
  fetchPayment,
  verifyInvoice,
  verifyPayment,
  verifyPaymentOrInvoice,
  verifyWebhookSecret,
  toMinorUnits,
  fromMinorUnits,
  config,
};
