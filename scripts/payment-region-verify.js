/**
 * payment-region-verify — end-to-end checks for the per-region MyFatoorah gateway +
 * the per-region Apple Pay / Card toggles.
 *
 *   node scripts/payment-region-verify.js
 *
 * Covers:
 *   1. payment.service.resolveProfile — per-region env with base (UAE) fallback, and the
 *      config-only switch to a region's own gateway.
 *   2. createPaymentInvoice — charges the ORDER's currency (SAR) and region-tags the
 *      callback (?region=…) so the confirm hits the same gateway. (fetch mocked)
 *   3. region.service — applePayEnabled / cardPaymentEnabled round-trip (create + update +
 *      null-safe partial update).
 *   4. order.service — Apple Pay guard: session/execute rejected when applePayEnabled=false.
 *   5. order.service — Card guard: hosted /pay rejected when cardPaymentEnabled=false.
 *   6. order.service happy path — a fully-enabled SAR region flows region + currency all the
 *      way through to the gateway request. (fetch mocked)
 *
 * Uses the local test DB (see .env DATABASE_URL). All rows are tagged and cleaned up.
 */

// Base gateway env so resolveProfile has something to fall back to. Set BEFORE requiring
// the service (it snapshots the default profile at load only for a log line; resolution is
// always live, but we keep this deterministic).
process.env.MYFATOORAH_API_KEY = process.env.MYFATOORAH_API_KEY || 'SK_ARE_testbase';
process.env.MYFATOORAH_BASE_URL = process.env.MYFATOORAH_BASE_URL || 'https://api-ae.myfatoorah.com';
process.env.MYFATOORAH_CALLBACK_URL = 'https://backend.test/api/v1/orders/payment/callback';
process.env.MYFATOORAH_ERROR_URL = 'https://backend.test/api/v1/orders/payment/error';
delete process.env.MYFATOORAH_API_KEY_SA;
delete process.env.MYFATOORAH_BASE_URL_SA;

const prisma = require('../src/config/db');
const paymentService = require('../src/services/payment.service');
const regionService = require('../src/services/region.service');
const orderService = require('../src/services/order.service');

const TAG = 'ZZPAYRGN';
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// A one-shot fetch mock that records the last request body and returns a MyFatoorah-shaped
// success. Returns a restore fn.
function mockFetch(data) {
  const orig = global.fetch;
  const captured = { url: null, body: null };
  global.fetch = async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    return { status: 200, json: async () => ({ IsSuccess: true, Data: data }) };
  };
  return { captured, restore: () => { global.fetch = orig; } };
}

async function cleanup() {
  await prisma.order.deleteMany({ where: { region: { code: { startsWith: TAG } } } });
  await prisma.order.deleteMany({ where: { shippingFullName: `${TAG} Buyer` } });
  await prisma.region.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } });
}

