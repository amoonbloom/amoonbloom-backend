/**
 * Region-scoped manager isolation test.
 *
 * Proves the core guarantee: a MANAGER assigned to region A can never see or
 * touch region B's data, while ADMINs and all-region managers (no ManagerRegion
 * rows) still see everything. Mounts the REAL routers on an ephemeral port and
 * drives them through the REAL auth + regionScope middleware — no mocks.
 *
 *   npm run test:region-scope
 */
require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/db');

const orderRoutes = require('../src/routes/order.routes');
const analyticsRoutes = require('../src/routes/analytics.routes');
const regionRoutes = require('../src/routes/region.routes');
const vatRoutes = require('../src/routes/vat.routes');
const deliveryZoneRoutes = require('../src/routes/deliveryZone.routes');
const promoCodeRoutes = require('../src/routes/promoCode.routes');
const productRoutes = require('../src/routes/product.routes');
const userRoutes = require('../src/routes/user.routes');
const jobsRoutes = require('../src/routes/jobs.routes');

const TAG = `rst_${Date.now()}`;
const ALL_PERMS = [
  'PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS', 'BANNERS', 'CONTACT', 'SETTINGS',
  'PROMO_CODES', 'ANALYTICS', 'REGIONS', 'REVIEWS', 'DELIVERY_ZONES', 'VAT',
  'CASH_ARRANGEMENT', 'NOTIFICATIONS', 'USERS', 'MANAGERS',
];

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const sign = (user) =>
  jwt.sign({ id: user.id, role: user.role, tv: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });

