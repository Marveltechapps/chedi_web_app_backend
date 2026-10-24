const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { ok } = require('../../lib/response');
const { requireStaff, requireModule, isLegacyAdminKey, looksLikeJwt, bearerToken } = require('../../middleware/staffAuth');
const { withIdempotency } = require('../../lib/idempotency');
const dashboard = require('../../lib/admin/dashboard.service');
const members = require('../../lib/admin/members.service');
const payments = require('../../lib/admin/payments.service');
const subscriptions = require('../../lib/admin/subscriptions.service');
const plots = require('../../lib/admin/plots.service');
const crops = require('../../lib/admin/crops.service');
const baskets = require('../../lib/admin/baskets.service');
const deliveries = require('../../lib/admin/deliveries.service');
const cancellations = require('../../lib/admin/cancellations.service');
const notifications = require('../../lib/admin/notifications.service');
const tickets = require('../../lib/admin/tickets.service');
const reports = require('../../lib/admin/reports.service');
const staffAccounts = require('../../lib/admin/staff.service');
const { listAdminPayments } = require('../../lib/payments');
const realtime = require('../../lib/realtime');

const router = express.Router();

router.use(require('./auth'));

function requireStaffExceptLegacy(req, res, next) {
  if (isLegacyAdminKey(req) && !looksLikeJwt(bearerToken(req))) {
    req.legacyAdmin = true;
    req.admin = { role: 'admin' };
    req.staff = { id: 'admin', name: 'Admin', role: 'super_admin', roleLabel: 'Super Admin', initial: 'A' };
    req.staffDoc = { id: 'admin', name: 'Admin', role: 'super_admin' };
    return next();
  }
  return requireStaff(req, res, next);
}

router.use((req, res, next) => {
  if (req.method === 'POST' && ['/login', '/refresh', '/logout'].includes(req.path)) {
    return next();
  }
  return requireStaffExceptLegacy(req, res, next);
});

router.get(
  '/dashboard',
  requireModule('dashboard'),
  asyncHandler(async (req, res) => {
    ok(res, await dashboard.getDashboard());
  })
);

router.get(
  '/members',
  requireModule('members'),
  asyncHandler(async (req, res) => {
    const result = await members.listMembers(req.query);
    ok(res, result.data, { pagination: result.pagination, meta: result.meta });
  })
);

router.get(
  '/members/:memberId',
  requireModule('members'),
  asyncHandler(async (req, res) => {
    ok(res, await members.getMemberDrawer(req.params.memberId));
  })
);

router.post(
  '/members',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const result = await withIdempotency(req, 'admin_create_member', async () => {
      const body = await members.createMember(req.body || {}, req.staff);
      return { status: 201, body, message: 'Member created' };
    });
    if (!result.replay) {
      await realtime.emitSafe(
        realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_CREATED, result.body?.id, { member: result.body })
      );
    }
    ok(res, result.body, { status: result.status, message: result.message });
  })
);

router.delete(
  '/members/:memberId',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.deleteMember(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_DELETED, data.id, {
        member: { id: data.id, memberCode: data.memberCode, deleted: true },
      })
    );
    ok(res, data, { message: 'Member deleted' });
  })
);

router.post(
  '/members/:memberId/activate',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.activateMember(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, data.id, { member: data })
    );
    ok(res, data, { message: 'Member activated' });
  })
);

router.post(
  '/members/:memberId/suspend',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.suspendMember(req.params.memberId, req.staff, req.body?.reason);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, data.id, { member: data })
    );
    ok(res, data, { message: 'Member suspended' });
  })
);

router.post(
  '/members/:memberId/reactivate',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.reactivateMember(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, data.id, { member: data })
    );
    ok(res, data, { message: 'Member reactivated' });
  })
);

router.post(
  '/members/:memberId/cancel',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.cancelMember(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, data.id, { member: data })
    );
    ok(res, data, { message: 'Membership cancelled' });
  })
);

