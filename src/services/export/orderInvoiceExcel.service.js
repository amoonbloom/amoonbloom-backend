/**
 * Single-order INVOICE — Excel (.xlsx) renderer. Streams one order's invoice
 * directly to the response, in English or Arabic (`lang`). Companion to the
 * client-side PDF invoice (which the frontend rasterises so Arabic shapes for
 * free); this is the spreadsheet format an admin can download from the order
 * detail page.
 *
 * Reuses the shared workbook styling (excelStyle.util / exportTheme) and
 * branding so it looks like the rest of the export system. Backend has no i18n
 * runtime, so the small label/enum dictionary lives inline here.
 */

const ExcelJS = require('exceljs');
const {
  writeTitleBlock,
  writeStyledTable,
  CURRENCY_FMT,
} = require('./excelStyle.util');
const { getBranding } = require('./branding.util');
const { PALETTE, argb } = require('./exportTheme');
const prisma = require('../../config/db');

const T = {
  en: {
    invoice: 'Invoice',
    orderDetails: 'Order Details',
    invoiceNumber: 'Invoice Number',
    orderNumber: 'Order Number',
    orderDate: 'Order Date',
    paymentMethod: 'Payment Method',
    orderStatus: 'Order Status',
    paymentStatus: 'Payment Status',
    deliveryDate: 'Delivery Date',
    customer: 'Customer',
    name: 'Name',
    phone: 'Phone',
    email: 'Email',
    address: 'Address',
    shortAddress: 'Short Address',
    item: 'Item',
    variant: 'Variant',
    unitPrice: 'Unit Price',
    qty: 'Qty',
    lineTotal: 'Line Total',
    totals: 'Totals',
    itemsSubtotal: 'Items Subtotal',
    discount: 'Discount',
    shipping: 'Shipping',
    vat: 'VAT',
    orderTotal: 'Order Total',
    free: 'Free',
    vatInclusiveNote: 'VAT Inclusive',
  },
  ar: {
    invoice: 'الفاتورة',
    orderDetails: 'تفاصيل الطلب',
    invoiceNumber: 'رقم الفاتورة',
    orderNumber: 'رقم الطلب',
    orderDate: 'تاريخ الطلب',
    paymentMethod: 'طريقة الدفع',
    orderStatus: 'حالة الطلب',
    paymentStatus: 'حالة الدفع',
    deliveryDate: 'تاريخ التسليم',
    customer: 'العميل',
    name: 'الاسم',
    phone: 'الهاتف',
    email: 'البريد الإلكتروني',
    address: 'العنوان',
    shortAddress: 'العنوان المختصر',
    item: 'المنتج',
    variant: 'الخيار',
    unitPrice: 'سعر الوحدة',
    qty: 'الكمية',
    lineTotal: 'الإجمالي',
    totals: 'الإجماليات',
    itemsSubtotal: 'إجمالي المنتجات',
    discount: 'الخصم',
    shipping: 'الشحن',
    vat: 'ضريبة القيمة المضافة',
    orderTotal: 'إجمالي الطلب',
    free: 'مجاني',
    vatInclusiveNote: 'شامل ضريبة القيمة المضافة',
  },
};

const STATUS_LABEL = {
  en: {
    PENDING_PAYMENT: 'Pending payment',
    PROCESSING: 'Processing',
    ON_HOLD: 'On hold',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
    REFUNDED: 'Refunded',
    FAILED: 'Failed',
    DRAFT: 'Draft',
  },
  ar: {
    PENDING_PAYMENT: 'بانتظار الدفع',
    PROCESSING: 'قيد المعالجة',
    ON_HOLD: 'معلّق',
    COMPLETED: 'مكتمل',
    CANCELLED: 'ملغى',
    REFUNDED: 'مسترد',
    FAILED: 'فشل',
    DRAFT: 'مسودة',
  },
};

const PAYMENT_STATUS_LABEL = {
  en: { UNPAID: 'Unpaid', PAID: 'Paid', FAILED: 'Failed' },
  ar: { UNPAID: 'غير مدفوع', PAID: 'مدفوع', FAILED: 'فشل' },
};

const PAYMENT_METHOD_LABEL = {
  en: { COD: 'Cash on Delivery', MYFATOORAH: 'Pay online (Card / Apple Pay)' },
  ar: { COD: 'الدفع عند الاستلام', MYFATOORAH: 'ادفع إلكترونيا (بطاقة / Apple Pay)' },
};

