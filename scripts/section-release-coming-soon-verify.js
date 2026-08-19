/**
 * Verifies the SECTION "release coming-soon" override: a product curated into a
 * PUBLISHED section flagged releaseComingSoon is sold even though its category is
 * coming-soon — it shows available + is orderable, while the category stays a teaser.
 * A DRAFT release section does NOT release. Product's OWN coming-soon still blocks.
 *
 * LOCAL test DB only; TAG-isolated + cleaned.
 *   node -r dotenv/config scripts/section-release-coming-soon-verify.js
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const categoryService = require('../src/services/category.service');
const productService = require('../src/services/product.service');
const sectionService = require('../src/services/section.service');
const cartService = require('../src/services/cart.service');
const regionService = require('../src/services/region.service');

const TAG = `SRCS_${Date.now()}`;
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); c ? pass++ : fail++; };

async function cleanup() {
  await prisma.sectionProduct.deleteMany({ where: { section: { title: { contains: TAG } } } });
  await prisma.section.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.cartItem.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.cart.deleteMany({ where: { user: { email: { contains: TAG } } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
  const regions = await prisma.region.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  if (regions.length) {
    await prisma.region.updateMany({ where: { id: { in: regions.map((r) => r.id) } }, data: { isDefault: false } });
    await prisma.region.deleteMany({ where: { id: { in: regions.map((r) => r.id) } } });
  }
  regionService.invalidateCache();
}

async function main() {
  await cleanup();
  const A = await prisma.region.create({ data: { code: `${TAG}A`, name: 'SRCS A', currency: 'AED', isActive: true, isDefault: false } });
  regionService.invalidateCache();

  // Category coming-soon in A; product in it (not individually coming-soon).
  const cat = await categoryService.createCategory({ title: `${TAG} Cat`, status: 'PUBLISHED', regionIds: [A.id], comingSoonRegionIds: [A.id] });
  const prod = await productService.createProduct({ title: `${TAG} Prod`, price: 100, quantity: 50, status: 'PUBLISHED', categoryId: cat.id, regionIds: [A.id] });
  const user = await prisma.user.create({ data: { email: `${TAG}@e.com`, role: 'CUSTOMER', status: 'ACTIVE', regionId: A.id } });

  // Baseline: cascade blocks it.
  const p0 = await productService.getProductById(prod.id, { regionId: A.id, isStaff: false });
  ok('baseline: product cascade coming-soon in A', p0.category?.comingSoon === true);
  const add0 = await cartService.addToCart(user.id, { productId: prod.id, regionId: A.id });
  ok('baseline: addToCart blocked', /coming soon/i.test(add0.error || ''), add0.error || 'no error');

  // DRAFT release section → should NOT release.
  const draftSec = await sectionService.createSection({ title: `${TAG} Draft Rel`, status: 'DRAFT', releaseComingSoon: true, productIds: [prod.id] });
  ok('section create returns releaseComingSoon', draftSec.releaseComingSoon === true);
  const addDraft = await cartService.addToCart(user.id, { productId: prod.id, regionId: A.id });
  ok('DRAFT release section does NOT release (still blocked)', /coming soon/i.test(addDraft.error || ''), addDraft.error || 'no error');

  // PUBLISH the section → now released.
  await sectionService.updateSection(draftSec.id, { status: 'PUBLISHED' });
  const p1 = await productService.getProductById(prod.id, { regionId: A.id, isStaff: false });
  ok('released: product cascade suppressed (category.comingSoon false)', p1.category?.comingSoon === false, `got ${p1.category?.comingSoon}`);
  ok('released: product does not leak sectionProducts', p1.sectionProducts === undefined);
  const add1 = await cartService.addToCart(user.id, { productId: prod.id, regionId: A.id });
  ok('released: addToCart now allowed', !add1.error && !!add1.cart, add1.error || '');

  // Category itself still coming-soon in A.
  const catA = (await categoryService.getAllCategories({ regionId: A.id, isStaff: false })).find((c) => c.id === cat.id);
  ok('category itself still coming-soon in A', catA?.comingSoon === true);

  // Product's OWN coming-soon still blocks even when released.
  const prod2 = await productService.createProduct({ title: `${TAG} Own`, price: 100, quantity: 50, status: 'PUBLISHED', categoryId: cat.id, regionIds: [A.id], comingSoonRegionIds: [A.id] });
  await sectionService.updateSection(draftSec.id, { productIds: [prod.id, prod2.id] });
  const addOwn = await cartService.addToCart(user.id, { productId: prod2.id, regionId: A.id });
  ok('released section does NOT override product-OWN coming-soon (still blocked)', /coming soon/i.test(addOwn.error || ''), addOwn.error || 'no error');

  await cleanup();
  console.log(`\n${fail === 0 ? '✅ ALL PASSED' : `❌ ${fail} FAILED`} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await cleanup(); } catch {} process.exit(1); });