router.patch(
  '/members/:memberId',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.patchMember(req.params.memberId, req.body || {}, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_PROFILE_UPDATED, data.id, { member: data })
    );
    ok(res, data);
  })
);

router.post(
  '/members/:memberId/plan',
  requireModule('members', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await members.changePlan(req.params.memberId, req.body?.planKey, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, data.id, { member: data })
    );
    ok(res, data, { message: 'Plan updated' });
  })
);

router.get(
  '/payments',
  requireModule('payments'),
  asyncHandler(async (req, res) => {
    if (req.legacyAdmin) {
      const items = await listAdminPayments({ status: req.query.status || 'pending' });
      return res.json({ items, count: items.length });
    }
    const result = await payments.listPayments(req.query);
    ok(res, result.data, { pagination: result.pagination, meta: result.meta });
  })
);

router.get(
  '/payments/:paymentId/receipt',
  requireModule('payments'),
  asyncHandler(async (req, res) => {
    ok(res, await payments.getReceipt(req.params.paymentId));
  })
);

router.get(
  '/payments/:paymentId',
  requireModule('payments'),
  asyncHandler(async (req, res) => {
    ok(res, await payments.getPayment(req.params.paymentId));
  })
);

router.post(
  '/payments',
  requireModule('payments', { write: true }),
  asyncHandler(async (req, res) => {
    const result = await withIdempotency(req, 'admin_create_payment', async () => {
      const body = await payments.createAdminPayment(req.body || {}, req.staff);
      return { status: 200, body: { success: true, data: body.payment } };
    });
    if (result.body?.success) {
      await realtime.emitSafe(
        realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_CREATED, {
          payment: result.body.data,
          memberId: result.body.data?.memberId,
        })
      );
    }
    res.status(result.status).json(result.body);
  })
);

router.post(
  '/payments/:paymentId/mark-paid',
  requireModule('payments', { write: true }),
  asyncHandler(async (req, res) => {
    const result = await withIdempotency(req, 'admin_mark_paid', async () => {
      const body = await payments.markPaid(req.params.paymentId, req.body || {}, req.staff);
      return { status: 200, body: { success: true, message: 'Payment marked paid', data: body } };
    });
    if (result.body?.success) {
      await realtime.emitSafe(
        realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_UPDATED, {
          payment: result.body.data?.payment || result.body.data,
          memberId: result.body.data?.payment?.memberId || result.body.data?.memberId,
        })
      );
    }
    res.status(result.status).json(result.body);
  })
);

router.post(
  '/payments/:paymentId/reject',
  requireModule('payments', { write: true }),
  asyncHandler(async (req, res) => {
    if (req.legacyAdmin) {
      const { rejectPayment } = require('../../lib/payments');
      const result = await rejectPayment(req.params.paymentId, {
        rejectedBy: req.body?.rejectedBy || 'admin',
        adminNote: req.body?.adminNote || '',
      });
      return res.json({ ok: true, ...result });
    }
    const data = await payments.rejectAdminPayment(req.params.paymentId, req.body || {}, req.staff);
    await realtime.emitSafe(
      realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_UPDATED, {
        payment: data.payment || data,
        memberId: data.payment?.memberId || data.memberId,
      })
    );
    ok(res, data, {
      message: 'Payment request cancelled',
    });
  })
);

router.post(
  '/payments/:paymentId/remind',
  requireModule('payments', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await payments.remindPayment(req.params.paymentId, req.staff);
    await realtime.emitSafe(
      realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_UPDATED, {
        payment: data.payment || data,
        memberId: data.payment?.memberId || data.memberId,
      })
    );
    ok(res, data, { message: 'Reminder sent' });
  })
);

router.get(
  '/subscriptions',
  requireModule('subscriptions'),
  asyncHandler(async (req, res) => {
    const result = await subscriptions.listSubscriptions(req.query);
    ok(res, result.data, { pagination: result.pagination, meta: result.meta });
  })
);

