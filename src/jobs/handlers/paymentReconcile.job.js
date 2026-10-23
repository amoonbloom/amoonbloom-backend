/**
 * payment.reconcile — recover online payments whose browser callback never arrived.
 *
 * MyFatoorah and Tabby both confirm via browser redirect + webhook. If BOTH are lost
 * (customer closes mid-pay, webhook dropped), a genuinely-paid order is stranded in
 * PENDING_PAYMENT. This job re-checks pending invoices/payments with the gateway.
 *
 * Window: only orders older than MIN_AGE minutes and younger than MAX_AGE hours.
 * confirm* helpers are idempotent.
 */

const prisma = require('../../config/db');
const orderService = require('../../services/order.service');
const paymentService = require('../../services/payment.service');
const tabbyService = require('../../services/tabby.service');
const { QUEUES } = require('../queues');

async function handle() {
  const now = Date.now();
  const minAgeMs = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MIN_AGE_MIN || '15', 10)) * 60_000;
  const maxAgeMs = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || '24', 10)) * 3_600_000;
  const batch = Math.min(Math.max(parseInt(process.env.PAYMENT_RECONCILE_BATCH || '50', 10), 1), 200);

  const methods = [];
  if (paymentService.isConfigured()) methods.push('MYFATOORAH');
  if (tabbyService.isConfigured()) methods.push('TABBY');
  if (methods.length === 0) return { skipped: 'payment_not_configured' };

  const orders = await prisma.order.findMany({
    where: {
      paymentMethod: { in: methods },
      status: 'PENDING_PAYMENT',
      paymentStatus: { in: ['UNPAID', 'FAILED'] },
      paymentInvoiceId: { not: null },
      createdAt: { lte: new Date(now - minAgeMs), gte: new Date(now - maxAgeMs) },
    },
    select: {
      id: true,
      paymentInvoiceId: true,
      paymentMethod: true,
      region: { select: { code: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: batch,
  });

  let confirmed = 0;
  let stillPending = 0;
  let failed = 0;

  for (const o of orders) {
    try {
      let res;
      if (o.paymentMethod === 'TABBY') {
        res = await orderService.confirmTabbyPayment(o.paymentInvoiceId);
      } else {
        res = await orderService.confirmOrderPayment(o.paymentInvoiceId, 'InvoiceId', o.region?.code || null);
      }
      if (res.isPaid) confirmed += 1;
      else stillPending += 1;
    } catch (err) {
      failed += 1;
      console.error(`[jobs] payment.reconcile order ${o.id}:`, err.message);
    }
  }

  if (orders.length > 0) {
    console.log(
      `[jobs] payment.reconcile checked=${orders.length} confirmed=${confirmed} pending=${stillPending} failed=${failed}`
    );
  }
  return { checked: orders.length, confirmed, stillPending, failed };
}

module.exports = {
  queue: QUEUES.PAYMENT_RECONCILE,
  handler: handle,
  cron: process.env.PAYMENT_RECONCILE_CRON || '*/3 * * * *', // every 3 minutes
  options: { retryLimit: 0 }, // it re-runs on the next tick anyway
};
