const fs = require('fs');
const path = require('path');
const { hashPassword } = require('../lib/password');
const { formatInr } = require('../lib/money');
const { FARMS_SEED, ROLE_LABELS, ROLE_SCOPES } = require('../lib/admin/constants');

const STAFF = [
  { id: 'anitha', name: 'Anitha R.', email: 'anitha@chedi.in', role: 'super_admin' },
  { id: 'murugan', name: 'Murugan V.', email: 'murugan@chedi.in', role: 'farm_manager' },
  { id: 'sundar', name: 'Sundar P.', email: 'sundar@chedi.in', role: 'billing_manager' },
  { id: 'kavya', name: 'Kavya L.', email: 'kavya@chedi.in', role: 'delivery_manager' },
  { id: 'ramesh', name: 'Ramesh T.', email: 'ramesh@chedi.in', role: 'support_agent' },
];

const CROPS = [
  { key: 'tomato', name: 'Tomato', season: 'Kharif', unit: 'kg' },
  { key: 'okra', name: 'Okra', season: 'Kharif', unit: 'kg' },
  { key: 'spinach', name: 'Spinach', season: 'All', unit: 'bunch' },
  { key: 'brinjal', name: 'Brinjal', season: 'Rabi', unit: 'kg' },
  { key: 'beans', name: 'Cluster beans', season: 'Kharif', unit: 'kg' },
  { key: 'chilli', name: 'Green chilli', season: 'All', unit: 'kg' },
  { key: 'coriander', name: 'Coriander', season: 'All', unit: 'bunch' },
  { key: 'onion', name: 'Onion', season: 'Rabi', unit: 'kg' },
];

const TEMPLATES = [
  { key: 'pay_reminder', title: 'Payment reminder', body: 'A gentle reminder that your payment is due. Please complete it to keep your membership active.' },
  { key: 'pay_received', title: 'Payment received', body: 'We have received your payment. Thank you!' },
  { key: 'sub_active', title: 'Subscription activated', body: 'Your subscription is active. Your plot and weekly baskets are all set.' },
  { key: 'renewal', title: 'Renewal reminder', body: 'Your subscription is up for renewal soon. Renew to keep your baskets coming.' },
  { key: 'dlv_scheduled', title: 'Delivery scheduled', body: 'Your weekly basket has been scheduled for delivery.' },
  { key: 'out_delivery', title: 'Out for delivery', body: 'Your basket is out for delivery and on its way.' },
  { key: 'delivered', title: 'Delivered', body: 'Your basket has been delivered. Enjoy!' },
  { key: 'crop_update', title: 'Crop / plot update', body: 'There is a fresh update from your plot.' },
];

