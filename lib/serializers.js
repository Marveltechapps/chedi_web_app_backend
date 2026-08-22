const { formatInr } = require('./money');

const DELIVERY_CHARGE_INR = () => Number(process.env.DELIVERY_CHARGE_INR || 10000);

function toPlotSummary(plot, { leasedByMe = false, notifyRequested = false } = {}) {
  return {
    key: plot.key,
    name: plot.name,
    status: plot.status,
    size: plot.size,
    state: plot.state,
    district: plot.district,
    city: plot.city,
    region: plot.region,
    crop: plot.crop,
    totalUnits: plot.totalUnits ?? plot.total ?? 0,
    availableUnits: plot.availableUnits ?? plot.available ?? 0,
    imageUrl: plot.imageUrl || plot.img || null,
    leasedByMe,
    notifyRequested,
  };
}

function toPlotDetail(plot, opts = {}) {
  return {
    ...toPlotSummary(plot, opts),
    cropCycle: plot.cropCycle || 'Seasonal · year-round beds',
    soil: plot.soil || 'Red loam · organic certified',
    gallery: (plot.gallery || []).map((g) => ({
      label: g.label,
      imageUrl: g.imageUrl || g.img,
    })),
    map: plot.map || null,
  };
}

function toPlan(plan) {
  const deliveryChargeInr = DELIVERY_CHARGE_INR();
  const priceInr = plan.priceInr;
  const totalInr = plan.totalInr ?? priceInr + deliveryChargeInr;
  const plotCount = plan.plotCount || (plan.key === 'family12' ? 3 : plan.key === 'family8' ? 2 : 1);
  const boxesPerWeek = plan.boxesPerWeek || plotCount;
  return {
    key: plan.key,
    tag: plan.tag,
    name: plan.name,
    priceInr,
    priceFormatted: plan.priceFormatted || formatInr(priceInr),
    deliveryChargeInr,
    deliveryChargeFormatted: formatInr(deliveryChargeInr),
    totalInr,
    totalFormatted: plan.totalFormatted || formatInr(totalInr),
    plotsLabel: plan.plotsLabel || plan.plots,
    sizeLabel: plan.sizeLabel || plan.size,
    boxesPerWeek,
    plotCount,
    featured: Boolean(plan.featured),
    features: plan.features || [],
  };
}

function monthLabel(date) {
  return new Date(date).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function toSubscription(sub, plot, plan) {
  return {
    id: sub.id,
    plotKey: sub.plotKey,
    planKey: sub.planKey,
    status: sub.status,
    totalInr: sub.totalInr,
    totalFormatted: formatInr(sub.totalInr),
    cycleStart: sub.cycleStart,
    cycleEnd: sub.cycleEnd,
    cycleStartLabel: sub.cycleStartLabel || monthLabel(sub.cycleStart),
    cycleEndLabel: sub.cycleEndLabel || monthLabel(sub.cycleEnd),
    billPaid: Boolean(sub.billPaid),
    billingMode: sub.billingMode || 'manual',
    nextBillDue: sub.nextBillDue || sub.cycleEnd,
    nextBillAmountInr: sub.nextBillAmountInr || sub.totalInr,
    nextBillAmountFormatted: formatInr(sub.nextBillAmountInr || sub.totalInr),
    plot: plot ? toPlotSummary(plot, { leasedByMe: true }) : undefined,
    plan: plan ? toPlan(plan) : undefined,
    createdAt: sub.createdAt instanceof Date ? sub.createdAt.toISOString() : sub.createdAt,
  };
}

module.exports = {
  toPlotSummary,
  toPlotDetail,
  toPlan,
  toSubscription,
  DELIVERY_CHARGE_INR,
  monthLabel,
};
