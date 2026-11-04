/**
 * payment.reconcile — recover online payments whose browser callback never arrived.
 *
 * MyFatoorah and Moyasar both confirm via browser redirect + webhook. If BOTH are lost
 * (customer closes mid-pay, webhook dropped), a genuinely-paid order is stranded in
 * PENDING_PAYMENT. This job re-checks pending invoices/payments with the gateway.
 *
 * Window: only orders older than MIN_AGE minutes (so we don't fight an active checkout —
 * confirm helpers mark a not-yet-paid invoice FAILED) and younger than MAX_AGE hours
 * (old abandoned attempts are handled by order.expire-unpaid). confirm* helpers are
 * idempotent, so re-checking an already-settled order is a safe no-op.
 */

const prisma = require('../../config/db');
const orderService = require('../../services/order.service');
const paymentService = require('../../services/payment.service');
const moyasarService = require('../../services/moyasar.service');
const { QUEUES } = require('../queues');

async function handle() {
  const now = Date.now();
  const minAgeMs = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MIN_AGE_MIN || '15', 10)) * 60_000;
  const moyasarMinAgeMs =
    Math.max(1, parseInt(process.env.MOYASAR_RECONCILE_MIN_AGE_MIN || '30', 10)) * 60_000;
  const maxAgeMs = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || '24', 10)) * 3_600_000;
  const batch = Math.min(Math.max(parseInt(process.env.PAYMENT_RECONCILE_BATCH || '50', 10), 1), 200);

  const methods = [];
  if (paymentService.isConfigured()) methods.push('MYFATOORAH');
  if (moyasarService.isConfigured()) methods.push('MOYASAR');
  if (methods.length === 0) return { skipped: 'payment_not_configured' };

  const orders = await prisma.order.findMany({
    where: {
      paymentMethod: { in: methods },
      status: 'PENDING_PAYMENT',
      paymentStatus: { in: ['UNPAID', 'FAILED'] },
      paymentInvoiceId: { not: null },
      createdAt: { lte: new Date(now - Math.min(minAgeMs, moyasarMinAgeMs)), gte: new Date(now - maxAgeMs) },
    },
    select: {
      id: true,
      paymentInvoiceId: true,
      paymentMethod: true,
      createdAt: true,
      region: { select: { code: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: batch * 2, // fetch extra then filter by method-specific min age
  });

  let confirmed = 0;
  let stillPending = 0;
  let failed = 0;
  let skippedYoung = 0;
  let checked = 0;

  for (const o of orders) {
    const ageMs = now - new Date(o.createdAt).getTime();
    const needAge = o.paymentMethod === 'MOYASAR' ? moyasarMinAgeMs : minAgeMs;
    if (ageMs < needAge) {
      skippedYoung += 1;
      continue;
    }
    if (checked >= batch) break;
    checked += 1;

    try {
      let res;
      if (o.paymentMethod === 'MOYASAR') {
        // paymentInvoiceId is the Moyasar payment id (embedded) or legacy invoice id.
        res = await orderService.confirmMoyasarPayment({
          paymentId: o.paymentInvoiceId,
          orderHint: o.id,
        });
      } else {
        res = await orderService.confirmOrderPayment(
          o.paymentInvoiceId,
          'InvoiceId',
          o.region?.code || null
        );
      }
      if (res.isPaid) confirmed += 1;
      else if (
        res.status === 'Failed' ||
        res.status === 'failed' ||
        res.status === 'expired' ||
        res.status === 'canceled'
      ) {
        failed += 1;
      } else stillPending += 1;
    } catch (err) {
      failed += 1;
      console.error(`[jobs] payment.reconcile order ${o.id}:`, err.message);
    }
  }

  if (checked > 0 || skippedYoung > 0) {
    console.log(
      `[jobs] payment.reconcile checked=${checked} confirmed=${confirmed} pending=${stillPending} failed=${failed} skippedYoung=${skippedYoung}`
    );
  }
  return { checked, confirmed, stillPending, failed, skippedYoung };
}

module.exports = {
  queue: QUEUES.PAYMENT_RECONCILE,
  handler: handle,
  cron: process.env.PAYMENT_RECONCILE_CRON || '*/3 * * * *', // every 3 minutes
  options: { retryLimit: 0 }, // it re-runs on the next tick anyway
};
