const express = require('express');
const path = require('path');
const fs = require('fs');
const { optionalMember, requireMember } = require('../middleware/auth');
const tickets = require('../lib/admin/tickets.service');
const { asyncHandler } = require('../lib/asyncHandler');
const realtime = require('../lib/realtime');

const router = express.Router();

function loadSupport() {
  const file = path.join(__dirname, '..', 'data', 'support.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

router.get('/', optionalMember, async (_req, res, next) => {
  try {
    res.json(loadSupport());
  } catch (err) {
    next(err);
  }
});

router.get(
  '/tickets',
  requireMember,
  asyncHandler(async (req, res) => {
    const items = await tickets.listMemberTickets(req.member.id);
    res.json({ items });
  })
);

router.post(
  '/tickets',
  requireMember,
  asyncHandler(async (req, res) => {
    const ticket = await tickets.createMemberTicket({
      member: req.memberDoc,
      category: req.body?.category,
      subject: req.body?.subject,
      text: req.body?.text,
    });
    await realtime.emitSafe(
      realtime.notifyTicketChange({ memberId: req.member.id, ticket })
    );
    res.status(201).json({ ok: true, ticket });
  })
);

router.post(
  '/tickets/:id/messages',
  requireMember,
  asyncHandler(async (req, res) => {
    const ticket = await tickets.memberReply(req.params.id, req.memberDoc, req.body?.text);
    await realtime.emitSafe(
      realtime.notifyTicketChange({ memberId: req.member.id, ticket })
    );
    res.json({ ok: true, ticket });
  })
);

module.exports = router;
