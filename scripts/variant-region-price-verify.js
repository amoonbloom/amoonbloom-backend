/**
 * Verifies per-region VARIANT pricing end to end:
 *  - createProduct/updateProduct persist variants[].regionPrices (filtered to the
 *    product's own regions),
 *  - staff read exposes each variant's regionPrices (edit form),
 *  - storefront read overlays the requesting region's variant price + priceRange,
 *  - resolveEffectivePrice (the shared cart/order/promo resolver) charges the
 *    region's variant price, base otherwise,
 *  - discount>price and out-of-region overrides are rejected/dropped.
 *
 * LOCAL test DB only; TAG-isolated + cleaned. Uses real service functions + the
 * exact money-path include shape cart/order use.
 *   node -r dotenv/config scripts/variant-region-price-verify.js
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const productService = require('../src/services/product.service');
const regionService = require('../src/services/region.service');

const TAG = `VRP_${Date.now()}`;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  cond ? pass++ : fail++;
};

// Exact variant include cart.service / order.service use for the money path.
const moneyInclude = {
  productOptions: { orderBy: { sortOrder: 'asc' } },
  variants: {
    orderBy: { sortOrder: 'asc' },
    include: { regionPrices: { select: { regionId: true, price: true, discountedPrice: true } } },
  },
};

async function cleanup() {
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  const regions = await prisma.region.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  if (regions.length) {
    await prisma.region.updateMany({ where: { id: { in: regions.map((r) => r.id) } }, data: { isDefault: false } });
    await prisma.region.deleteMany({ where: { id: { in: regions.map((r) => r.id) } } });
  }
  regionService.invalidateCache();
}

async function main() {
  await cleanup();
  const A = await prisma.region.create({ data: { code: `${TAG}A`, name: 'VRP A', currency: 'AED', isActive: true, isDefault: false } });
  const B = await prisma.region.create({ data: { code: `${TAG}B`, name: 'VRP B', currency: 'SAR', isActive: true, isDefault: false } });
  const C = await prisma.region.create({ data: { code: `${TAG}C`, name: 'VRP C', currency: 'KWD', isActive: true, isDefault: false } });
  regionService.invalidateCache();

  // ---- create: variants with a region-B override; a region-C override that must be
  //      dropped because the product is NOT sold in C. ----
  const created = await productService.createProduct({
    title: `${TAG} Bouquet`,
    price: 100,
    status: 'PUBLISHED',
    regionIds: [A.id, B.id],
    productOptions: [{ title: 'Size', options: ['Small', 'Large'], isVariantAxis: true }],
    variants: [
      { optionValue: 'Small', price: 100, isDefault: true, regionPrices: [{ regionId: B.id, price: 150 }, { regionId: C.id, price: 999 }] },
      { optionValue: 'Large', price: 200, regionPrices: [{ regionId: B.id, price: 280, discountedPrice: 250 }] },
    ],
  });
  ok('product created with variants', Array.isArray(created?.variants) && created.variants.length === 2);

  // ---- staff read exposes per-variant regionPrices, C dropped (out of region) ----
  const staff = await productService.getProductById(created.id, { isStaff: true });
  const small = staff.variants.find((v) => v.optionValue === 'Small');
  const large = staff.variants.find((v) => v.optionValue === 'Large');
  ok('staff: Small exposes regionPrices', Array.isArray(small.regionPrices));
  ok('staff: Small has B override 150', small.regionPrices.some((r) => r.regionId === B.id && Number(r.price) === 150));
  ok('staff: out-of-region C override was DROPPED', !small.regionPrices.some((r) => r.regionId === C.id), JSON.stringify(small.regionPrices));
  ok('staff: Large B override 280/250', large.regionPrices.some((r) => r.regionId === B.id && Number(r.price) === 280 && Number(r.discountedPrice) === 250));

  // ---- storefront read region B: variant prices overlaid + priceRange region-aware ----
  const sfB = await productService.getProductById(created.id, { regionId: B.id, isStaff: false });
  const sfBSmall = sfB.variants.find((v) => v.optionValue === 'Small');
  const sfBLarge = sfB.variants.find((v) => v.optionValue === 'Large');
  ok('storefront B: Small price overlaid to 150', Number(sfBSmall.price) === 150, `got ${sfBSmall.price}`);
  ok('storefront B: does NOT leak regionPrices', sfBSmall.regionPrices === undefined);
  ok('storefront B: Large price 280 / discounted 250', Number(sfBLarge.price) === 280 && Number(sfBLarge.discountedPrice) === 250);
  ok('storefront B: priceRange min=150 (region-aware)', sfB.priceRange && Number(sfB.priceRange.min) === 150, JSON.stringify(sfB.priceRange));

  // ---- storefront read region A (no overrides): base prices ----
  const sfA = await productService.getProductById(created.id, { regionId: A.id, isStaff: false });
  const sfASmall = sfA.variants.find((v) => v.optionValue === 'Small');
  ok('storefront A: Small stays base 100', Number(sfASmall.price) === 100, `got ${sfASmall.price}`);
  ok('storefront A: priceRange min=100', sfA.priceRange && Number(sfA.priceRange.min) === 100);

  // ---- resolveEffectivePrice (the shared cart/order/promo resolver) ----
  const row = await prisma.product.findUnique({ where: { id: created.id }, include: moneyInclude });
  ok('resolve B default(Small) = 150', productService.resolveEffectivePrice(row, null, B.id) === 150);
  ok('resolve A default(Small) = 100 (no override)', productService.resolveEffectivePrice(row, null, A.id) === 100);
  ok('resolve no-region default = 100 (base)', productService.resolveEffectivePrice(row, null, null) === 100);
  ok('resolve B Large = 250 (discounted override)', productService.resolveEffectivePrice(row, { Size: 'Large' }, B.id) === 250);
  ok('resolve A Large = 200 (base)', productService.resolveEffectivePrice(row, { Size: 'Large' }, A.id) === 200);

  // ---- update: change region-B Small price, remove Large override ----
  await productService.updateProduct(created.id, {
    regionIds: [A.id, B.id],
    productOptions: [{ title: 'Size', options: ['Small', 'Large'], isVariantAxis: true }],
    variants: [
      { optionValue: 'Small', price: 100, isDefault: true, regionPrices: [{ regionId: B.id, price: 175 }] },
      { optionValue: 'Large', price: 200, regionPrices: [] },
    ],
  });
  const row2 = await prisma.product.findUnique({ where: { id: created.id }, include: moneyInclude });
  ok('update: B Small now 175', productService.resolveEffectivePrice(row2, null, B.id) === 175);
  ok('update: B Large override removed → base 200', productService.resolveEffectivePrice(row2, { Size: 'Large' }, B.id) === 200);

  // ---- validation: discount > price rejected ----
  let threw = false;
  try {
    await productService.createProduct({
      title: `${TAG} Bad`, price: 100, status: 'DRAFT', regionIds: [A.id, B.id],
      productOptions: [{ title: 'Size', options: ['Small'], isVariantAxis: true }],
      variants: [{ optionValue: 'Small', price: 100, isDefault: true, regionPrices: [{ regionId: B.id, price: 100, discountedPrice: 150 }] }],
    });
  } catch (e) { threw = e.code === 'INVALID_PRICE'; }
  ok('validation: variant region discount>price rejected', threw);

  await cleanup();
  console.log(`\n${fail === 0 ? '✅ ALL PASSED' : `❌ ${fail} FAILED`} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await cleanup(); } catch {} process.exit(1); });
