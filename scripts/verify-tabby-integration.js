/**
 * Non-destructive verification of the Tabby integration.
 * - Confirms migration columns/enums exist
 * - Confirms existing table row counts (sanity: data not wiped)
 * - Confirms COD + MYFATOORAH enum values still present
 * - Creates a real sandbox Tabby checkout session (does not capture / does not place an order)
 * - Hits local callback/webhook routes for basic response shape
 *
 * Usage: node scripts/verify-tabby-integration.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const tabbyService = require('../src/services/tabby.service');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const API = `http://localhost:${process.env.PORT || 5000}/api/v1`;

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  throw new Error(msg);
}

async function main() {
  console.log('\n=== Tabby integration verification (non-destructive) ===\n');

  // 1) Schema
  console.log('1. Database schema');
  const enumLabels = await prisma.$queryRawUnsafe(
    `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'PaymentMethod' ORDER BY e.enumsortorder`
  );
  const labels = enumLabels.map((r) => r.enumlabel);
  if (!labels.includes('COD')) fail('COD enum missing');
  if (!labels.includes('MYFATOORAH')) fail('MYFATOORAH enum missing');
  if (!labels.includes('TABBY')) fail('TABBY enum missing');
  ok(`PaymentMethod enum = [${labels.join(', ')}]`);

  const col = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'Region' AND column_name = 'tabbyEnabled'`
  );
  if (!col.length) fail('Region.tabbyEnabled column missing');
  ok(`Region.tabbyEnabled exists (${col[0].data_type}, default ${col[0].column_default})`);

  // 2) Data intact
  console.log('\n2. Existing data still present');
  const counts = {
    regions: await prisma.region.count(),
    orders: await prisma.order.count(),
    products: await prisma.product.count(),
    users: await prisma.user.count(),
  };
  ok(`counts: ${JSON.stringify(counts)}`);
  if (counts.regions < 1) fail('No regions — unexpected wipe?');

  const regions = await prisma.region.findMany({
    select: { code: true, currency: true, tabbyEnabled: true, onlinePaymentEnabled: true, codEnabled: true },
    orderBy: { code: 'asc' },
  });
  ok(
    `regions: ${regions
      .map((r) => `${r.code}(tabby=${r.tabbyEnabled},online=${r.onlinePaymentEnabled},cod=${r.codEnabled})`)
      .join(', ')}`
  );

  // 3) Config / secrets not leaked to public key usage
  console.log('\n3. Tabby config');
  if (!tabbyService.isConfigured()) fail('Tabby not configured (TABBY_SECRET_KEY)');
  const cfg = tabbyService.config();
  ok(`merchant=${cfg.merchantCode} base=${cfg.baseUrl} secretPrefix=${cfg.secretKey.slice(0, 12)}`);
  if (!cfg.secretKey.startsWith('sk_')) fail('Secret key should start with sk_');
  if (cfg.publicKey && !cfg.publicKey.startsWith('pk_')) fail('Public key should start with pk_');
  ok(`webhook secret ${cfg.webhookSecret ? 'SET' : 'unset (ok for local; required in production)'}`);

  // 4) Live sandbox session create (no order placed in our DB)
  console.log('\n4. Sandbox Tabby session create');
  const fakeOrder = {
    id: '00000000-0000-4000-8000-000000000099',
    orderNumber: 9999,
    totalAmount: 100,
    taxAmount: 0,
    shippingAmount: 0,
    discountAmount: 0,
    // Current Tabby sandbox merchant (tabby.sa / AmoonBloom) accepts SAR only.
    currency: 'SAR',
    shippingFullName: 'Test Buyer',
    shippingPhone: '+966500000001',
    shippingStreetAddress: 'King Fahd Rd',
    shippingCity: 'Riyadh',
    shippingPostalCode: '11564',
    guestEmail: 'otp.success@tabby.ai',
  };
  const session = await tabbyService.createCheckoutSession(
    fakeOrder,
    {
      name: 'Test Buyer',
      email: 'otp.success@tabby.ai',
      phone: '+966500000001',
      registeredSince: new Date('2024-01-01'),
    },
    [{ title: 'Test Bouquet', quantity: 1, unitPrice: 100, category: 'Flowers' }],
    { returnUrl: 'http://localhost:3000/sa/en/order/success', lang: 'en' }
  );
  if (!session.paymentId || !session.webUrl) fail('Session missing paymentId/webUrl');
  ok(`session created paymentId=${session.paymentId.slice(0, 12)}…`);
  ok(`webUrl host=${new URL(session.webUrl).host}`);

  const payment = await tabbyService.getPayment(session.paymentId);
  ok(`getPayment status=${payment.status} amount=${payment.amount} ${payment.currency}`);
  if (payment.status !== 'CREATED') fail(`Expected CREATED, got ${payment.status}`);

  // 5) Local HTTP routes
  console.log('\n5. Local HTTP routes');
  const regionsRes = await fetch(`${API}/regions`);
  if (!regionsRes.ok) fail(`/regions HTTP ${regionsRes.status}`);
  const regionsJson = await regionsRes.json();
  const list = regionsJson.data || regionsJson;
  const tabbyOn = (Array.isArray(list) ? list : []).filter((r) => r.tabbyEnabled);
  ok(`/regions OK — tabbyEnabled on: ${tabbyOn.map((r) => r.code).join(', ') || '(none)'}`);

  const cb = await fetch(`${API}/orders/payment/tabby/callback`);
  ok(`/tabby/callback without id → HTTP ${cb.status} (expect 400)`);
  if (cb.status !== 400) fail('callback should 400 without payment id');

  const wh = await fetch(`${API}/orders/payment/tabby/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: session.paymentId, status: 'created' }),
  });
  ok(`/tabby/webhook CREATED event → HTTP ${wh.status} (expect 200)`);
  if (wh.status !== 200) fail(`webhook unexpected ${wh.status}`);

  // Confirm we did NOT mark any real order paid for this fake payment
  const wronglyPaid = await prisma.order.findFirst({
    where: { paymentInvoiceId: session.paymentId, paymentStatus: 'PAID' },
  });
  if (wronglyPaid) fail(`Unexpected PAID order for sandbox session ${session.paymentId}`);
  ok('no local order was marked PAID for the smoke-test session');

  console.log('\n=== All checks passed ===\n');
  console.log('Manual next step (SA/SAR): checkout with otp.success@tabby.ai / +966500000001, OTP 8888.');
}

main()
  .catch((e) => {
    console.error('\nVERIFICATION FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
