const { formatInr, moneyFields } = require('../money');
const { displayPhone } = require('../phone');
const {
  isoDate,
  formatDisplayDate,
  formatJoinedLabel,
  monthLabel,
  timeAgo,
  defaultDueDate,
  daysUntil,
  utcToday,
} = require('../dates');
const { toPlan } = require('../serializers');
const {
  ROLE_LABELS,
  ROLE_SCOPES,
  CROP_STAGE_LABELS,
  AUDIENCE_LABELS,
  METHOD_LABELS,
  FARMS_SEED,
} = require('./constants');
const { nextSeq } = require('./ids');
const { formatCollectionRef } = require('../collectionRef');

function farmFromPlotKey(plotKey) {
  if (!plotKey) return null;
  const key = String(plotKey);
  const farm = FARMS_SEED.find((f) => f.prefixes.some((p) => key.startsWith(p)));
  if (farm) {
    return { id: farm.id, name: farm.name, region: farm.region, farmer: farm.farmer };
  }
  return null;
}

function memberPublicId(member) {
  return member?.memberCode || (member?.id ? `CHEDI-${member.id}` : null);
}

function firstNameOf(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)[0] || '';
}

function toStaffDto(staff) {
  if (!staff) return null;
  const name = staff.name || '';
  return {
    id: staff.id,
    name,
    email: staff.email,
    role: staff.role,
    roleLabel: staff.roleLabel || ROLE_LABELS[staff.role] || staff.role,
    initial: staff.initial || (name[0] || 'A').toUpperCase(),
    scope: staff.scope || ROLE_SCOPES[staff.role] || '',
    active: staff.active !== false,
  };
}

function deriveSubStatus(member, subscription) {
  if (member?.accountStatus === 'cancelled') return 'cancelled';
  if (member?.accountStatus === 'suspended') return 'paused';
  if (!subscription) {
    if (member?.subStatus && member.subStatus !== 'none') return member.subStatus;
    return 'none';
  }
  const st = subscription.status;
  if (st === 'paused' || st === 'cancelled' || st === 'expired' || st === 'pending_activation' || st === 'payment_pending') {
    return st;
  }
  if (st === 'past_due') return 'renewal_due';
  if (st === 'active') {
    const due = subscription.nextBillDue || subscription.cycleEnd;
    const remaining = daysUntil(due);
    if (!subscription.billPaid && remaining != null && remaining <= 30) return 'renewal_due';
    return 'active';
  }
  return member?.subStatus || st || 'none';
}

function statusLabelFor(member, subStatus) {
  if (member?.accountStatus === 'pending' || (!member?.isMember && member?.accountStatus !== 'cancelled')) {
    return 'Membership unpaid';
  }
  if (member?.accountStatus === 'suspended') return 'Suspended';
  if (member?.accountStatus === 'cancelled') return 'Cancelled';
  if (subStatus === 'active') return 'Subscribed · active';
  if (subStatus === 'renewal_due') return 'Renewal due';
  if (subStatus === 'payment_pending' || subStatus === 'pending_activation') return 'Payment pending';
  if (subStatus === 'paused') return 'Paused';
  if (subStatus === 'none') return member?.isMember ? 'Member · no plot yet' : 'Membership unpaid';
  return member?.statusLabel || subStatus;
}