router.post(
  '/subscriptions/:memberId/activate',
  requireModule('subscriptions', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await subscriptions.activateSubscription(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifySubscriptionChange(realtime.EVENTS.SUBSCRIPTION_UPDATED, {
        memberId: data.memberId || data.id || req.params.memberId,
        subscription: data.subscription || data,
        member: data.id ? data : data.member,
      })
    );
    ok(res, data);
  })
);

router.post(
  '/subscriptions/:memberId/pause',
  requireModule('subscriptions', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await subscriptions.pauseSubscription(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifySubscriptionChange(realtime.EVENTS.SUBSCRIPTION_UPDATED, {
        memberId: data.memberId || data.id || req.params.memberId,
        subscription: data.subscription || data,
        member: data.id ? data : data.member,
      })
    );
    ok(res, data);
  })
);

router.post(
  '/subscriptions/:memberId/resume',
  requireModule('subscriptions', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await subscriptions.resumeSubscription(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifySubscriptionChange(realtime.EVENTS.SUBSCRIPTION_UPDATED, {
        memberId: data.memberId || data.id || req.params.memberId,
        subscription: data.subscription || data,
        member: data.id ? data : data.member,
      })
    );
    ok(res, data);
  })
);

router.post(
  '/subscriptions/:memberId/renewal-bill',
  requireModule('subscriptions', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await subscriptions.generateRenewalBill(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_CREATED, {
        payment: data.payment || data,
        memberId: data.payment?.memberId || data.memberId || req.params.memberId,
      })
    );
    ok(res, data);
  })
);

router.post(
  '/subscriptions/:memberId/renewal-remind',
  requireModule('subscriptions', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await subscriptions.remindRenewal(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, req.params.memberId, {
        member: data.id ? data : data.member,
      })
    );
    ok(res, data, { message: 'Reminder sent' });
  })
);

router.post(
  '/subscriptions/:memberId/cancel',
  requireModule('subscriptions', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await subscriptions.cancelSubscription(req.params.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifySubscriptionChange(realtime.EVENTS.SUBSCRIPTION_UPDATED, {
        memberId: data.memberId || data.id || req.params.memberId,
        subscription: data.subscription || data,
        member: data.id ? data : data.member,
      })
    );
    ok(res, data);
  })
);

router.get(
  '/farms',
  requireModule('plots'),
  asyncHandler(async (req, res) => {
    ok(res, await plots.listFarms());
  })
);

router.post(
  '/farms',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await plots.createFarm(req.body || {}, req.staff), { status: 201, message: 'Farm created' });
  })
);

router.patch(
  '/farms/:farmId',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await plots.updateFarm(req.params.farmId, req.body || {}, req.staff), { message: 'Farm updated' });
  })
);

router.delete(
  '/farms/:farmId',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await plots.deleteFarm(req.params.farmId, req.staff), { message: 'Farm deleted' });
  })
);

router.get(
  '/plots',
  requireModule('plots'),
  asyncHandler(async (req, res) => {
    const result = await plots.listPlots(req.query);
    ok(res, result.data, { pagination: result.pagination, meta: result.meta });
  })
);

router.post(
  '/plots',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.createPlot(req.body || {}, req.staff);
    await realtime.emitSafe(realtime.notifyPlotChange({ plot: data, memberId: data.memberId }));
    ok(res, data, { status: 201, message: 'Plot created' });
  })
);

router.get(
  '/plots/:plotKey',
  requireModule('plots'),
  asyncHandler(async (req, res) => {
    ok(res, await plots.getPlot(req.params.plotKey));
  })
);

router.post(
  '/plots/:plotKey/assign',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.assignPlot(req.params.plotKey, req.body?.memberId, req.staff);
    await realtime.emitSafe(
      realtime.notifyPlotChange({ plot: data, memberId: data.memberId || req.body?.memberId })
    );
    ok(res, data, { message: 'Plot assigned' });
  })
);