async function seedAdmin(db) {
  const collections = [
    'staff',
    'staff_sessions',
    'audit_log',
    'farms',
    'crops',
    'cultivations',
    'baskets',
    'cancellation_requests',
    'tickets',
    'notification_templates',
    'notifications_sent',
    'app_settings',
  ];
  for (const name of collections) {
    await db.collection(name).deleteMany({});
  }

  const password = process.env.STAFF_SEED_PASSWORD || 'ChediAdmin123!';
  const passwordHash = await hashPassword(password);
  const now = new Date();
  await db.collection('staff').insertMany(
    STAFF.map((s) => ({
      ...s,
      passwordHash,
      roleLabel: ROLE_LABELS[s.role],
      initial: s.name[0],
      scope: ROLE_SCOPES[s.role],
      active: true,
      createdAt: now,
    }))
  );

  await db.collection('farms').insertMany(
    FARMS_SEED.map(({ prefixes, ...rest }) => ({ ...rest, createdAt: now }))
  );
  await db.collection('crops').insertMany(CROPS.map((c) => ({ ...c, createdAt: now })));
  await db.collection('notification_templates').insertMany(TEMPLATES.map((t) => ({ ...t, createdAt: now })));

  const settings = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'app_settings.json'), 'utf8')
  );
  await db.collection('app_settings').insertOne({ ...settings, createdAt: now, updatedAt: now });

  await db.collection('cultivations').insertOne({
    plotKey: 'sivaganga-1',
    cropKey: 'tomato',
    cropName: 'Tomato',
    unit: 'kg',
    plantDate: '2026-07-25',
    harvestDate: '2026-08-20',
    cropStage: 'ready',
    targetYield: 12,
    actualYield: null,
    opsStatus: 'harvesting',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('plots').updateOne(
    { key: 'sivaganga-1' },
    { $set: { opsStatus: 'harvesting', cropKey: 'tomato' } }
  );

  await db.collection('baskets').insertMany([
    {
      id: 'wk34',
      weekLabel: 'Week 34 · 22 Aug',
      weekStart: '2026-08-22',
      status: 'review',
      items: [
        { cropKey: 'tomato', qty: 2, supp: false, unit: 'kg' },
        { cropKey: 'okra', qty: 1, supp: false, unit: 'kg' },
        { cropKey: 'spinach', qty: 2, supp: false, unit: 'bunch' },
        { cropKey: 'coriander', qty: 1, supp: true, unit: 'bunch' },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'wk33',
      weekLabel: 'Week 33 · 15 Aug',
      weekStart: '2026-08-15',
      status: 'packed',
      items: [
        { cropKey: 'tomato', qty: 2, supp: false, unit: 'kg' },
        { cropKey: 'beans', qty: 1, supp: false, unit: 'kg' },
        { cropKey: 'spinach', qty: 1, supp: false, unit: 'bunch' },
      ],
      createdAt: new Date('2026-08-15T00:00:00Z'),
      updatedAt: now,
    },
  ]);

  await db.collection('counters').updateOne(
    { _id: 'basketWeek' },
    { $set: { seq: 34 } },
    { upsert: true }
  );
  await db.collection('counters').updateOne(
    { _id: 'ticket' },
    { $set: { seq: 118 } },
    { upsert: true }
  );
  await db.collection('counters').updateOne(
    { _id: 'cancellation' },
    { $set: { seq: 2 } },
    { upsert: true }
  );

  await db.collection('tickets').insertOne({
    id: 'TKT-118',
    memberId: '0500',
    memberCode: 'CHEDI-0500',
    memberName: 'Priya Balan',
    category: 'Delivery',
    subject: 'Last basket arrived late',
    status: 'open',
    assigneeId: 'ramesh',
    assigneeName: 'Ramesh T.',
    messages: [
      {
        id: 'msg_1',
        who: 'Priya Balan',
        staffId: null,
        text: 'My Saturday basket came Sunday evening.',
        createdAt: new Date('2026-08-20T10:00:00Z'),
      },
    ],
    createdAt: new Date('2026-08-20T10:00:00Z'),
    updatedAt: new Date('2026-08-20T10:00:00Z'),
  });

  const firstDelivery = await db.collection('deliveries').findOne({ memberId: '0500' }, { sort: { weekIndex: 1 } });
  if (firstDelivery) {
    await db.collection('cancellation_requests').insertOne({
      id: 'CX-02',
      deliveryId: firstDelivery.id,
      memberId: '0500',
      memberCode: 'CHEDI-0500',
      memberName: 'Priya Balan',
      date: firstDelivery.date,
      dateLabel: firstDelivery.dateLabel,
      reason: 'Out of station',
      locked: true,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.collection('notifications_sent').insertOne({
    id: 'snd_1',
    icon: 'truck',
    title: 'Out for delivery',
    body: 'Your Saturday basket is on the way.',
    audience: 'active_subscribers',
    audienceLabel: 'Active subscribers',
    channel: 'push',
    memberId: null,
    recipientCount: 1,
    createdAt: new Date('2026-08-22T08:00:00Z'),
    sentBy: 'kavya',
  });

  await db.collection('audit_log').insertMany([
    {
      id: 'aud_seed_1',
      createdAt: new Date('2026-08-19T10:00:00Z'),
      actorId: 'anitha',
      actorName: 'Anitha R.',
      action: 'Payment marked paid',
      entity: 'CHEDI-R-20260720-002',
      entityType: 'payment',
      detail: `Priya Balan · ${formatInr(250000)}`,
      meta: { memberId: '0500', paymentId: 'pay_seed_lease' },
    },
    {
      id: 'aud_seed_2',
      createdAt: new Date('2026-08-19T10:05:00Z'),
      actorId: 'system',
      actorName: 'System',
      action: 'Subscription activated',
      entity: 'CHEDI-0500',
      entityType: 'subscription',
      detail: 'Plot Sivaganga-1 leased',
      meta: { memberId: '0500' },
    },
    {
      id: 'aud_seed_3',
      createdAt: new Date('2026-08-17T09:00:00Z'),
      actorId: 'murugan',
      actorName: 'Murugan V.',
      action: 'Crop stage updated',
      entity: 'sivaganga-1',
      entityType: 'crop',
      detail: 'Tomato → Ready',
      meta: {},
    },
  ]);

  return { staffPassword: password };
}

module.exports = { seedAdmin, STAFF };
