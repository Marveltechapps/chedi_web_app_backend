const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember, optionalMember } = require('../middleware/auth');
const { toPlotSummary, toPlotDetail } = require('../lib/serializers');

const router = express.Router();

router.get('/', optionalMember, async (req, res, next) => {
  try {
    const db = getDB();
    const {
      q,
      state,
      district,
      city,
      status = 'all',
      page = '1',
      pageSize = '20',
    } = req.query;

    const filter = {};
    if (state && state !== 'all') filter.state = state;
    if (district && district !== 'all') filter.district = district;
    if (city && city !== 'all') filter.city = city;
    if (status && status !== 'all') filter.status = status;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { region: rx }, { crop: rx }, { city: rx }, { district: rx }];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
    const skip = (pageNum - 1) * size;

    const col = db.collection('plots');
    const [total, plots, allForFilters] = await Promise.all([
      col.countDocuments(filter),
      col.find(filter).skip(skip).limit(size).toArray(),
      col.find({}).toArray(),
    ]);

    let leasedKeys = new Set();
    let notifiedKeys = new Set();
    if (req.member) {
      const subs = await db
        .collection('subscriptions')
        .find({ memberId: req.member.id, status: { $in: ['active', 'past_due'] } })
        .project({ plotKey: 1 })
        .toArray();
      leasedKeys = new Set(subs.map((s) => s.plotKey));
      const notifies = await db
        .collection('plot_notifications')
        .find({ memberId: req.member.id })
        .project({ plotKey: 1 })
        .toArray();
      notifiedKeys = new Set(notifies.map((n) => n.plotKey));
    }

    const scoped = allForFilters.filter((p) => {
      if (state && state !== 'all' && p.state !== state) return false;
      if (district && district !== 'all' && p.district !== district) return false;
      if (city && city !== 'all' && p.city !== city) return false;
      return true;
    });

    res.json({
      items: plots.map((p) =>
        toPlotSummary(p, {
          leasedByMe: leasedKeys.has(p.key),
          notifyRequested: notifiedKeys.has(p.key),
        })
      ),
      meta: {
        total,
        page: pageNum,
        pageSize: size,
        stats: {
          totalPlots: scoped.reduce((s, p) => s + (p.totalUnits || 0), 0) || scoped.length,
          availablePlots: scoped
            .filter((p) => p.status === 'available')
            .reduce((s, p) => s + (p.availableUnits || 0), 0),
        },
        filters: {
          states: [...new Set(allForFilters.map((p) => p.state))].sort(),
          districts: [
            ...new Set(
              allForFilters
                .filter((p) => !state || state === 'all' || p.state === state)
                .map((p) => p.district)
            ),
          ].sort(),
          cities: [
            ...new Set(
              allForFilters
                .filter((p) => {
                  if (state && state !== 'all' && p.state !== state) return false;
                  if (district && district !== 'all' && p.district !== district) return false;
                  return true;
                })
                .map((p) => p.city)
            ),
          ].sort(),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:plotKey', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const plot = await db.collection('plots').findOne({ key: req.params.plotKey });
    if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');

    const leased = await db.collection('subscriptions').findOne({
      memberId: req.member.id,
      plotKey: plot.key,
      status: { $in: ['active', 'past_due'] },
    });
    const notified = await db.collection('plot_notifications').findOne({
      memberId: req.member.id,
      plotKey: plot.key,
    });

    res.json(
      toPlotDetail(plot, {
        leasedByMe: Boolean(leased),
        notifyRequested: Boolean(notified),
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/:plotKey/notify-me', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const plot = await db.collection('plots').findOne({ key: req.params.plotKey });
    if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
    if (plot.status !== 'soon') {
      throw new ApiError(400, 'PLOT_NOT_COMING_SOON', 'Notify-me is only for coming-soon plots');
    }
    const existing = await db.collection('plot_notifications').findOne({
      memberId: req.member.id,
      plotKey: plot.key,
    });
    if (existing) {
      throw new ApiError(409, 'ALREADY_SUBSCRIBED_TO_NOTIFY', 'Already subscribed to notifications');
    }
    await db.collection('plot_notifications').insertOne({
      memberId: req.member.id,
      plotKey: plot.key,
      createdAt: new Date(),
    });
    res.json({
      ok: true,
      plotKey: plot.key,
      notifyRequested: true,
      message: "We'll notify you when this plot opens.",
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