function toMemberDto(member, { subscription, plot, plan, address, farm } = {}) {
  if (!member) return null;
  const sub = subscription || null;
  const subStatus = deriveSubStatus(member, sub);
  const planDto = plan ? toPlan(plan) : null;
  const farmInfo = farm || farmFromPlotKey(sub?.plotKey || member.plotKey || plot?.key);
  const cycleStart = sub?.cycleStart || member.cycleStart || null;
  const cycleEnd = sub?.cycleEnd || member.cycleEnd || null;
  const city = address?.city || member.city || null;
  const pin = address?.pin || member.pin || null;
  const line = address?.line || member.addressLine || null;
  const addressDisplay = [line, city && pin ? `${city} ${pin}` : city].filter(Boolean).join(', ') || null;
  const welcome = member.welcomeBasket
    ? {
        status: member.welcomeBasket.status,
        etaDate: member.welcomeBasket.etaDate,
        etaLabel: member.welcomeBasket.etaLabel,
        imageUrl: member.welcomeBasket.imageUrl,
        description: member.welcomeBasket.description,
      }
    : null;

  return {
    id: member.id,
    memberCode: memberPublicId(member),
    name: member.name,
    firstName: firstNameOf(member.name),
    phone: member.phone,
    phoneDisplay: member.phoneDisplay || displayPhone(member.phone),
    email: member.email || null,
    accountStatus: member.accountStatus || (member.isMember ? 'active' : 'pending'),
    subStatus,
    isMember: Boolean(member.isMember),
    memberSince: member.memberSince || (member.createdAt ? isoDate(member.createdAt) : null),
    joinedLabel: member.memberSince
      ? formatJoinedLabel(member.memberSince)
      : member.createdAt
        ? formatJoinedLabel(member.createdAt)
        : null,
    hasPlot: Boolean(member.hasPlot || sub),
    plotCount: member.plotCount || (sub ? 1 : 0),
    statusLabel: statusLabelFor(member, subStatus),
    planKey: sub?.planKey || member.planKey || null,
    planName: planDto?.name || member.planName || null,
    plotKey: sub?.plotKey || member.plotKey || plot?.key || null,
    plotName: plot?.name || member.plotName || null,
    farmId: farmInfo?.id || member.farmId || null,
    farmName: farmInfo?.name || member.farmName || null,
    region: plot?.region || farmInfo?.region || member.region || null,
    city,
    addressLine: line,
    pin,
    addressDisplay,
    cycleStart,
    cycleEnd,
    cycleStartLabel: sub?.cycleStartLabel || (cycleStart ? monthLabel(cycleStart) : null),
    cycleEndLabel: sub?.cycleEndLabel || (cycleEnd ? monthLabel(cycleEnd) : null),
    activeSubscriptionId: member.activeSubscriptionId || sub?.id || null,
    welcomeBasket: welcome,
    preferences: member.preferences || {
      notifications: { delivery: true, harvest: true, promos: false },
      channel: 'push',
    },
    deletedAt: member.deletedAt || null,
  };
}

function toSubscriptionDto(sub, { member, plot, plan } = {}) {
  if (!sub) return null;
  const planDto = plan ? toPlan(plan) : null;
  const subStatus = deriveSubStatus(member, sub);
  const totalInr = sub.totalInr || planDto?.totalInr || 0;
  return {
    id: sub.id,
    memberId: sub.memberId || member?.id,
    memberCode: member ? memberPublicId(member) : null,
    memberName: member?.name || null,
    plotKey: sub.plotKey,
    plotName: plot?.name || sub.plotName || null,
    planKey: sub.planKey,
    planName: planDto?.name || sub.planName || null,
    status: sub.status,
    subStatus,
    totalInr,
    totalFormatted: formatInr(totalInr),
    cycleStart: sub.cycleStart,
    cycleEnd: sub.cycleEnd,
    cycleStartLabel: sub.cycleStartLabel || (sub.cycleStart ? monthLabel(sub.cycleStart) : null),
    cycleEndLabel: sub.cycleEndLabel || (sub.cycleEnd ? monthLabel(sub.cycleEnd) : null),
    billPaid: Boolean(sub.billPaid),
    billingMode: sub.billingMode || 'manual',
    nextBillDue: sub.nextBillDue || sub.cycleEnd,
    nextBillAmountInr: sub.nextBillAmountInr || totalInr,
    nextBillAmountFormatted: formatInr(sub.nextBillAmountInr || totalInr),
    boxesPerWeek: planDto?.boxesPerWeek || sub.boxesPerWeek || 1,
  };
}

function paymentOpsStatus(payment) {
  const status = payment.status;
  if (status === 'succeeded') return 'paid';
  if (status === 'refunded') return 'refunded';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'processing') {
    const due = payment.dueDate ? String(payment.dueDate).slice(0, 10) : null;
    const today = isoDate(utcToday());
    if (due && due < today) return 'overdue';
    return 'pending';
  }
  return status;
}

function toPaymentDto(payment, extra = {}) {
  if (!payment) return null;
  const opsStatus = paymentOpsStatus(payment);
  const method = payment.method || 'payment_request';
  return {
    id: payment.id,
    ref: payment.ref,
    memberId: payment.memberId || extra.memberId || null,
    memberCode: extra.memberCode || payment.memberCode || null,
    memberName: extra.memberName || payment.memberName || null,
    memberEmail: extra.memberEmail || payment.memberEmail || null,
    memberPhone: extra.memberPhone || payment.memberPhone || payment.phoneDisplay || null,
    context: payment.context,
    status: payment.status,
    opsStatus,
    amountInr: payment.amountInr,
    amountFormatted: payment.amountFormatted || formatInr(payment.amountInr),
    currency: payment.currency || 'INR',
    method,
    label: payment.label,
    date: payment.date,
    dueDate: payment.dueDate || null,
    collectedAt: payment.collectedAt || (payment.status === 'succeeded' ? payment.date : null),
    collectionRef: payment.collectionRef || null,
    receiptUrl: payment.receiptUrl || null,
    adminNote: payment.adminNote || null,
    approvedAt: payment.approvedAt
      ? payment.approvedAt instanceof Date
        ? payment.approvedAt.toISOString()
        : payment.approvedAt
      : null,
    approvedBy: payment.approvedBy || null,
    rejectedAt: payment.rejectedAt
      ? payment.rejectedAt instanceof Date
        ? payment.rejectedAt.toISOString()
        : payment.rejectedAt
      : null,
    refundedAt: payment.refundedAt
      ? payment.refundedAt instanceof Date
        ? payment.refundedAt.toISOString()
        : payment.refundedAt
      : null,
    metadata: payment.metadata || {},
    requestNotice:
      payment.requestNotice ||
      'Our team will contact you by email to collect payment, then mark this request as paid from the Admin Dashboard.',
  };
}