async function main() {
  await cleanup();

  // ---- 1. resolveProfile: per-region env with base fallback --------------------------
  console.log('\n1) payment.service.resolveProfile — per-region env + UAE fallback');
  {
    const base = paymentService.resolveProfile(null);
    const sa = paymentService.resolveProfile('SA');
    // Don't hardcode the key value (real .env may supply it) — assert the RELATIONSHIP:
    // with no SA-scoped env, SA resolves to exactly the base gateway.
    ok(Boolean(base.apiKey), 'base profile resolves a key from MYFATOORAH_API_KEY');
    ok(sa.apiKey === base.apiKey && sa.baseUrl === base.baseUrl,
      'SA with no scoped env falls back to the base (UAE) gateway');

    process.env.MYFATOORAH_API_KEY_SA = 'SK_SAU_own';
    process.env.MYFATOORAH_BASE_URL_SA = 'https://api-sa.myfatoorah.com';
    const sa2 = paymentService.resolveProfile('SA');
    ok(sa2.apiKey === 'SK_SAU_own' && sa2.baseUrl === 'https://api-sa.myfatoorah.com',
      'SA switches to its OWN gateway once MYFATOORAH_*_SA is set (config-only, no code change)');
    delete process.env.MYFATOORAH_API_KEY_SA;
    delete process.env.MYFATOORAH_BASE_URL_SA;

    ok(paymentService.isConfigured('SA') === true, 'isConfigured(SA) true via fallback');
  }

  // ---- 2. createPaymentInvoice: order currency + region-tagged callback ---------------
  console.log('\n2) createPaymentInvoice — charges order currency (SAR) + region-tags callback');
  {
    const m = mockFetch({ InvoiceId: 987654, InvoiceURL: 'https://pay.test/x' });
    try {
      const res = await paymentService.createPaymentInvoice(
        { id: 'order-abc', totalAmount: 250, currency: 'SAR' },
        { name: 'Test' },
        { regionCode: 'sa' }
      );
      ok(res.invoiceId === '987654' && res.paymentUrl === 'https://pay.test/x', 'returns invoiceId + paymentUrl');
      ok(m.captured.body.DisplayCurrencyIso === 'SAR', 'DisplayCurrencyIso is the order currency (SAR), not a global default');
      ok(String(m.captured.body.CallBackUrl).includes('region=sa'), 'CallBackUrl is region-tagged (?region=sa)');
      ok(m.captured.url.startsWith('https://api-ae.myfatoorah.com'), 'hits the resolved (fallback UAE) gateway host');
    } finally {
      m.restore();
    }
  }

  // ---- 3. region.service: toggle round-trip ------------------------------------------
  console.log('\n3) region.service — applePayEnabled / cardPaymentEnabled round-trip');
  let region;
  {
    region = await regionService.createRegion({
      code: `${TAG}A`, name: `${TAG} Region A`, currency: 'SAR',
      onlinePaymentEnabled: true, applePayEnabled: false, cardPaymentEnabled: true,
    });
    ok(region.applePayEnabled === false && region.cardPaymentEnabled === true,
      'createRegion persists the two toggles as given');

    const upd = await regionService.updateRegion(region.id, { applePayEnabled: true, cardPaymentEnabled: false });
    ok(upd.applePayEnabled === true && upd.cardPaymentEnabled === false, 'updateRegion flips both toggles');

    const partial = await regionService.updateRegion(region.id, { name: `${TAG} Region A2` });
    ok(partial.applePayEnabled === true && partial.cardPaymentEnabled === false,
      'a partial update (no toggle keys) leaves the toggles unchanged (null-safe)');
  }

  // Shared test buyer + a MYFATOORAH SAR order factory.
  const user = await prisma.user.create({ data: { email: `${TAG.toLowerCase()}.buyer@test.local`, fullName: `${TAG} Buyer` } });
  const makeOrder = (regionId) => prisma.order.create({
    data: {
      userId: user.id, regionId, currency: 'SAR', totalAmount: 250,
      paymentMethod: 'MYFATOORAH', status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID',
      shippingFullName: `${TAG} Buyer`, shippingPhone: '0500000000',
    },
    select: { id: true },
  });

  // ---- 4. Apple Pay guard (applePayEnabled=false) ------------------------------------
  console.log('\n4) order.service — Apple Pay session/execute rejected when applePayEnabled=false');
  {
    const r = await regionService.createRegion({
      code: `${TAG}AP`, name: `${TAG} NoApplePay`, currency: 'SAR',
      onlinePaymentEnabled: true, applePayEnabled: false, cardPaymentEnabled: true,
    });
    const order = await makeOrder(r.id);
    const sess = await orderService.createPaymentSession(order.id, user.id);
    ok(/Apple Pay/i.test(sess.error || ''), `createPaymentSession blocked: "${sess.error}"`);
    const exec = await orderService.executeOrderPayment(order.id, user.id, 'fake-session');
    ok(/Apple Pay/i.test(exec.error || ''), `executeOrderPayment blocked: "${exec.error}"`);
  }

  // ---- 5. Card guard (cardPaymentEnabled=false) --------------------------------------
  console.log('\n5) order.service — hosted /pay rejected when cardPaymentEnabled=false');
  {
    const r = await regionService.createRegion({
      code: `${TAG}CD`, name: `${TAG} NoCard`, currency: 'SAR',
      onlinePaymentEnabled: true, applePayEnabled: true, cardPaymentEnabled: false,
    });
    const order = await makeOrder(r.id);
    const pay = await orderService.initiateOrderPayment(order.id, user.id);
    ok(/Card payment/i.test(pay.error || ''), `initiateOrderPayment blocked: "${pay.error}"`);
  }

  // ---- 6. Happy path — region + currency flow through to the gateway ------------------
  console.log('\n6) order.service — fully-enabled SAR region flows region + currency to gateway');
  {
    const r = await regionService.createRegion({
      code: `${TAG}OK`, name: `${TAG} Enabled`, currency: 'SAR',
      onlinePaymentEnabled: true, applePayEnabled: true, cardPaymentEnabled: true,
    });
    const order = await makeOrder(r.id);
    const m = mockFetch({ InvoiceId: 111222, InvoiceURL: 'https://pay.test/ok' });
    try {
      const pay = await orderService.initiateOrderPayment(order.id, user.id);
      ok(pay.paymentUrl === 'https://pay.test/ok' && !pay.error, 'initiateOrderPayment returns a paymentUrl');
      ok(m.captured.body.DisplayCurrencyIso === 'SAR', 'gateway charged in the region currency (SAR)');
      ok(String(m.captured.body.CallBackUrl).includes(`region=${TAG.toLowerCase()}ok`), 'callback carries the order region code');
      const saved = await prisma.order.findUnique({ where: { id: order.id }, select: { paymentInvoiceId: true } });
      ok(saved.paymentInvoiceId === '111222', 'invoiceId stored on the order');
    } finally {
      m.restore();
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} payment-region-verify: ${pass} passed, ${fail} failed`);
  if (fail > 0) console.log('Failures:\n - ' + failures.join('\n - '));
}

main()
  .catch((e) => { console.error('FATAL', e); fail += 1; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  });
