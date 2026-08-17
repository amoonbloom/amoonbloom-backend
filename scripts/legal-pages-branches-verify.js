/**
 * Verification harness for Region Content Management (workstreams A/B/C):
 *   - legalPage.service: upsert + HTML sanitization, getPublicPage "hidden until
 *     set" rules, publishedSlugMapForRegions, listForRegion, deletePage.
 *   - branch.service: CRUD, region isolation, public (active-only) list, reorder.
 *   - region.service: create a region WITHOUT the legal-citation fields (now
 *     optional) and round-trip per-region social links.
 *
 * LOCAL throwaway DB only. Creates its own TAG-prefixed regions (never touches
 * real UAE/SA) and cleans them up, so it's safe to re-run:
 *   node -r dotenv/config scripts/legal-pages-branches-verify.js
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const legalPageService = require('../src/services/legalPage.service');
const branchService = require('../src/services/branch.service');

const TAG = 'ZZLEGALTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  const regions = await prisma.region.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  const ids = regions.map((r) => r.id);
  if (ids.length) {
    await prisma.regionLegalPage.deleteMany({ where: { regionId: { in: ids } } });
    await prisma.regionBranch.deleteMany({ where: { regionId: { in: ids } } });
    // ProductRegion/CategoryRegion/SectionRegion rows cascade when the region is deleted.
    await prisma.region.updateMany({ where: { id: { in: ids } }, data: { isDefault: false } });
    await prisma.region.deleteMany({ where: { id: { in: ids } } });
  }
  regionService.invalidateCache();
}

async function main() {
  await cleanup();

  console.log('0) region.service: create region WITHOUT legal-citation fields (now optional) + social links');
  const regionA = await regionService.createRegion({
    code: `${TAG}A`,
    name: 'Legal Test Region A',
    currency: 'AED',
    instagramUrl: 'https://instagram.com/testA',
    snapchatUrl: 'https://snapchat.com/add/testA',
  });
  ok('region created without legal fields', !!regionA?.id);
  ok('social link persisted (instagram)', regionA.instagramUrl === 'https://instagram.com/testA', regionA.instagramUrl);
  ok('social link persisted (snapchat)', regionA.snapchatUrl === 'https://snapchat.com/add/testA');
  const regionB = await regionService.createRegion({ code: `${TAG}B`, name: 'Legal Test Region B', currency: 'SAR' });
  ok('second region created', !!regionB?.id);
  regionService.invalidateCache();

  console.log('\n0b) social link update round-trips');
  const updatedA = await regionService.updateRegion(regionA.id, { facebookUrl: 'https://facebook.com/testA', instagramUrl: null });
  ok('facebook set on update', updatedA.facebookUrl === 'https://facebook.com/testA');
  ok('instagram cleared on update (null)', updatedA.instagramUrl === null, String(updatedA.instagramUrl));
  regionService.invalidateCache();

  console.log('\n1) legalPage.service: upsert + sanitization');
  const dirty = '<h2>Terms</h2><p><strong>Bold</strong> <mark>hi</mark></p><script>alert(1)</script><iframe src="x"></iframe><p onclick="evil()">x</p>';
  const page = await legalPageService.upsertPage(regionA.id, 'terms', {
    title: 'Terms & Conditions',
    title_ar: 'الشروط',
    content: dirty,
    content_ar: '<p>عربي</p>',
    isPublished: true,
  });
  ok('upsert returns row', !!page?.id);
  ok('script tag stripped', !/script/i.test(page.content), page.content);
  ok('iframe stripped', !/iframe/i.test(page.content));
  ok('onclick attr stripped', !/onclick/i.test(page.content));
  ok('allowed tags kept (h2/strong/mark)', /<h2>/.test(page.content) && /<strong>/.test(page.content) && /<mark>/.test(page.content));

  console.log('\n2) getPublicPage — hidden-until-set rules');
  const pub = await legalPageService.getPublicPage(`${TAG}A`, 'terms');
  ok('published page returned by code + url slug', !!pub && pub.slug === 'terms', pub && pub.slug);
  const pubEnum = await legalPageService.getPublicPage(`${TAG}A`, 'TERMS');
  ok('accepts enum-form slug too', !!pubEnum && pubEnum.slug === 'terms');

  await legalPageService.upsertPage(regionA.id, 'privacy', { content: '<p>secret draft</p>', isPublished: false });
  const pubPriv = await legalPageService.getPublicPage(`${TAG}A`, 'privacy');
  ok('unpublished page → null (hidden)', pubPriv === null);

  await legalPageService.upsertPage(regionA.id, 'refund-policy', { title: 'Refunds', content: '', content_ar: '', isPublished: true });
  const pubRefund = await legalPageService.getPublicPage(`${TAG}A`, 'refund-policy');
  ok('published but empty content → null (not set)', pubRefund === null);

  const pubUnknown = await legalPageService.getPublicPage(`${TAG}A`, 'not-a-real-page');
  ok('unknown slug → null', pubUnknown === null);

  console.log('\n3) publishedSlugMapForRegions (footer link source)');
  const map = await legalPageService.publishedSlugMapForRegions([regionA.id, regionB.id]);
  ok('regionA lists only terms (published+content)', JSON.stringify(map[regionA.id]) === JSON.stringify(['terms']), JSON.stringify(map[regionA.id]));
  ok('regionB has no published pages', Array.isArray(map[regionB.id]) && map[regionB.id].length === 0);

  console.log('\n4) listForRegion (admin) + deletePage (revert to not-set)');
  const list = await legalPageService.listForRegion(regionA.id);
  ok('admin list returns all authored pages (3)', list.length === 3, `got ${list.length}`);
  const del = await legalPageService.deletePage(regionA.id, 'terms');
  ok('delete returns slug', del && del.slug === 'terms');
  const pubAfterDelete = await legalPageService.getPublicPage(`${TAG}A`, 'terms');
  ok('deleted page → null (hidden again)', pubAfterDelete === null);

  console.log('\n5) branch.service: CRUD + region isolation + public active-only + reorder');
  const b1 = await branchService.createBranch({ regionId: regionA.id, name: `${TAG} Downtown`, hours: 'Daily 10:00–22:00', phone: '+971 50 000 0000' });
  ok('branch created', !!b1?.id && b1.sortOrder === 0, `sortOrder=${b1 && b1.sortOrder}`);
  const b2 = await branchService.createBranch({ regionId: regionA.id, name: `${TAG} Marina` });
  ok('second branch auto-appends sortOrder', b2.sortOrder === 1, `sortOrder=${b2.sortOrder}`);
  const bInactive = await branchService.createBranch({ regionId: regionA.id, name: `${TAG} Hidden`, isActive: false });
  ok('inactive branch created', bInactive.isActive === false);

  const adminList = await branchService.listBranches({ regionId: regionA.id });
  ok('admin list returns all 3 (incl inactive)', adminList.length === 3, `got ${adminList.length}`);
  const listB = await branchService.listBranches({ regionId: regionB.id });
  ok('region isolation: regionB has 0 branches', listB.length === 0);

  const pubBranches = await branchService.listPublicBranches(`${TAG}A`);
  ok('public list excludes inactive (2)', pubBranches.length === 2, `got ${pubBranches.length}`);

  const bUpd = await branchService.updateBranch(b1.id, { name: `${TAG} Downtown Flagship`, hours_ar: 'يوميا' });
  ok('branch update applied', bUpd.name === `${TAG} Downtown Flagship` && bUpd.hours_ar === 'يوميا');

  await branchService.reorderBranches([{ id: b2.id, sortOrder: 0 }, { id: b1.id, sortOrder: 1 }]);
  const reordered = await branchService.listBranches({ regionId: regionA.id, includeInactive: false });
  ok('reorder applied (Marina first)', reordered[0].id === b2.id, reordered.map((b) => b.name).join(', '));

  const delB = await branchService.deleteBranch(b1.id);
  ok('branch deleted', !!delB);
  const afterDel = await branchService.listBranches({ regionId: regionA.id });
  ok('branch count after delete = 2', afterDel.length === 2, `got ${afterDel.length}`);

  console.log('\n6) cascade: deleting a region removes its pages + branches');
  await legalPageService.upsertPage(regionA.id, 'shipping-policy', { content: '<p>x</p>', isPublished: true });
  await prisma.region.update({ where: { id: regionA.id }, data: { isDefault: false } });
  await prisma.region.delete({ where: { id: regionA.id } });
  const orphanPages = await prisma.regionLegalPage.count({ where: { regionId: regionA.id } });
  const orphanBranches = await prisma.regionBranch.count({ where: { regionId: regionA.id } });
  ok('legal pages cascaded away', orphanPages === 0, `got ${orphanPages}`);
  ok('branches cascaded away', orphanBranches === 0, `got ${orphanBranches}`);

  await cleanup();
  console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