function methodDisplay(method) {
  return METHOD_LABELS[method] || method || 'Offline';
}

function receiptStatusLabel(opsStatus) {
  if (opsStatus === 'paid') return 'Paid';
  if (opsStatus === 'refunded') return 'Refunded';
  return opsStatus;
}

function toReceiptDto(payment, extra = {}) {
  const dto = toPaymentDto(payment, extra);
  const method = methodDisplay(dto.method);
  const dateLabel = dto.date ? formatJoinedLabel(dto.date) : '';
  return {
    ref: dto.ref,
    date: dto.date,
    memberName: dto.memberName,
    memberCode: dto.memberCode,
    memberId: dto.memberId,
    label: dto.label,
    method,
    status: receiptStatusLabel(dto.opsStatus),
    amountInr: dto.amountInr,
    amountFormatted: dto.amountFormatted,
    rows: [
      { k: 'Transaction ID', v: dto.id },
      ...(dto.collectionRef ? [{ k: 'UTR', v: formatCollectionRef(dto.collectionRef) }] : []),
      { k: 'Receipt no.', v: dto.ref },
      { k: 'Member', v: dto.memberName || '—' },
      { k: 'Member ID', v: dto.memberCode || dto.memberId || '—' },
      { k: 'For', v: dto.label || '' },
      { k: 'Method', v: method },
      { k: 'Date', v: dateLabel },
    ],
  };
}

function toBasketDto(basket, crops = {}) {
  if (!basket) return null;
  return {
    id: basket.id,
    weekLabel: basket.weekLabel || basket.week,
    weekStart: basket.weekStart,
    status: basket.status,
    items: (basket.items || []).map((item) => {
      const crop = crops[item.cropKey] || {};
      return {
        cropKey: item.cropKey,
        cropName: item.cropName || crop.name || item.cropKey,
        qty: item.qty,
        unit: item.unit || crop.unit || 'kg',
        supp: Boolean(item.supp),
      };
    }),
  };
}

function toDeliveryDto(delivery, extra = {}) {
  if (!delivery) return null;
  const boxes = extra.boxesPerWeek || delivery.boxes || 1;
  return {
    id: delivery.id,
    memberId: delivery.memberId || extra.memberId,
    memberCode: extra.memberCode || delivery.memberCode || null,
    memberName: extra.memberName || delivery.memberName || null,
    addressDisplay: extra.addressDisplay || delivery.addressDisplay || null,
    plotKey: extra.plotKey || delivery.plotKey || null,
    plotName: extra.plotName || delivery.plotName || null,
    subscriptionId: delivery.subscriptionId,
    basketId: delivery.basketId || extra.basketId || null,
    weekIndex: delivery.weekIndex,
    date: delivery.date,
    dateLabel: delivery.dateLabel || (delivery.date ? formatDisplayDate(delivery.date) : null),
    boxes,
    boxesLabel: `${boxes} box${boxes === 1 ? '' : 'es'}`,
    opsStatus: delivery.opsStatus || (delivery.cancelled ? 'cancelled' : delivery.locked ? 'packed' : 'scheduled'),
    cancelled: Boolean(delivery.cancelled),
    locked: Boolean(delivery.locked || delivery.cancelled),
    cancellable: Boolean(delivery.cancellable) && !delivery.cancelled,
    lockReason: delivery.lockReason || null,
    cancelReason: delivery.cancelReason || null,
  };
}