router.post(
  '/plots/:plotKey/unassign',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.unassignPlot(req.params.plotKey, req.staff);
    await realtime.emitSafe(realtime.notifyPlotChange({ plot: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.patch(
  '/plots/:plotKey',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.patchPlot(req.params.plotKey, req.body || {}, req.staff);
    await realtime.emitSafe(realtime.notifyPlotChange({ plot: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.delete(
  '/plots/:plotKey',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.deletePlot(req.params.plotKey, req.staff);
    await realtime.emitSafe(realtime.notifyPlotChange({ plot: data }));
    ok(res, data, { message: 'Plot deleted' });
  })
);

router.post(
  '/plots/:plotKey/images',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.addPlotImage(req.params.plotKey, req.body || {}, req.staff);
    await realtime.emitSafe(realtime.notifyPlotChange({ plot: data, memberId: data.memberId }));
    ok(res, data, { status: 201, message: 'Image added' });
  })
);

async function removePlotImageRoute(req, res) {
  const imageUrl = req.body?.imageUrl || req.query?.imageUrl;
  const data = await plots.removePlotImage(req.params.plotKey, imageUrl, req.staff);
  await realtime.emitSafe(realtime.notifyPlotChange({ plot: data, memberId: data.memberId }));
  ok(res, data, { message: 'Image removed' });
}

router.post(
  '/plots/:plotKey/images/remove',
  requireModule('plots', { write: true }),
  asyncHandler(removePlotImageRoute)
);

router.delete(
  '/plots/:plotKey/images',
  requireModule('plots', { write: true }),
  asyncHandler(removePlotImageRoute)
);

router.post(
  '/plots/:plotKey/notify-open',
  requireModule('plots', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await plots.notifyPlotOpen(req.params.plotKey, req.staff);
    await realtime.emitSafe(realtime.notifyPlotChange({ plot: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.get(
  '/crops',
  requireModule('crops'),
  asyncHandler(async (req, res) => {
    ok(res, await crops.listCrops());
  })
);

router.post(
  '/crops',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.createCrop(req.body || {}, req.staff);
    await realtime.emitSafe(realtime.notifyCropChange({ crop: data }));
    ok(res, data, { status: 201 });
  })
);

router.patch(
  '/crops/:key',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.updateCrop(req.params.key, req.body || {}, req.staff);
    await realtime.emitSafe(realtime.notifyCropChange({ crop: data }));
    ok(res, data);
  })
);

router.delete(
  '/crops/:key',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.deleteCrop(req.params.key, req.staff);
    await realtime.emitSafe(realtime.notifyCropChange({ crop: data }));
    ok(res, data, { message: 'Crop deleted' });
  })
);

router.get(
  '/cultivations',
  requireModule('crops'),
  asyncHandler(async (req, res) => {
    const result = await crops.listCultivations();
    ok(res, result.data, { meta: result.meta });
  })
);

router.post(
  '/plots/:plotKey/crop',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.assignCrop(req.params.plotKey, req.body || {}, req.staff);
    await realtime.emitSafe(
      realtime.notifyCropChange({ crop: data, memberId: data.memberId, plot: data })
    );
    ok(res, data);
  })
);

router.post(
  '/plots/:plotKey/advance-stage',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.advanceStage(req.params.plotKey, req.staff);
    await realtime.emitSafe(
      realtime.notifyCropChange({ crop: data, memberId: data.memberId, plot: data })
    );
    ok(res, data);
  })
);

router.patch(
  '/plots/:plotKey/yield',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.patchYield(req.params.plotKey, req.body || {});
    await realtime.emitSafe(
      realtime.notifyCropChange({ crop: data, memberId: data.memberId, plot: data })
    );
    ok(res, data);
  })
);

router.delete(
  '/plots/:plotKey/crop',
  requireModule('crops', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await crops.removeCultivation(req.params.plotKey, req.staff);
    await realtime.emitSafe(realtime.notifyCropChange({ crop: data, plot: data }));
    ok(res, data, { message: 'Harvest removed' });
  })
);

