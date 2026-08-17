/**
 * FULL HTTP-STACK SQA for Region Content Management (workstreams A/B/C):
 * routes + express-validator + auth (verifyAdminOrManager) + REGIONS permission
 * + region-scope guards + sanitization + hidden-until-set behaviour.
 *
 * Mirrors scripts/test-region-scope.js: builds an in-process express app that
 * mounts the REAL routers, listens on a random port, and drives it with fetch
 * using JWTs minted for fixture users. LOCAL test DB only; TAG-isolated + cleaned.
 *
 *   node -r dotenv/config scripts/legal-branches-http-sqa.js
 */
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/db');
const regionRoutes = require('../src/routes/region.routes');
const legalPageRoutes = require('../src/routes/legalPage.routes');
const branchRoutes = require('../src/routes/branch.routes');
const errorHandler = require('../src/middleware/errorHandler');
const regionService = require('../src/services/region.service');

const TAG = `SQA_${Date.now()}`;
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sign = (user) =>
  jwt.sign({ id: user.id, role: user.role, tv: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });

async function cleanup() {
  const regions = await prisma.region.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  const ids = regions.map((r) => r.id);
  if (ids.length) {
    await prisma.regionLegalPage.deleteMany({ where: { regionId: { in: ids } } });
    await prisma.regionBranch.deleteMany({ where: { regionId: { in: ids } } });
    await prisma.region.updateMany({ where: { id: { in: ids } }, data: { isDefault: false } });
    await prisma.region.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
  regionService.invalidateCache();
}

(async () => {
  let server;
  try {
    await cleanup();

    // ---- Fixtures ----
    const regionA = await prisma.region.create({ data: { code: `${TAG}_A`, name: 'SQA Region A', currency: 'AED', isActive: true, isDefault: false } });
    const regionB = await prisma.region.create({ data: { code: `${TAG}_B`, name: 'SQA Region B', currency: 'SAR', isActive: true, isDefault: false } });
    const admin = await prisma.user.create({ data: { email: `${TAG}_admin@e.com`, role: 'ADMIN', status: 'ACTIVE' } });
    const mgrRegions = await prisma.user.create({
      data: { email: `${TAG}_mgrA@e.com`, role: 'MANAGER', status: 'ACTIVE', managerPermissions: ['REGIONS'], managedRegions: { create: [{ regionId: regionA.id }] } },
    });
    const mgrNoPerm = await prisma.user.create({
      data: { email: `${TAG}_mgrNo@e.com`, role: 'MANAGER', status: 'ACTIVE', managerPermissions: ['ORDERS'] },
    });
    regionService.invalidateCache();

    // ---- App ----
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/regions', regionRoutes);
    app.use('/api/legal-pages', legalPageRoutes);
    app.use('/api/branches', branchRoutes);
    app.use(errorHandler);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, path, user, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    };

    // =====================================================================
    console.log('\n== A. Region create: legal fields optional + social validation ==');
    const created = await call('POST', '/api/regions', admin, { code: `${TAG}_C`, name: 'SQA Region C', currency: 'AED' });
    check('POST /regions without any legal fields → 201', created.status === 201, `got ${created.status}`);
    check('created region has publishedPageSlugs? (not on create payload — only list)', created.json?.data?.id != null);
    const longUrl = 'https://x.com/' + 'a'.repeat(600);
    const badSocial = await call('POST', '/api/regions', admin, { code: `${TAG}_D`, name: 'D', instagramUrl: longUrl });
    check('POST /regions social URL > 500 chars → 400', badSocial.status === 400, `got ${badSocial.status}`);
    const okSocial = await call('PUT', `/api/regions/${regionA.id}`, admin, { instagramUrl: 'https://instagram.com/sqa', snapchatUrl: 'https://snapchat.com/add/sqa' });
    check('PUT /regions social links → 200 + persisted', okSocial.status === 200 && okSocial.json?.data?.instagramUrl === 'https://instagram.com/sqa');
    check('PUT /regions snapchat persisted', okSocial.json?.data?.snapchatUrl === 'https://snapchat.com/add/sqa');

    // =====================================================================
    console.log('\n== B. Legal pages: auth + permission + region-scope ==');
    check('GET admin list, no token → 401', (await call('GET', `/api/legal-pages?regionId=${regionA.id}`)).status === 401);
    check('GET admin list, manager w/o REGIONS perm → 403', (await call('GET', `/api/legal-pages?regionId=${regionA.id}`, mgrNoPerm)).status === 403);
    check('GET admin list, no regionId → 400', (await call('GET', '/api/legal-pages', admin)).status === 400);
    check('GET admin list, regionId not a uuid → 400', (await call('GET', '/api/legal-pages?regionId=nope', admin)).status === 400);
    check('GET admin list, admin + region A → 200', (await call('GET', `/api/legal-pages?regionId=${regionA.id}`, admin)).status === 200);
    check('GET admin list, scoped mgr → own region 200', (await call('GET', `/api/legal-pages?regionId=${regionA.id}`, mgrRegions)).status === 200);
    check('GET admin list, scoped mgr → other region 404 (hidden)', (await call('GET', `/api/legal-pages?regionId=${regionB.id}`, mgrRegions)).status === 404);

    console.log('\n== C. Legal pages: upsert validation + sanitization ==');
    check('PUT no token → 401', (await call('PUT', `/api/legal-pages/${regionA.id}/terms`, null, { content: '<p>x</p>' })).status === 401);
    check('PUT manager w/o perm → 403', (await call('PUT', `/api/legal-pages/${regionA.id}/terms`, mgrNoPerm, { content: '<p>x</p>' })).status === 403);
    check('PUT unknown slug → 400', (await call('PUT', `/api/legal-pages/${regionA.id}/not-a-page`, admin, { content: '<p>x</p>' })).status === 400);
    const fakeRegionId = '00000000-0000-0000-0000-000000000000';
    check('PUT nonexistent region → 404', (await call('PUT', `/api/legal-pages/${fakeRegionId}/terms`, admin, { content: '<p>x</p>' })).status === 404);
    check('PUT title > 300 chars → 400', (await call('PUT', `/api/legal-pages/${regionA.id}/terms`, admin, { title: 'a'.repeat(301), content: '<p>x</p>' })).status === 400);
    check('PUT content > 300k chars → 400', (await call('PUT', `/api/legal-pages/${regionA.id}/terms`, admin, { content: 'a'.repeat(300001) })).status === 400);
    check('PUT scoped mgr other region → 404', (await call('PUT', `/api/legal-pages/${regionB.id}/terms`, mgrRegions, { content: '<p>x</p>' })).status === 404);

    const xss = '<h2>T</h2><p><b>ok</b></p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">z</a>';
    const upserted = await call('PUT', `/api/legal-pages/${regionA.id}/terms`, admin, { title: 'Terms', title_ar: 'الشروط', content: xss, content_ar: '<p>ع</p>', isPublished: true });
    check('PUT valid (admin) → 200', upserted.status === 200, `got ${upserted.status}`);
    check('stored content sanitized (no <script>)', !/script/i.test(upserted.json?.data?.content || ''), upserted.json?.data?.content);
    check('stored content sanitized (no onerror/img)', !/onerror|<img/i.test(upserted.json?.data?.content || ''));
    check('stored content keeps allowed tags (<h2>,<b>)', /<h2>/.test(upserted.json?.data?.content || '') && /<b>/.test(upserted.json?.data?.content || ''));
    check('PUT scoped mgr OWN region → 200', (await call('PUT', `/api/legal-pages/${regionA.id}/privacy`, mgrRegions, { content: '<p>priv</p>', isPublished: true })).status === 200);

    console.log('\n== D. Legal pages: public read + hidden-until-set ==');
    check('public GET (no token) published page → 200', (await call('GET', `/api/legal-pages/${TAG}_A/terms`)).status === 200);
    const pub = await call('GET', `/api/legal-pages/${TAG}_A/terms`);
    check('public payload slug is url-form "terms"', pub.json?.data?.slug === 'terms', pub.json?.data?.slug);
    check('public GET enum-form slug (TERMS) → 200', (await call('GET', `/api/legal-pages/${TAG}_A/TERMS`)).status === 200);
    check('public GET unknown slug → 404', (await call('GET', `/api/legal-pages/${TAG}_A/nope`)).status === 404);
    check('public GET unset page (refund-policy) → 404', (await call('GET', `/api/legal-pages/${TAG}_A/refund-policy`)).status === 404);
    // unpublish terms → hidden
    await call('PUT', `/api/legal-pages/${regionA.id}/terms`, admin, { content: xss, isPublished: false });
    check('public GET after unpublish → 404 (hidden)', (await call('GET', `/api/legal-pages/${TAG}_A/terms`)).status === 404);
    // publish with empty content → still hidden ("not set")
    await call('PUT', `/api/legal-pages/${regionA.id}/terms`, admin, { content: '', content_ar: '', isPublished: true });
    check('public GET published-but-empty → 404 (not set)', (await call('GET', `/api/legal-pages/${TAG}_A/terms`)).status === 404);

    console.log('\n== E. Legal pages: publishedPageSlugs on region list ==');
    regionService.invalidateCache();
    const regionsList = await call('GET', '/api/regions', admin);
    const rowA = (regionsList.json?.data ?? []).find((r) => r.id === regionA.id);
    check('region A publishedPageSlugs includes "privacy"', (rowA?.publishedPageSlugs || []).includes('privacy'), JSON.stringify(rowA?.publishedPageSlugs));
    check('region A publishedPageSlugs excludes unpublished "terms"', !(rowA?.publishedPageSlugs || []).includes('terms'));

    console.log('\n== F. Legal pages: delete ==');
    check('DELETE manager w/o perm → 403', (await call('DELETE', `/api/legal-pages/${regionA.id}/privacy`, mgrNoPerm)).status === 403);
    check('DELETE scoped mgr other region → 404', (await call('DELETE', `/api/legal-pages/${regionB.id}/privacy`, mgrRegions)).status === 404);
    check('DELETE admin existing → 200', (await call('DELETE', `/api/legal-pages/${regionA.id}/privacy`, admin)).status === 200);
    check('public GET after delete → 404', (await call('GET', `/api/legal-pages/${TAG}_A/privacy`)).status === 404);
    check('DELETE nonexistent page → 404', (await call('DELETE', `/api/legal-pages/${regionA.id}/shipping-policy`, admin)).status === 404);

    // =====================================================================
    console.log('\n== G. Branches: auth + permission + region-scope + validation ==');
    check('POST no token → 401', (await call('POST', '/api/branches', null, { regionId: regionA.id, name: 'X' })).status === 401);
    check('POST manager w/o perm → 403', (await call('POST', '/api/branches', mgrNoPerm, { regionId: regionA.id, name: 'X' })).status === 403);
    check('POST without name → 400', (await call('POST', '/api/branches', admin, { regionId: regionA.id })).status === 400);
    check('POST without regionId → 400', (await call('POST', '/api/branches', admin, { name: 'X' })).status === 400);
    check('POST unknown regionId → 400', (await call('POST', '/api/branches', admin, { regionId: fakeRegionId, name: 'X' })).status === 400);
    check('POST scoped mgr OTHER region → 403', (await call('POST', '/api/branches', mgrRegions, { regionId: regionB.id, name: 'X' })).status === 403);

    const b1 = await call('POST', '/api/branches', admin, { regionId: regionA.id, name: `${TAG} Riyadh`, name_ar: 'الرياض', hours: 'Daily 10-22', phone: '+966 5x', isActive: true });
    check('POST valid (admin) → 201', b1.status === 201, `got ${b1.status}`);
    const b2 = await call('POST', '/api/branches', mgrRegions, { regionId: regionA.id, name: `${TAG} Jeddah`, isActive: false });
    check('POST scoped mgr OWN region → 201', b2.status === 201, `got ${b2.status}`);
    check('PUT nonexistent branch → 404', (await call('PUT', `/api/branches/${fakeRegionId}`, admin, { name: 'Y' })).status === 404);
    check('PUT valid branch → 200', (await call('PUT', `/api/branches/${b1.json.data.id}`, admin, { name: `${TAG} Riyadh HQ` })).status === 200);
    check('DELETE nonexistent → 404', (await call('DELETE', `/api/branches/${fakeRegionId}`, admin)).status === 404);

    console.log('\n== H. Branches: public list active-only vs staff all ==');
    const pubBranches = await call('GET', `/api/branches?region=${TAG}_A`);
    check('public list (no token) → 200', pubBranches.status === 200);
    check('public list excludes inactive (1 active)', (pubBranches.json?.data ?? []).length === 1, `got ${(pubBranches.json?.data ?? []).length}`);
    const staffBranches = await call('GET', `/api/branches?region=${TAG}_A`, admin);
    check('staff list includes inactive (2)', (staffBranches.json?.data ?? []).length === 2, `got ${(staffBranches.json?.data ?? []).length}`);
    check('public list unknown region code → empty', (await call('GET', `/api/branches?region=${TAG}_NOPE`)).json?.data?.length === 0);
    // reorder within region A
    const reorder = await call('PATCH', '/api/branches/order', admin, { items: [{ id: b2.json.data.id, sortOrder: 0 }, { id: b1.json.data.id, sortOrder: 1 }] });
    check('PATCH reorder → 200', reorder.status === 200, `got ${reorder.status}`);
    check('DELETE branch (admin) → 200', (await call('DELETE', `/api/branches/${b1.json.data.id}`, admin)).status === 200);

    // =====================================================================
    console.log('\n== I. Cross-region isolation ==');
    check('scoped mgr list region B branches (?region=B) → empty', (await call('GET', `/api/branches?region=${TAG}_B`, mgrRegions)).json?.data?.length === 0);

    console.log('\n== J. Edge cases: inactive region + unknown code + no-region list ==');
    await call('PUT', `/api/legal-pages/${regionB.id}/terms`, admin, { content: '<p>B terms</p>', isPublished: true });
    regionService.invalidateCache();
    check('public GET active region B terms → 200', (await call('GET', `/api/legal-pages/${TAG}_B/terms`)).status === 200);
    await prisma.region.update({ where: { id: regionB.id }, data: { isActive: false } });
    regionService.invalidateCache();
    check('public GET INACTIVE region page → 404 (resolveRegion skips inactive → default)', (await call('GET', `/api/legal-pages/${TAG}_B/terms`)).status === 404);
    check('public GET unknown region code → 404 (falls back to default, which has no such page)', (await call('GET', `/api/legal-pages/${TAG}_ZZZ/terms`)).status === 404);
    check('public GET /branches without ?region → returns an array (no crash)', Array.isArray((await call('GET', '/api/branches')).json?.data));

    await cleanup();
    console.log(`\n${fail === 0 ? '✅ ALL PASSED' : `❌ ${fail} FAILED`} — ${pass} passed, ${fail} failed`);
    server && server.close();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e);
    try { await cleanup(); } catch {}
    server && server.close();
    process.exit(1);
  }
})();