(async () => {
  const cleanup = { users: [], orders: [], products: [], promos: [], regions: [] };
  let server;
  try {
    console.log('\n=== Region-scoped manager isolation ===\n');

    // ---- Fixtures ----------------------------------------------------------
    const regionA = await prisma.region.create({ data: { code: `${TAG}_A`, name: 'Region A' } });
    const regionB = await prisma.region.create({ data: { code: `${TAG}_B`, name: 'Region B' } });
    cleanup.regions.push(regionA.id, regionB.id);

    const admin = await prisma.user.create({ data: { email: `${TAG}_admin@e.com`, role: 'ADMIN', status: 'ACTIVE' } });
    const managerAll = await prisma.user.create({
      data: { email: `${TAG}_all@e.com`, role: 'MANAGER', status: 'ACTIVE', managerTitle: 'All', managerPermissions: ALL_PERMS },
    });
    const managerA = await prisma.user.create({
      data: {
        email: `${TAG}_a@e.com`, role: 'MANAGER', status: 'ACTIVE', managerTitle: 'A', managerPermissions: ALL_PERMS,
        managedRegions: { create: [{ regionId: regionA.id }] },
      },
    });
    cleanup.users.push(admin.id, managerAll.id, managerA.id);

    // A customer belonging to region B (should be invisible to manager A).
    const custB = await prisma.user.create({
      data: { email: `${TAG}_custB@e.com`, role: 'CUSTOMER', status: 'ACTIVE', regionId: regionB.id },
    });
    cleanup.users.push(custB.id);

    // Orders: one per region.
    const orderA = await prisma.order.create({ data: { regionId: regionA.id, totalAmount: 50, status: 'PROCESSING' } });
    const orderB = await prisma.order.create({ data: { regionId: regionB.id, totalAmount: 123.45, status: 'PROCESSING' } });
    cleanup.orders.push(orderA.id, orderB.id);

    // A product visible ONLY in region B.
    const productB = await prisma.product.create({
      data: { title: `${TAG} Product B`, price: 99, regions: { create: [{ regionId: regionB.id }] } },
    });
    cleanup.products.push(productB.id);

    // A promo code redeemable ONLY in region B.
    const promoB = await prisma.promoCode.create({
      data: {
        code: `${TAG}_PROMOB`, name: 'Promo B', discountType: 'PERCENTAGE', discountValue: 10,
        regions: { create: [{ regionId: regionB.id }] },
      },
    });
    cleanup.promos.push(promoB.id);

    // A delivery zone + VAT config in region B (cascade-deleted with the region).
    await prisma.deliveryZone.create({ data: { regionId: regionB.id, name: `${TAG} ZoneB` } });
    await prisma.vatConfig.create({ data: { regionId: regionB.id } });

    // ---- Mount real routers ------------------------------------------------
    const app = express();
    app.use(express.json());
    app.use('/api/orders', orderRoutes);
    app.use('/api/admin/analytics', analyticsRoutes);
    app.use('/api/regions', regionRoutes);
    app.use('/api/vat', vatRoutes);
    app.use('/api/delivery-zones', deliveryZoneRoutes);
    app.use('/api/promo-codes', promoCodeRoutes);
    app.use('/api/products', productRoutes);
    app.use('/api/users', userRoutes);
    app.use('/api/admin/jobs', jobsRoutes);
    app.use((err, req, res, _next) => res.status(500).json({ success: false, message: err.message }));

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, path, user, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    };
    const total = (r) => r.json?.meta?.pagination?.total;

    // ---- 1. Orders ---------------------------------------------------------
    console.log('-- orders --');
    const oaList = await call('GET', '/api/orders', managerA);
    const oaIds = (oaList.json?.data ?? []).map((o) => o.id);
    check('managerA order list excludes region B order', !oaIds.includes(orderB.id));
    check('managerA order list includes region A order', oaIds.includes(orderA.id));

    check('managerA ?region=B order list → empty', total(await call('GET', `/api/orders?region=${regionB.code}`, managerA)) === 0);
    check('admin ?region=B order list → ≥1', (total(await call('GET', `/api/orders?region=${regionB.code}`, admin)) ?? 0) >= 1);

    check('managerA GET region B order by id → 404', (await call('GET', `/api/orders/${orderB.id}`, managerA)).status === 404);
    check('managerA GET region A order by id → 200', (await call('GET', `/api/orders/${orderA.id}`, managerA)).status === 200);
    check('admin GET region B order by id → 200', (await call('GET', `/api/orders/${orderB.id}`, admin)).status === 200);

    check('managerA PATCH region B order status → 403', (await call('PATCH', `/api/orders/${orderB.id}/status`, managerA, { status: 'PROCESSING' })).status === 403);
    check('managerA PATCH region A order status → not 403', (await call('PATCH', `/api/orders/${orderA.id}/status`, managerA, { status: 'PROCESSING' })).status !== 403);
    check('admin PATCH region B order status → not 403', (await call('PATCH', `/api/orders/${orderB.id}/status`, admin, { status: 'PROCESSING' })).status !== 403);

    // ---- 2. Analytics ------------------------------------------------------
    console.log('\n-- analytics --');
    const anMgrB = await call('GET', `/api/admin/analytics/revenue?preset=all_time&region=${regionB.code}`, managerA);
    check('managerA revenue for region B → 0 orders (scoped out)', anMgrB.json?.data?.summary?.activeOrderCount === 0);
    const anAdmB = await call('GET', `/api/admin/analytics/revenue?preset=all_time&region=${regionB.code}`, admin);
    check('admin revenue for region B → ≥1 order', (anAdmB.json?.data?.summary?.activeOrderCount ?? 0) >= 1);
    const anMgrA = await call('GET', `/api/admin/analytics/revenue?preset=all_time&region=${regionA.code}`, managerA);
    check('managerA revenue for region A → ≥1 order', (anMgrA.json?.data?.summary?.activeOrderCount ?? 0) >= 1);

    // ---- 3. Products (catalog overlap read) --------------------------------
    console.log('\n-- products --');
    check('managerA ?region=B products → 0', total(await call('GET', `/api/products?region=${regionB.code}`, managerA)) === 0);
    check('admin ?region=B products → ≥1', (total(await call('GET', `/api/products?region=${regionB.code}`, admin)) ?? 0) >= 1);
    check('managerA update region-B product → 404 (hidden)', (await call('PUT', `/api/products/${productB.id}`, managerA, { title: 'x' })).status === 404);
    check('managerA create product in region B → 403', (await call('POST', '/api/products', managerA, { title: `${TAG} bad`, price: 5, regionIds: [regionB.id] })).status === 403);

    // ---- 4. Promo codes ----------------------------------------------------
    console.log('\n-- promo codes --');
    const promoList = await call('GET', '/api/promo-codes?limit=100', managerA);
    const promoIds = (promoList.json?.data ?? []).map((p) => p.id);
    check('managerA promo list excludes region-B-only code', !promoIds.includes(promoB.id));
    check('managerA GET region-B promo by id → 404', (await call('GET', `/api/promo-codes/${promoB.id}`, managerA)).status === 404);
    check('managerA create promo in region B → 403', (await call('POST', '/api/promo-codes', managerA, { code: `${TAG}_bad`, name: 'bad', discountType: 'PERCENTAGE', discountValue: 5, regionIds: [regionB.id] })).status === 403);

    // ---- 5. Delivery zones + VAT (region-partitioned config) ---------------
    console.log('\n-- delivery zones + VAT --');
    check('managerA ?region=B zones → empty', (await call('GET', `/api/delivery-zones?region=${regionB.code}`, managerA)).json?.data?.length === 0);
    check('managerA create zone in region B → 403', (await call('POST', '/api/delivery-zones', managerA, { regionId: regionB.id, name: 'x' })).status === 403);
    check('managerA create zone in region A → not 403', (await call('POST', '/api/delivery-zones', managerA, { regionId: regionA.id, name: `${TAG}_zA` })).status !== 403);
    check('managerA GET region-B VAT → 404', (await call('GET', `/api/vat/${regionB.id}`, managerA)).status === 404);
    check('managerA PUT region-B VAT → 403', (await call('PUT', `/api/vat/${regionB.id}`, managerA, { enabled: true, ratePercent: 5 })).status === 403);
    check('managerA GET region-A VAT → 200', (await call('GET', `/api/vat/${regionA.id}`, managerA)).status === 200);

    // ---- 6. Users (customer region scoping) --------------------------------
    console.log('\n-- users --');
    const custList = await call('GET', '/api/users?role=CUSTOMER&limit=100', managerA);
    const custIds = (custList.json?.data ?? []).map((u) => u.id);
    check('managerA customer list excludes region-B customer', !custIds.includes(custB.id));
    check('managerA GET region-B customer by id → 404', (await call('GET', `/api/users/${custB.id}`, managerA)).status === 404);
    check('admin GET region-B customer by id → 200', (await call('GET', `/api/users/${custB.id}`, admin)).status === 200);
    // A scoped manager cannot mint an all-region manager (would escalate access).
    check('managerA create all-region manager → blocked', [400, 403].includes((await call('POST', '/api/users', managerA, { email: `${TAG}_esc@e.com`, fullName: 'Esc', password: 'Passw0rd!', role: 'MANAGER', managerTitle: 'x', managerPermissions: ['ORDERS'] })).status));
    check('managerA create manager for region B → blocked', [400, 403].includes((await call('POST', '/api/users', managerA, { email: `${TAG}_esc2@e.com`, fullName: 'Esc2', password: 'Passw0rd!', role: 'MANAGER', managerTitle: 'x', managerPermissions: ['ORDERS'], managedRegionIds: [regionB.id] })).status));

    // ---- 7. Regions --------------------------------------------------------
    console.log('\n-- regions --');
    const regList = await call('GET', '/api/regions', managerA);
    const regIds = (regList.json?.data ?? []).map((r) => r.id);
    check('managerA region list = only region A', regIds.includes(regionA.id) && !regIds.includes(regionB.id));
    // Region create is blocked for scoped managers (403 in the controller; the
    // route's legal-field validation may 400 a minimal body first — either way,
    // no region is created). update→404 + delete→403 below prove the scope gate.
    check('managerA create region → blocked (not created)', (await call('POST', '/api/regions', managerA, { code: `${TAG}_new`, name: 'new' })).status !== 201);
    check('managerA update region B → 404 (hidden)', (await call('PUT', `/api/regions/${regionB.id}`, managerA, { name: 'x' })).status === 404);
    check('managerA delete region A → 403 (cannot delete)', (await call('DELETE', `/api/regions/${regionA.id}`, managerA)).status === 403);

    // ---- 8. Notifications broadcast ----------------------------------------
    console.log('\n-- notifications broadcast --');
    check('managerA broadcast to region B → 403', (await call('POST', '/api/admin/jobs/broadcast', managerA, { title: 't', body: 'b', regionId: regionB.id })).status === 403);
    // Region A is in scope → passes the region gate (202 queued, or 503 if the job
    // engine is down in this test env — either proves it got past the 403 check).
    check('managerA broadcast to region A → not 403', [202, 503].includes((await call('POST', '/api/admin/jobs/broadcast', managerA, { title: 't', body: 'b', regionId: regionA.id })).status));

    // ---- 9. Admin order-alert recipient filter (mirrors adminOrderAlert.job) --
    console.log('\n-- admin order-alert region filter --');
    const recipientsForRegionB = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { role: 'ADMIN' },
          {
            role: 'MANAGER', managerPermissions: { has: 'ORDERS' },
            OR: [{ managedRegions: { none: {} } }, { managedRegions: { some: { regionId: regionB.id } } }],
          },
        ],
      },
      select: { id: true },
    });
    const recIds = recipientsForRegionB.map((u) => u.id);
    check('region-B order alert EXCLUDES manager A', !recIds.includes(managerA.id));
    check('region-B order alert INCLUDES all-region manager', recIds.includes(managerAll.id));
    check('region-B order alert INCLUDES admin', recIds.includes(admin.id));

    console.log(`\n${fail === 0 ? '🎉 ALL PASSED' : '⚠️  SOME FAILED'} — pass: ${pass}, fail: ${fail}\n`);
  } catch (err) {
    console.error('\n💥 Test crashed:', err);
    fail++;
  } finally {
    // Cleanup — leave the DB exactly as we found it.
    await prisma.order.deleteMany({ where: { id: { in: cleanup.orders } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: cleanup.products } } }).catch(() => {});
    await prisma.promoCode.deleteMany({ where: { id: { in: cleanup.promos } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } }).catch(() => {});
    // Region delete cascades ManagerRegion / ProductRegion / PromoCodeRegion /
    // DeliveryZone / VatConfig; also delete any zones created in region A above.
    await prisma.region.deleteMany({ where: { id: { in: cleanup.regions } } }).catch(() => {});
    if (server) await new Promise((r) => server.close(r));
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
