/**
 * order.expire-unpaid — cancel online orders that were never paid.
 *
 * An online (MyFatoorah) order sits in PENDING_PAYMENT until payment succeeds. As of the
 * stock-reservation change (H1) it HAS reserved (deducted) stock at placement, so cancelling
 * it must RESTORE that stock. Each order is cancelled in its own row-locked transaction
 * (SELECT ... FOR UPDATE re-checks status + paymentStatus) so an order that just got paid is
 * never cancelled. No push is sent — the customer never completed checkout.
 *
 * TWO passes with different cutoffs:
 *   1. STANDARD (>= 30h): orders that MAY have a charge in flight (an invoice was raised, or the
 *      last attempt FAILED). Must stay strictly larger than PAYMENT_RECONCILE_MAX_AGE_HOURS so
 *      the reconciler always gets to confirm a stranded-but-paid order first.
 *   2. ARMED (~15m): PRE-ARMED native-Apple-Pay orders that NEVER attempted payment
 *      (paymentInvoiceId IS NULL, paymentStatus UNPAID). Pre-arming creates the order + a
 *      session the moment the customer selects Apple Pay (so the sheet is one tap), but
 *      createPaymentSession never writes paymentInvoiceId — only SendPayment / ExecutePayment
 *      do. A NULL invoice therefore means MyFatoorah never raised anything: nothing for the
 *      reconciler to rescue, so releasing stock quickly is safe.
 *
 * IMPORTANT: PENDING_PAYMENT is no longer online-only — COD orders start there too. Both passes
 * only ever touch MYFATOORAH orders, or they would auto-cancel legitimate COD orders.
 */

const prisma = require('../../config/db');
const { QUEUES } = require('../queues');

/**
 * Restore reserved stock + release promo usage for an order, then mark it CANCELLED. Runs inside
 * a caller-provided transaction that has ALREADY row-locked (FOR UPDATE) and re-verified the order.
 */
async function restoreAndCancel(tx, id, inventoryDeducted) {
  // Restore the stock reserved at placement (H1) before cancelling.
  if (inventoryDeducted) {
    await tx.$executeRaw`
      UPDATE "Product" AS p
      SET quantity = p.quantity + sub.sum_qty
      FROM (
        SELECT "productId", SUM(quantity)::int AS sum_qty
        FROM "OrderItem"
        WHERE "orderId"::text = ${id}
        GROUP BY "productId"
      ) AS sub
      WHERE p.id = sub."productId"`;
  }

  // Release any promo reservation this order held (reserved at placement, holding the global +
  // per-user caps through the unpaid window). Delete the usage row(s), then decrement each
  // affected promo's counter (floored at 0) so the code is usable again.
  const promoUsages = await tx.$queryRaw`
    SELECT "promoCodeId", COUNT(*)::int AS n
    FROM "PromoCodeUsage"
    WHERE "orderId"::text = ${id}
    GROUP BY "promoCodeId"`;
  if (Array.isArray(promoUsages) && promoUsages.length > 0) {
    await tx.$executeRaw`DELETE FROM "PromoCodeUsage" WHERE "orderId"::text = ${id}`;
    for (const row of promoUsages) {
      await tx.$executeRaw`
        UPDATE "PromoCode"
        SET "usageCount" = GREATEST(0, "usageCount" - ${row.n}), "updatedAt" = NOW()
        WHERE id::text = ${row.promoCodeId}`;
    }
  }

  await tx.order.update({
    where: { id },
    data: { status: 'CANCELLED', inventoryDeducted: false },
  });
}

/**
 * Cancel each candidate id in its own row-locked transaction. `lock(tx, id)` runs the FOR UPDATE
 * re-check and returns the locked rows (or []); the order is only cancelled while it still matches,
 * so one that got paid (or started paying) between the query and the lock is safely skipped.
 */
async function cancelEach(candidates, lock) {
  let cancelled = 0;
  for (const { id } of candidates) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        const locked = await lock(tx, id);
        if (!Array.isArray(locked) || locked.length === 0) return false;
        await restoreAndCancel(tx, id, locked[0].inventoryDeducted);
        return true;
      });
      if (done) cancelled += 1;
    } catch (err) {
      console.error(`[jobs] order.expire-unpaid failed to cancel order ${id}: ${err.message}`);
    }
  }
  return cancelled;
}

async function handle() {
  // ---- Pass 1: STANDARD window (>= 30h) — may have a charge in flight. ----
  const reconcileMaxAge = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || '24', 10));
  const configured = Math.max(1, parseInt(process.env.ORDER_EXPIRE_HOURS || '48', 10));
  const hours = Math.max(configured, reconcileMaxAge + 6);
  const cutoff = new Date(Date.now() - hours * 3_600_000);

  const stale = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      paymentMethod: 'MYFATOORAH',
      paymentStatus: { in: ['UNPAID', 'FAILED'] },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });
  const standardCancelled = await cancelEach(stale, (tx, id) => tx.$queryRaw`
    SELECT id, "inventoryDeducted" FROM "Order"
    WHERE id::text = ${id}
      AND status = 'PENDING_PAYMENT'
      AND "paymentMethod" = 'MYFATOORAH'
      AND "paymentStatus" IN ('UNPAID', 'FAILED')
    FOR UPDATE`);

  // ---- Pass 2: ARMED window (~15m) — pre-armed orders that NEVER attempted payment. ----
  // paymentStatus deliberately UNPAID only (NOT FAILED — a failure means an attempt happened),
  // and paymentInvoiceId IS NULL (never invoiced). Re-checked under FOR UPDATE so an order that
  // starts paying between the query and the lock is skipped.
  const armedMins = Math.max(5, parseInt(process.env.ORDER_ARMED_EXPIRE_MINUTES || '15', 10));
  const armedCutoff = new Date(Date.now() - armedMins * 60_000);

  const armed = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      paymentMethod: 'MYFATOORAH',
      paymentStatus: 'UNPAID',
      paymentInvoiceId: null,
      createdAt: { lt: armedCutoff },
    },
    select: { id: true },
  });
  const armedCancelled = await cancelEach(armed, (tx, id) => tx.$queryRaw`
    SELECT id, "inventoryDeducted" FROM "Order"
    WHERE id::text = ${id}
      AND status = 'PENDING_PAYMENT'
      AND "paymentMethod" = 'MYFATOORAH'
      AND "paymentStatus" = 'UNPAID'
      AND "paymentInvoiceId" IS NULL
    FOR UPDATE`);

  const cancelled = standardCancelled + armedCancelled;
  if (cancelled > 0) {
    console.log(`[jobs] order.expire-unpaid cancelled=${cancelled} (standard=${standardCancelled}, armed=${armedCancelled})`);
  }
  return { cancelled, standard: standardCancelled, armed: armedCancelled };
}

module.exports = {
  queue: QUEUES.ORDER_EXPIRE_UNPAID,
  handler: handle,
  cron: process.env.ORDER_EXPIRE_CRON || '*/15 * * * *', // every 15 minutes
  options: { retryLimit: 0 },
};
