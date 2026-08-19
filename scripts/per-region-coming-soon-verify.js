/**
 * Verifies PER-REGION "coming soon" for categories + products:
 *  - a category/product can be a teaser in region A but live in region B,
 *  - storefront reads resolve the requesting region's flag (+ category cascade onto
 *    products), staff reads expose comingSoonRegionIds,
 *  - a NEW region defaults to available,
 *  - addToCart enforcement is region-aware (blocked in A, allowed in B).
 *
 * LOCAL test DB only; TAG-isolated + cleaned.
 *   node -r dotenv/config scripts/per-region-coming-soon-verify.js
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const categoryService = require('../src/services/category.service');
const productService = require('../src/services/product.service');
const cartService = require('../src/services/cart.service');
const regionService = require('../src/services/region.service');

const TAG = `PRCS_${Date.now()}`;
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); c ? pass++ : fail++; };

async function cleanup() {
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
  const A = await prisma.region.create({ data: { code: `${TAG}A`, name: 'PRCS A', currency: 'AED', isActive: true, isDefault: false } });
  const B = await prisma.region.create({ data: { code: `${TAG}B`, name: 'PRCS B', currency: 'SAR', isActive: true, isDefault: false } });
  regionService.invalidateCache();

  // ---- Category coming-soon in A only ----
  const cat = await categoryService.createCategory({
    title: `${TAG} Flowers`, status: 'PUBLISHED', regionIds: [A.id, B.id], comingSoonRegionIds: [A.id],
  });
  ok('category staff comingSoonRegionIds = [A]', Array.isArray(cat.comingSoonRegionIds) && cat.comingSoonRegionIds.length === 1 && cat.comingSoonRegionIds[0] === A.id, JSON.stringify(cat.comingSoonRegionIds));
  ok('category global mirror comingSoon = true (any region)', cat.comingSoon === true);

  const catA = (await categoryService.getAllCategories({ regionId: A.id, isStaff: false })).find((c) => c.id === cat.id);
  const catB = (await categoryService.getAllCategories({ regionId: B.id, isStaff: false })).find((c) => c.id === cat.id);
  ok('storefront category in A → comingSoon true', catA?.comingSoon === true);
  ok('storefront category in B → comingSoon false (new-region default / not set)', catB?.comingSoon === false, `got ${catB?.comingSoon}`);

  // ---- Product in that category, NOT individually coming-soon → cascade only ----
  const prod = await productService.createProduct({
    title: `${TAG} Rose Box`, price: 100, quantity: 50, status: 'PUBLISHED',
    categoryId: cat.id, regionIds: [A.id, B.id],
  });
  const pA = await productService.getProductById(prod.id, { regionId: A.id, isStaff: false });
  const pB = await productService.getProductById(prod.id, { regionId: B.id, isStaff: false });
  ok('storefront product own comingSoon false in A', pA.comingSoon === false);
  ok('cascade: product.category.comingSoon true in A', pA.category?.comingSoon === true, `got ${pA.category?.comingSoon}`);
  ok('cascade: product.category.comingSoon false in B', pB.category?.comingSoon === false, `got ${pB.category?.comingSoon}`);
  ok('storefront product does NOT leak category.regions', pA.category?.regions === undefined);

  // ---- addToCart enforcement region-aware (cascade) ----
  const user = await prisma.user.create({ data: { email: `${TAG}@e.com`, role: 'CUSTOMER', status: 'ACTIVE', regionId: B.id } });
  const addB = await cartService.addToCart(user.id, { productId: prod.id, regionId: B.id });
  ok('addToCart in B (category live there) → allowed', !addB.error && !!addB.cart, addB.error || '');
  const addA = await cartService.addToCart(user.id, { productId: prod.id, regionId: A.id });
  ok('addToCart in A (category teaser there) → blocked', /coming soon/i.test(addA.error || ''), addA.error || 'no error');

  // ---- Product INDIVIDUALLY coming-soon in A only ----
  const prod2 = await productService.createProduct({
    title: `${TAG} Solo`, price: 100, quantity: 50, status: 'PUBLISHED',
    regionIds: [A.id, B.id], comingSoonRegionIds: [A.id],
  });
  const staff2 = await productService.getProductById(prod2.id, { isStaff: true });
  ok('product staff comingSoonRegionIds = [A]', (staff2.comingSoonRegionIds || []).length === 1 && staff2.comingSoonRegionIds[0] === A.id, JSON.stringify(staff2.comingSoonRegionIds));
  const p2A = await productService.getProductById(prod2.id, { regionId: A.id, isStaff: false });
  const p2B = await productService.getProductById(prod2.id, { regionId: B.id, isStaff: false });
  ok('product own comingSoon true in A', p2A.comingSoon === true, `got ${p2A.comingSoon}`);
  ok('product own comingSoon false in B', p2B.comingSoon === false, `got ${p2B.comingSoon}`);
  const add2B = await cartService.addToCart(user.id, { productId: prod2.id, regionId: B.id });
  ok('addToCart prod2 in B → allowed', !add2B.error, add2B.error || '');
  const add2A = await cartService.addToCart(user.id, { productId: prod2.id, regionId: A.id });
  ok('addToCart prod2 in A → blocked', /coming soon/i.test(add2A.error || ''), add2A.error || 'no error');

  // ---- Update: turn OFF coming-soon for A ----
  await categoryService.updateCategory(cat.id, { comingSoonRegionIds: [] });
  const catA2 = (await categoryService.getAllCategories({ regionId: A.id, isStaff: false })).find((c) => c.id === cat.id);
  ok('after update []: storefront category in A → comingSoon false', catA2?.comingSoon === false, `got ${catA2?.comingSoon}`);
  const addA2 = await cartService.addToCart(user.id, { productId: prod.id, regionId: A.id });
  ok('after update: addToCart prod in A now allowed', !addA2.error, addA2.error || '');

  await cleanup();
  console.log(`\n${fail === 0 ? '✅ ALL PASSED' : `❌ ${fail} FAILED`} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await cleanup(); } catch {} process.exit(1); });