router.get(
  '/baskets',
  requireModule('baskets'),
  asyncHandler(async (req, res) => {
    ok(res, await baskets.listBaskets());
  })
);

router.post(
  '/baskets/advance',
  requireModule('baskets', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await baskets.advanceBasket(req.staff);
    await realtime.emitSafe(realtime.notifyBasketChange({ basket: data.current || data }));
    ok(res, data);
  })
);

router.post(
  '/baskets/items',
  requireModule('baskets', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await baskets.addBasketItem(req.body || {}, req.staff);
    await realtime.emitSafe(realtime.notifyBasketChange({ basket: data.current || data }));
    ok(res, data);
  })
);

router.patch(
  '/baskets/:basketId/items',
  requireModule('baskets', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await baskets.replaceBasketItems(req.params.basketId, req.body?.items || req.body, req.staff);
    await realtime.emitSafe(realtime.notifyBasketChange({ basket: data.current || data }));
    ok(res, data);
  })
);

router.post(
  '/baskets/duplicate',
  requireModule('baskets', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await baskets.duplicateBasket(req.staff);
    await realtime.emitSafe(realtime.notifyBasketChange({ basket: data.current || data }));
    ok(res, data);
  })
);

router.get(
  '/deliveries',
  requireModule('deliveries'),
  asyncHandler(async (req, res) => {
    const result = await deliveries.listDeliveries(req.query);
    ok(res, result.data, { pagination: result.pagination, meta: result.meta });
  })
);

router.post(
  '/deliveries/:deliveryId/advance',
  requireModule('deliveries', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await deliveries.advanceDelivery(req.params.deliveryId, req.staff);
    await realtime.emitSafe(
      realtime.notifyDeliveryChange({ delivery: data, memberId: data.memberId })
    );
    ok(res, data);
  })
);

router.post(
  '/deliveries/:deliveryId/cancel',
  requireModule('deliveries', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await deliveries.cancelDelivery(req.params.deliveryId, req.staff);
    await realtime.emitSafe(
      realtime.notifyDeliveryChange({ delivery: data, memberId: data.memberId })
    );
    ok(res, data);
  })
);

router.post(
  '/deliveries/:deliveryId/fail',
  requireModule('deliveries', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await deliveries.failDelivery(req.params.deliveryId, req.staff);
    await realtime.emitSafe(
      realtime.notifyDeliveryChange({ delivery: data, memberId: data.memberId })
    );
    ok(res, data);
  })
);

router.post(
  '/deliveries/:deliveryId/reschedule',
  requireModule('deliveries', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await deliveries.rescheduleDelivery(req.params.deliveryId, req.body?.date, req.staff);
    await realtime.emitSafe(
      realtime.notifyDeliveryChange({ delivery: data, memberId: data.memberId })
    );
    ok(res, data);
  })
);

router.get(
  '/cancellations',
  requireModule('cancellations'),
  asyncHandler(async (req, res) => {
    ok(res, (await cancellations.listCancellations(req.query)).data);
  })
);

router.post(
  '/cancellations/:id/approve',
  requireModule('cancellations', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await cancellations.approveCancellation(req.params.id, req.staff);
    await realtime.emitSafe(
      realtime.notifyCancellationChange({
        cancellation: data,
        memberId: data.memberId,
      })
    );
    ok(res, data);
  })
);

router.post(
  '/cancellations/:id/reject',
  requireModule('cancellations', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await cancellations.rejectCancellation(req.params.id, req.staff);
    await realtime.emitSafe(
      realtime.notifyCancellationChange({
        cancellation: data,
        memberId: data.memberId,
      })
    );
    ok(res, data);
  })
);

router.get(
  '/notifications/templates',
  requireModule('notifications'),
  asyncHandler(async (req, res) => {
    ok(res, await notifications.listTemplates());
  })
);

router.get(
  '/notifications/sent',
  requireModule('notifications'),
  asyncHandler(async (req, res) => {
    const result = await notifications.listSent(req.query);
    ok(res, result.data, { pagination: result.pagination });
  })
);

