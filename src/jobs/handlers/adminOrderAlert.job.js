/**
 * order.admin-alert — notify staff (ADMIN + MANAGER) that a customer placed an order.
 *
 * Data: { orderId, orderNumber?, totalAmount?, currency?, buyerId? }
 *
 * Recipients: every active ADMIN, plus MANAGERs who hold the `ORDERS` permission AND
 * are allowed to see this order's region — an all-region manager (no ManagerRegion
 * rows) or one who manages the order's region. A region-scoped manager never gets
 * alerts (or a deep-link they'd 404 on) for another region's orders. Managers
 * without ORDERS can't open the order screen, so alerting them would be noise.
 *
 * Fans out one push.send job per recipient. These are OPERATIONAL alerts (prefKey: null)
 * so they bypass the staff member's personal customer notification preferences — an admin
 * can't accidentally silence new-order alerts by turning off their own "order updates"
 * toggle. The push carries `type: ORDER_PLACED` so the app routes admins/managers to the
 * admin order screen (it branches on the logged-in role).
 *
 * The buyer is excluded so an admin who places an order as a customer doesn't get both
 * the customer push and the staff alert.
 */

const prisma = require('../../config/db');
const { enqueueMany } = require('../queue');
const { QUEUES } = require('../queues');

function shortRef(orderId) {
  return String(orderId).slice(0, 8).toUpperCase();
}

async function handle(data) {
  const { orderId, orderNumber, totalAmount, currency = 'AED', buyerId } = data;
  if (!orderId) {
    console.warn('[jobs] order.admin-alert skipped — no orderId');
    return { enqueued: 0 };
  }
  // Prefer the human-friendly sequential number; fall back to a short id slice for any
  // legacy order placed before order numbers existed.
  const ref = orderNumber != null ? `#${orderNumber}` : `#${shortRef(orderId)}`;

  // The order's region drives which managers may be alerted. Prefer the value passed
  // in the job data; fall back to reading the order so older enqueues still scope.
  let orderRegionId = data.regionId;
  if (orderRegionId === undefined) {
    const ord = await prisma.order.findUnique({ where: { id: orderId }, select: { regionId: true } });
    orderRegionId = ord?.regionId ?? null;
  }

  // ORDERS managers who may see this region: all-region (no ManagerRegion rows) OR
  // managing the order's region. When the order has no region (legacy), only
  // all-region managers qualify (a scoped manager can't be tied to a null region).
  const managerRegionClause = orderRegionId
    ? { OR: [{ managedRegions: { none: {} } }, { managedRegions: { some: { regionId: orderRegionId } } }] }
    : { managedRegions: { none: {} } };

  const staff = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      ...(buyerId ? { id: { not: buyerId } } : {}),
      OR: [
        { role: 'ADMIN' },
        { role: 'MANAGER', managerPermissions: { has: 'ORDERS' }, ...managerRegionClause },
      ],
    },
    select: { id: true },
  });
  if (staff.length === 0) return { enqueued: 0 };

  const amount = totalAmount != null ? ` — ${Number(totalAmount)} ${currency}` : '';
  const title = 'New Order';
  const body = `Order ${ref} placed${amount}.`;

  const jobs = staff.map((u) => ({
    data: {
      userId: u.id,
      prefKey: null, // operational — always delivered to staff
      type: 'ORDER_PLACED',
      title,
      body,
      data: { type: 'ORDER_PLACED', orderId, status: 'PENDING_PAYMENT' },
    },
  }));

  const enqueued = await enqueueMany(QUEUES.PUSH_SEND, jobs);
  console.log(`[jobs] order.admin-alert order=${orderId} staff=${staff.length} enqueued=${enqueued}`);
  return { enqueued };
}

module.exports = {
  queue: QUEUES.ADMIN_ORDER_ALERT,
  handler: handle,
  // A few retries: the staff list is tiny and these alerts are operationally important.
  options: { retryLimit: 2, retryDelay: 10, retryBackoff: true },
};
