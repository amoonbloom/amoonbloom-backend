/**
 * Verifies the "shipping is a FLAT, VAT-INCLUSIVE charge" rule (client requirement, mirrors the
 * live WooCommerce site): the delivery fee is NEVER taxed on top and NEVER broken out. The VAT
 * line reflects merchandise (+ cash-fee) VAT only.
 *
 * Reference scenario from the client's checkout screenshot (VAT-EXCLUSIVE region, 5%):
 *   Subtotal 449.00 · Shipment 25.00 (flat, vat inclusive) · VAT 22.45 · Total 496.45
 *
 * Pure math only (no DB) — mirrors the total/taxAmount formula in order.service.js.
 */
const assert = require('assert');
const { computeOrderVat, round2 } = require('../src/utils/vatMath');

let pass = 0;
const check = (name, actual, expected) => {
  assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
  console.log(`  ✓ ${name} = ${actual}`);
  pass++;
};

// Replicates the (post-refactor) order.service.js totals block for a single line + flat shipping.
// Shipping contributes NOTHING to taxAmount and is added to the total as-is.
function computeOrderTotals({ unitPrice, quantity, shippingAmount, vatConfig, discountAmount = 0 }) {
  const vat = computeOrderVat(
    [{ productId: 'p', categoryId: 'c', quantity, unitPrice }],
    discountAmount,
    vatConfig
  );
  const sumFeeVat = 0; // no cash arrangement in these scenarios
  const taxAmount = round2(vat.vatAmount + sumFeeVat);
  const totalAmount = round2(vat.total + shippingAmount); // NO shipping VAT added
  return { subtotal: vat.subtotal, taxAmount, totalAmount, vatApplied: vat.applied, inclusive: vat.inclusive };
}

console.log('Scenario 1 — EXCLUSIVE 5% (the client screenshot): 449 + 25 flat');
{
  const r = computeOrderTotals({
    unitPrice: 449, quantity: 1, shippingAmount: 25,
    vatConfig: { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' },
  });
  check('subtotal', r.subtotal, 449);
  check('VAT (product only, no shipping VAT)', r.taxAmount, 22.45);
  check('total (449 + 22.45 VAT + 25 flat shipping)', r.totalAmount, 496.45);
}

console.log('Scenario 2 — regression: EXCLUSIVE 5% previously ADDED 25*5%=1.25 shipping VAT');
{
  const r = computeOrderTotals({
    unitPrice: 449, quantity: 1, shippingAmount: 25,
    vatConfig: { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' },
  });
  // Old (buggy) behaviour would have been taxAmount 23.70 / total 497.70 — assert we do NOT do that.
  assert.notStrictEqual(r.taxAmount, 23.70, 'shipping VAT must NOT be folded into taxAmount');
  assert.notStrictEqual(r.totalAmount, 497.70, 'shipping VAT must NOT be added to total');
  console.log('  ✓ shipping VAT is neither in taxAmount nor total (not 23.70 / 497.70)');
  pass++;
}

console.log('Scenario 3 — INCLUSIVE 5%: 449 (VAT inside) + 25 flat');
{
  const r = computeOrderTotals({
    unitPrice: 449, quantity: 1, shippingAmount: 25,
    vatConfig: { enabled: true, ratePercent: 5, inclusive: true, appliesTo: 'ALL_PRODUCTS' },
  });
  // Extracted product VAT = 449 - 449/1.05 = 21.38 (reported), total unchanged + flat shipping.
  check('VAT extracted (product only)', r.taxAmount, 21.38);
  check('total (449 incl-VAT + 25 flat shipping, nothing added)', r.totalAmount, 474);
}

console.log('Scenario 4 — VAT disabled: 449 + 25 flat, no tax anywhere');
{
  const r = computeOrderTotals({
    unitPrice: 449, quantity: 1, shippingAmount: 25,
    vatConfig: { enabled: false, ratePercent: 0, inclusive: false, appliesTo: 'ALL_PRODUCTS' },
  });
  check('VAT', r.taxAmount, 0);
  check('total (449 + 25)', r.totalAmount, 474);
}

console.log('Scenario 5 — free delivery (shipping 0): VAT still product-only, no phantom shipping VAT');
{
  const r = computeOrderTotals({
    unitPrice: 449, quantity: 1, shippingAmount: 0,
    vatConfig: { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' },
  });
  check('VAT', r.taxAmount, 22.45);
  check('total (449 + 22.45, free shipping)', r.totalAmount, 471.45);
}

console.log(`\n✅ shipping-vat-inclusive: ${pass}/${pass} checks passed`);