/** yyyy-mm-dd — locale-independent, unambiguous for an invoice cell. */
function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const ROW_H = 18;
const SECTION_H = 24;
const SPACER_H = 8;

/**
 * @param {import('express').Response} res
 * @param {object} order  Full order payload from orderService.getOrderById
 * @param {'en'|'ar'} lang
 * @param {string} filename
 */
async function renderOrderInvoiceExcel(res, order, lang, filename) {
  const L = T[lang] || T.en;
  const { siteName, logo } = await getBranding();
  const currency = order.currency || 'AED';

  // Contact/region info follows the ORDER's region (not the caller's), matching
  // the PDF invoice. Best-effort — a legacy order without a region still renders.
  let region = null;
  if (order.regionId) {
    try {
      region = await prisma.region.findUnique({
        where: { id: order.regionId },
        select: { code: true, name: true, name_ar: true, address: true, address_ar: true, contactEmail: true },
      });
    } catch {
      region = null;
    }
  }

  const orderRef = order.orderNumber ?? String(order.id || '').slice(0, 8);
  const addr = order.shippingAddress || {};
  const customerName = addr.fullName || order.guestName || '';
  const customerPhone = addr.phone || order.guestPhone || '';
  const customerEmail = order.guestEmail || '';
  // Area AND zone/province (e.g. "الجوهرة, Dammam") — the zone was previously
  // dropped by an `area || zone` fallback. Covers zone-based and legacy shapes.
  const addressLine = [
    addr.streetAddress,
    addr.apartment,
    addr.area,
    addr.deliveryZoneName,
    addr.city,
    addr.state,
    addr.postalCode,
    addr.country,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : p))
    .filter(Boolean)
    .join(', ');

  const subtotal =
    order.subtotalAmount ??
    (order.items || []).reduce((s, i) => s + i.price * i.quantity, 0);
  const discount = order.discountAmount || 0;
  const shipping = order.shippingAmount || 0;
  const vatAmount = order.vatAmount ?? order.taxAmount ?? 0;
  const showVat = order.vatRatePercent != null && vatAmount > 0 && !order.vatInclusive;
  const deliveryDate = order.scheduledDeliveryAt || order.estimatedDeliveryDate;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = siteName;
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(L.invoice, {
    properties: { defaultRowHeight: ROW_H },
  });
  // Fixed column widths — labels in A, values in B; the items table spans A–E.
  sheet.getColumn(1).width = 30;
  sheet.getColumn(2).width = 44;
  sheet.getColumn(3).width = 16;
  sheet.getColumn(4).width = 8;
  sheet.getColumn(5).width = 16;

  // --- Branded title band ---
  let r = writeTitleBlock(workbook, sheet, {
    siteName,
    title: L.invoice,
    generatedAt: fmtDate(new Date()),
    currency,
    filterLines: [
      `${L.orderNumber}: ${orderRef}`,
      `${L.orderDate}: ${fmtDate(order.createdAt)}`,
    ],
    logo,
    columnSpan: 5,
  });

  // --- Small local helpers that advance the row pointer `r` ---
  const sectionTitle = (text) => {
    const row = sheet.getRow(r);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold: true, size: 12, color: { argb: argb(PALETTE.brand) } };
    cell.border = { bottom: { style: 'thin', color: { argb: argb(PALETTE.border) } } };
    // Extend the underline across the label+value span for a clean section rule.
    sheet.getRow(r).getCell(2).border = { bottom: { style: 'thin', color: { argb: argb(PALETTE.border) } } };
    row.height = SECTION_H;
    r += 1;
  };
  const kv = (label, value, opts = {}) => {
    const row = sheet.getRow(r);
    const lc = row.getCell(1);
    lc.value = label;
    lc.font = { bold: !!opts.strong, color: { argb: argb(PALETTE.inkMuted) } };
    lc.alignment = { vertical: 'middle' };
    const vc = row.getCell(2);
    vc.value = value === '' || value == null ? null : value;
    vc.font = { bold: !!opts.strong, color: { argb: argb(PALETTE.ink) } };
    vc.alignment = { vertical: 'middle' };
    if (opts.numFmt) vc.numFmt = opts.numFmt;
    row.height = ROW_H;
    r += 1;
  };
  const spacer = () => {
    sheet.getRow(r).height = SPACER_H;
    r += 1;
  };

  // --- Order Details ---
  sectionTitle(L.orderDetails);
  kv(L.invoiceNumber, String(orderRef));
  kv(L.orderNumber, String(orderRef));
  kv(L.orderDate, fmtDate(order.createdAt));
  kv(L.paymentMethod, (PAYMENT_METHOD_LABEL[lang] || PAYMENT_METHOD_LABEL.en)[order.paymentMethod] || order.paymentMethod);
  kv(L.orderStatus, (STATUS_LABEL[lang] || STATUS_LABEL.en)[order.status] || order.status);
  kv(L.paymentStatus, (PAYMENT_STATUS_LABEL[lang] || PAYMENT_STATUS_LABEL.en)[order.paymentStatus] || order.paymentStatus);
  if (deliveryDate) kv(L.deliveryDate, fmtDate(deliveryDate));
  spacer();

  // --- Customer ---
  sectionTitle(L.customer);
  kv(L.name, customerName);
  if (customerPhone) kv(L.phone, customerPhone);
  if (customerEmail) kv(L.email, customerEmail);
  if (addressLine) kv(L.address, addressLine);
  // Saudi National Address short code — absent on orders placed before the field existed.
  if (addr.shortAddress) kv(L.shortAddress, addr.shortAddress);
  spacer();

  // --- Items (the one section that earns a full styled table header) ---
  const itemCols = [
    { key: 'item', header: L.item, width: 30 },
    { key: 'variant', header: L.variant, width: 22 },
    { key: 'unitPrice', header: `${L.unitPrice} (${currency})`, numFmt: CURRENCY_FMT, width: 16 },
    { key: 'qty', header: L.qty, width: 8 },
    { key: 'lineTotal', header: `${L.lineTotal} (${currency})`, numFmt: CURRENCY_FMT, width: 16 },
  ];
  const itemRows = (order.items || []).map((i) => ({
    item: (lang === 'ar' && i.product?.title_ar) ? i.product.title_ar : (i.product?.title || ''),
    variant: i.selectedOptions ? Object.values(i.selectedOptions).filter(Boolean).join(' · ') : '',
    unitPrice: i.price,
    qty: i.quantity,
    lineTotal: i.price * i.quantity,
  }));
  const itemRange = writeStyledTable(sheet, itemCols, itemRows, { startRow: r, freeze: false });
  for (let rowNum = itemRange.headerRowNumber; rowNum <= itemRange.lastDataRow; rowNum++) {
    sheet.getRow(rowNum).height = ROW_H + 2;
  }
  r = itemRange.lastDataRow + 1;
  spacer();

  // --- Totals ---
  sectionTitle(L.totals);
  kv(L.itemsSubtotal, subtotal, { numFmt: CURRENCY_FMT });
  if (discount > 0) kv(L.discount, -discount, { numFmt: CURRENCY_FMT });
  kv(shipping > 0 ? L.shipping : `${L.shipping} (${L.free})`, shipping, { numFmt: CURRENCY_FMT });
  if (showVat) kv(`${L.vat} (${order.vatRatePercent}%)`, vatAmount, { numFmt: CURRENCY_FMT });
  kv(L.orderTotal, order.totalAmount, { numFmt: CURRENCY_FMT, strong: true });
  if (order.vatInclusive) {
    const row = sheet.getRow(r);
    row.getCell(1).value = L.vatInclusiveNote;
    row.getCell(1).font = { italic: true, size: 9, color: { argb: argb(PALETTE.inkMuted) } };
    row.height = ROW_H;
    r += 1;
  }
  spacer();
  spacer();

  // --- Store contact footer (parity with the PDF footer) ---
  // The order's region address if configured, else its country name ("Saudi
  // Arabia") — never a hardcoded store default that could stamp the wrong country.
  const contactAddress =
    (lang === 'ar' && region?.address_ar) ? region.address_ar
      : region?.address
        ? region.address
        : (lang === 'ar' && region?.name_ar) ? region.name_ar : region?.name || null;
  const footer = (text, opts = {}) => {
    const row = sheet.getRow(r);
    row.getCell(1).value = text;
    row.getCell(1).font = { bold: !!opts.bold, size: 9, color: { argb: argb(PALETTE.inkMuted) } };
    row.height = ROW_H;
    r += 1;
  };
  footer(siteName, { bold: true });
  if (contactAddress) footer(contactAddress);
  if (region?.contactEmail) footer(region.contactEmail);

  // RTL sheet orientation for Arabic (headers/columns flow right-to-left).
  if (lang === 'ar') {
    sheet.views = (sheet.views && sheet.views.length ? sheet.views : [{}]).map((v) => ({
      ...v,
      rightToLeft: true,
    }));
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { renderOrderInvoiceExcel };
