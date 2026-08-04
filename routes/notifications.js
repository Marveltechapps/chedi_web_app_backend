const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember } = require('../middleware/auth');

const router = express.Router();

function toNotification(n) {
  return {
    id: n.id,
    icon: n.icon,
    title: n.title,
    description: n.description,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
    unread: Boolean(n.unread),
    deepLinkTab: n.deepLinkTab || null,
    deepLinkPath: n.deepLinkPath || null,
  };
}

router.get('/', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const filter = { memberId: req.member.id };
    if (req.query.unreadOnly === 'true') filter.unread = true;

    const items = await db
      .collection('notifications')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();
    const unreadCount = await db.collection('notifications').countDocuments({
      memberId: req.member.id,
      unread: true,
    });
    res.json({ items: items.map(toNotification), unreadCount });
  } catch (err) {
    next(err);
  }
});

router.post('/clear', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const result = await db.collection('notifications').deleteMany({
      memberId: req.member.id,
    });
    res.json({ ok: true, clearedCount: result.deletedCount });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const result = await db.collection('notifications').updateOne(
      { id: req.params.id, memberId: req.member.id },
      { $set: { unread: false, readAt: new Date() } }
    );
    if (!result.matchedCount) {
      throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
