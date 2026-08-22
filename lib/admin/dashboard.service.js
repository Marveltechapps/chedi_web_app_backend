const { getDB } = require('../../config/db');
const { toAuditDto } = require('../audit');
const { formatInr } = require('../money');
const { paymentOpsStatus } = require('./dto');
const { hydrateMember } = require('./members.service');

async function getDashboard() {
  const db = getDB();
  const members = await db.collection('members').find({ deletedAt: null }).toArray();
  const hydrated = [];
  for (const m of members) hydrated.push(await hydrateMember(m));

  const payments = await db.collection('payments').find({}).toArray();
  const plots = await db.collection('plots').find({}).toArray();
  const deliveries = await db.collection('deliveries').find({}).toArray();
  const tickets = await db.collection('tickets').find({ status: 'open' }).toArray();
  const cancellations = await db
    .collection('cancellation_requests')
    .find({ status: 'pending', locked: { $ne: true } })
    .toArray();

  const pendingPay = payments.filter((p) => {
    const ops = paymentOpsStatus(p);
    return ops === 'pending' || ops === 'overdue' || p.status === 'failed' || p.status === 'processing';
  });
  const pendingPaymentsAmountInr = pendingPay.reduce((s, p) => s + (p.amountInr || 0), 0);
  const revenueCollectedInr = payments
    .filter((p) => p.status === 'succeeded')
    .reduce((s, p) => s + (p.amountInr || 0), 0);

  const plotsLeased = plots.filter((p) =>
    ['leased', 'cultivating', 'harvesting'].includes(p.opsStatus)
  ).length;
  const leasedFromSubs = await db.collection('subscriptions').countDocuments({
    status: { $in: ['active', 'past_due'] },
  });

  const upcomingDeliveries = deliveries.filter((d) =>
    ['scheduled', 'packed'].includes(d.opsStatus || (d.cancelled ? 'cancelled' : 'scheduled'))
  ).length;

  const renewalsDue = hydrated.filter((m) => m.subStatus === 'renewal_due').length;
  const pendingActionCount =
    pendingPay.length + cancellations.length + renewalsDue + tickets.length;

  const pendingActions = [];
  for (const p of pendingPay.slice(0, 8)) {
    const ops = paymentOpsStatus(p);
    pendingActions.push({
      kind: 'collect_payment',
      severity: ops === 'overdue' ? 'overdue' : 'pending',
      title: `${ops === 'overdue' ? 'Overdue' : 'Pending'}: ${p.memberName || 'Member'}`,
      description: `${p.label || p.context} · ${formatInr(p.amountInr)}`,
      cta: 'Mark paid',
      href: { tab: 'payments', paymentId: p.id },
    });
  }
  for (const c of cancellations.slice(0, 4)) {
    pendingActions.push({
      kind: 'review_cancellation',
      severity: 'pending',
      title: `Cancellation: ${c.memberName || c.memberId}`,
      description: c.reason || 'Member requested cancellation',
      cta: 'Review',
      href: { tab: 'cancellations', cancellationId: c.id },
    });
  }
  for (const m of hydrated.filter((x) => x.subStatus === 'renewal_due').slice(0, 4)) {
    pendingActions.push({
      kind: 'renewal_due',
      severity: 'pending',
      title: `Renewal due: ${m.name}`,
      description: `${m.plotName || 'Plot'} · ${m.planName || ''}`.trim(),
      cta: 'Generate bill',
      href: { tab: 'subscriptions', memberId: m.id },
    });
  }
  for (const t of tickets.slice(0, 4)) {
    pendingActions.push({
      kind: 'open_ticket',
      severity: 'pending',
      title: t.subject,
      description: `${t.memberName || t.memberId} · ${t.category}`,
      cta: 'Open',
      href: { tab: 'support', ticketId: t.id },
    });
  }

  const audit = await db.collection('audit_log').find({}).sort({ createdAt: -1 }).limit(6).toArray();

  return {
    kpis: {
      totalMembers: members.length,
      activeMembers: hydrated.filter((m) => m.accountStatus === 'active').length,
      pendingPayments: pendingPay.length,
      pendingPaymentsAmountInr,
      pendingPaymentsAmountFormatted: formatInr(pendingPaymentsAmountInr),
      activeSubscriptions: hydrated.filter((m) => m.subStatus === 'active').length,
      renewalsDue,
      plotsLeased: plotsLeased || leasedFromSubs,
      plotsTotal: plots.length,
      plotsAvailable: plots.filter((p) => p.status === 'available' && (p.availableUnits || 0) > 0).length,
      upcomingDeliveries,
      revenueCollectedInr,
      revenueCollectedFormatted: formatInr(revenueCollectedInr),
      pendingActionCount,
    },
    pendingActions,
    recentActivity: audit.map(toAuditDto),
  };
}

module.exports = { getDashboard };