function toPlotAdminDto(plot, overlay = {}) {
  if (!plot) return null;
  const farm = overlay.farm || farmFromPlotKey(plot.key);
  const cultivation = overlay.cultivation || {};
  const leasedUnits = Math.max(0, (plot.totalUnits || 0) - (plot.availableUnits || 0));
  return {
    key: plot.key,
    name: plot.name,
    status: plot.status,
    opsStatus: overlay.opsStatus || plot.opsStatus || cultivation.opsStatus || (plot.status === 'soon' ? 'unavailable' : 'available'),
    size: plot.size,
    state: plot.state,
    district: plot.district,
    city: plot.city,
    region: plot.region,
    farmId: farm?.id || plot.farmId || null,
    farmerName: farm?.farmer || plot.farmerName || null,
    crop: plot.crop,
    cropKey: cultivation.cropKey || plot.cropKey || null,
    cropName: overlay.cropName || cultivation.cropName || null,
    cropStage: cultivation.cropStage || plot.cropStage || null,
    plantDate: cultivation.plantDate || plot.plantDate || null,
    harvestDate: cultivation.harvestDate || plot.harvestDate || null,
    targetYield: cultivation.targetYield ?? plot.targetYield ?? null,
    actualYield: cultivation.actualYield ?? plot.actualYield ?? null,
    unit: overlay.unit || cultivation.unit || 'kg',
    cropCycle: plot.cropCycle || 'Seasonal · year-round beds',
    soil: plot.soil || 'Red loam · organic certified',
    totalUnits: plot.totalUnits ?? 0,
    availableUnits: plot.availableUnits ?? 0,
    leasedUnits,
    memberId: overlay.memberId || null,
    memberCode: overlay.memberCode || null,
    memberName: overlay.memberName || null,
    planKey: overlay.planKey || null,
    imageUrl: plot.imageUrl || null,
    gallery: plot.gallery || [],
    map: plot.map || null,
    notifyRequestCount: overlay.notifyRequestCount || 0,
  };
}

function toCropDto(crop) {
  if (!crop) return null;
  return {
    key: crop.key,
    name: crop.name,
    season: crop.season,
    unit: crop.unit,
  };
}

function toTicketDto(ticket, extra = {}) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    memberId: ticket.memberId,
    memberCode: extra.memberCode || ticket.memberCode || null,
    memberName: extra.memberName || ticket.memberName || null,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    assigneeId: ticket.assigneeId || ticket.assignee || null,
    assigneeName: extra.assigneeName || ticket.assigneeName || null,
    messages: (ticket.messages || []).map((m) => ({
      id: m.id,
      who: m.who,
      staffId: m.staffId || null,
      text: m.text,
      createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
      timeLabel: m.timeLabel || timeAgo(m.createdAt),
    })),
    createdAt: ticket.createdAt instanceof Date ? ticket.createdAt.toISOString() : ticket.createdAt,
    updatedAt: ticket.updatedAt instanceof Date ? ticket.updatedAt.toISOString() : ticket.updatedAt,
  };
}

function toSentDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    icon: row.icon || 'bell',
    title: row.title,
    body: row.body,
    audience: row.audience,
    audienceLabel: row.audienceLabel || AUDIENCE_LABELS[row.audience] || row.audience,
    channel: row.channel,
    memberId: row.memberId || null,
    recipientCount: row.recipientCount || 0,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    timeLabel: timeAgo(row.createdAt),
    sentBy: row.sentBy || null,
  };
}

function toCancellationDto(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    memberId: row.memberId,
    memberCode: extra.memberCode || row.memberCode || null,
    memberName: extra.memberName || row.memberName || null,
    date: row.date,
    dateLabel: row.dateLabel || (row.date ? formatDisplayDate(row.date) : null),
    plotKey: extra.plotKey || row.plotKey || null,
    plotName: extra.plotName || row.plotName || null,
    reason: row.reason || '',
    locked: Boolean(row.locked),
    status: row.status,
  };
}

function planBoxes(plan) {
  if (!plan) return 1;
  if (plan.boxesPerWeek) return plan.boxesPerWeek;
  if (plan.key === 'family12') return 3;
  if (plan.key === 'family8') return 2;
  return 1;
}

function planPlotCount(plan) {
  if (!plan) return 1;
  if (plan.plotCount) return plan.plotCount;
  if (plan.key === 'family12') return 3;
  if (plan.key === 'family8') return 2;
  return 1;
}

function moneyPayload(amountInr) {
  return moneyFields(amountInr);
}

module.exports = {
  farmFromPlotKey,
  memberPublicId,
  firstNameOf,
  toStaffDto,
  deriveSubStatus,
  toMemberDto,
  toSubscriptionDto,
  paymentOpsStatus,
  toPaymentDto,
  toReceiptDto,
  toBasketDto,
  toDeliveryDto,
  toPlotAdminDto,
  toCropDto,
  toTicketDto,
  toSentDto,
  toCancellationDto,
  planBoxes,
  planPlotCount,
  defaultDueDate,
  nextSeq,
  methodDisplay,
};