router.post(
  '/notifications/send',
  requireModule('notifications', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await notifications.sendNotification(req.body || {}, req.staff);
    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_UPDATED, data.memberId, {
        member: data.member,
        sent: data,
      })
    );
    ok(res, data, { message: 'Notification sent' });
  })
);

router.get(
  '/tickets',
  requireModule('support'),
  asyncHandler(async (req, res) => {
    const result = await tickets.listTickets(req.query);
    ok(res, result.data, { pagination: result.pagination });
  })
);

router.get(
  '/tickets/:ticketId',
  requireModule('support'),
  asyncHandler(async (req, res) => {
    ok(res, await tickets.getTicket(req.params.ticketId));
  })
);

router.post(
  '/tickets/:ticketId/reply',
  requireModule('support', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await tickets.replyTicket(req.params.ticketId, req.body?.text, req.staff);
    await realtime.emitSafe(realtime.notifyTicketChange({ ticket: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.post(
  '/tickets/:ticketId/assign',
  requireModule('support', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await tickets.assignTicket(req.params.ticketId, req.body?.assigneeId, req.staff);
    await realtime.emitSafe(realtime.notifyTicketChange({ ticket: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.post(
  '/tickets/:ticketId/resolve',
  requireModule('support', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await tickets.resolveTicket(req.params.ticketId, req.staff);
    await realtime.emitSafe(realtime.notifyTicketChange({ ticket: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.post(
  '/tickets/:ticketId/close',
  requireModule('support', { write: true }),
  asyncHandler(async (req, res) => {
    const data = await tickets.closeTicket(req.params.ticketId, req.staff);
    await realtime.emitSafe(realtime.notifyTicketChange({ ticket: data, memberId: data.memberId }));
    ok(res, data);
  })
);

router.get(
  '/reports/export',
  requireModule('reports'),
  asyncHandler(async (req, res) => {
    const { csv, filename } = await reports.exportReportsCsv(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  })
);

router.get(
  '/reports',
  requireModule('reports'),
  asyncHandler(async (req, res) => {
    ok(res, await reports.getReports(req.query));
  })
);

router.get(
  '/audit',
  requireModule('audit'),
  asyncHandler(async (req, res) => {
    const result = await reports.listAudit(req.query);
    ok(res, result.data, { pagination: result.pagination });
  })
);

router.get(
  '/staff',
  requireModule('dashboard'),
  asyncHandler(async (req, res) => {
    ok(res, await reports.listStaff());
  })
);

router.post(
  '/staff',
  requireModule('audit', { write: true }),
  asyncHandler(async (req, res) => {
    const result = await withIdempotency(req, 'admin_create_staff', async () => {
      const body = await staffAccounts.createStaff(req.body || {}, req.staff);
      return { status: 201, body: { success: true, message: 'Staff created', data: body } };
    });
    res.status(result.status).json(result.body);
  })
);

router.patch(
  '/staff/:staffId',
  requireModule('audit', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await staffAccounts.updateStaff(req.params.staffId, req.body || {}, req.staff), {
      message: 'Staff updated',
    });
  })
);

router.delete(
  '/staff/:staffId',
  requireModule('audit', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await staffAccounts.removeStaff(req.params.staffId, req.staff), {
      message: 'Staff removed',
    });
  })
);

router.get(
  '/plans',
  requireModule('dashboard'),
  asyncHandler(async (req, res) => {
    ok(res, await reports.listPlans());
  })
);

router.patch(
  '/plans/:planKey',
  requireModule('plans', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await reports.patchPlan(req.params.planKey, req.body || {}));
  })
);

router.get(
  '/settings',
  requireModule('dashboard'),
  asyncHandler(async (req, res) => {
    ok(res, await reports.getSettings());
  })
);

router.patch(
  '/settings',
  requireModule('settings', { write: true }),
  asyncHandler(async (req, res) => {
    ok(res, await reports.patchSettings(req.body || {}));
  })
);

module.exports = router;
