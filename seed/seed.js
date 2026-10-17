require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { connectDB, closeDB, getDB } = require('../config/db');
const { displayPhone } = require('../lib/phone');
const { ensureFixedNetBanking, seedDeliverySchedule, buildWelcomeTracking } = require('../lib/payments');
const { formatInr } = require('../lib/money');

async function seed() {
  await connectDB();
  const db = getDB();

  console.log('Seeding CHEDI CSA database…');

  const collections = [
    'plots',
    'plans',
    'produce_shares',
    'members',
    'addresses',
    'payment_methods',
    'subscriptions',
    'payments',
    'deliveries',
    'notifications',
    'registrations',
    'otps',
    'sessions',
    'idempotency',
    'plot_notifications',
    'data_exports',
    'counters',
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

  const plots = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plots.json'), 'utf8'));
  const plans = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plans.json'), 'utf8'));
  await db.collection('plots').insertMany(plots);
  await db.collection('plans').insertMany(plans);

  const staples = [
    ['Onion', '500 g'],
    ['Ginger', '100 g'],
    ['Tomato', '1 kg'],
    ['Green Chilli', '200 g'],
    ['Coriander', '2 bunches'],
    ['Garlic', '200 g'],
    ['Mint', '1 bunch'],
    ['Curry Leaves', '1 bunch'],
  ].map(([name, qty], i) => ({ no: i + 1, name, qty }));

  const seasonal = [
    ['Brinjal', '1 kg'],
    ["Lady's Finger", '750 g'],
    ['Carrot', '1 kg'],
    ['Beetroot', '750 g'],
    ['Cabbage', '1 head'],
    ['Cauliflower', '1 head'],
    ['Capsicum', '500 g'],
    ['Bitter Gourd', '500 g'],
  ].map(([name, qty], i) => ({ no: i + 1, name, qty }));

  await db.collection('produce_shares').insertOne({
    planKey: 'default',
    staples,
    seasonal,
    staplesNote: 'Weekly delivery of up to 3kg of everyday kitchen essentials.',
    seasonalNote: 'Weekly delivery of 7 seasonal vegetable varieties, totaling up to 7kg.',
  });

  await db.collection('counters').insertMany([
    { _id: 'memberId', seq: 500 },
  ]);

  // Demo member: Priya Balan
  const now = new Date();
  const memberSince = '2026-07-20';
  const welcomeEta = new Date('2026-07-22T00:00:00Z');
  const activatedAt = new Date('2026-07-20T10:00:00Z');

  const member = {
    id: '0500',
    memberCode: 'CHEDI-0500',
    name: 'Priya Balan',
    phone: '+919840012345',
    phoneDisplay: displayPhone('+919840012345'),
    email: 'priya@email.com',
    isMember: true,
    accountStatus: 'active',
    subStatus: 'active',
    memberSince,
    hasPlot: true,
    plotCount: 1,
    statusLabel: 'Subscribed · active',
    planKey: 'family8',
    plotKey: 'sivaganga-1',
    preferences: {
      notifications: { delivery: true, harvest: true, promos: false },
      channel: 'push',
    },
    activeSubscriptionId: 'sub_demo_sivaganga',
    welcomeBasket: {
      status: 'delivered',
      etaLabel: 'Tue, 22 Jul',
      etaDate: '2026-07-22',
      imageUrl: 'https://chediwebsite.s3.us-east-1.amazonaws.com/images/2148224020.jpg',
      description: 'Token of Love',
      tracking: buildWelcomeTracking(activatedAt, welcomeEta).map((s, i) => ({
        ...s,
        done: true,
        active: false,
        timeLabel: i === 3 ? 'Tue 22 Jul · delivered' : s.timeLabel,
      })),
    },
    membershipFeePaidInr: 500,
    createdAt: activatedAt,
    updatedAt: now,
    deletedAt: null,
  };
  await db.collection('members').insertOne(member);

  await db.collection('addresses').insertMany([
    {
      id: 'addr_a1',
      memberId: '0500',
      label: 'Home',
      line: '12, 3rd Cross Street, Besant Nagar',
      city: 'Chennai',
      pin: '600090',
      isDefault: true,
      createdAt: activatedAt,
    },
    {
      id: 'addr_a2',
      memberId: '0500',
      label: 'Parents',
      line: '4A, Gandhi Road, Adyar',
      city: 'Chennai',
      pin: '600020',
      isDefault: false,
      createdAt: activatedAt,
    },
  ]);

  await ensureFixedNetBanking('0500');
  await db.collection('payment_methods').insertOne({
    id: 'pm_c2',
    memberId: '0500',
    kind: 'card',
    label: 'HDFC •••• 4821',
    brand: 'HDFC',
    last4: '4821',
    isPrimary: true,
    isFixed: false,
    removable: true,
    tokenRef: 'tok_seed_4821',
    createdAt: activatedAt,
  });

  const subscription = {
    id: 'sub_demo_sivaganga',
    memberId: '0500',
    plotKey: 'sivaganga-1',
    planKey: 'family8',
    status: 'active',
    totalInr: 250000,
    cycleStart: '2026-07-01',
    cycleEnd: '2027-07-01',
    cycleStartLabel: 'Jul 2026',
    cycleEndLabel: 'Jul 2027',
    billPaid: false,
    billingMode: 'manual',
    nextBillDue: '2027-07-01',
    nextBillAmountInr: 250000,
    paymentId: 'pay_seed_lease',
    createdAt: activatedAt,
    updatedAt: now,
  };
  await db.collection('subscriptions').insertOne(subscription);

  // Decrement one unit for the demo lease
  await db.collection('plots').updateOne(
    { key: 'sivaganga-1' },
    { $inc: { availableUnits: -1 } }
  );

  await db.collection('payments').insertMany([
    {
      id: 'pay_seed_membership',
      ref: 'CHEDI-R-20260720-001',
      memberId: '0500',
      context: 'membership',
      status: 'succeeded',
      amountInr: 500,
      amountFormatted: formatInr(500),
      currency: 'INR',
      method: 'bank_transfer',
      label: 'Farm Club membership (one-time)',
      date: '2026-07-20',
      dueDate: '2026-07-27',
      collectedAt: '2026-07-20',
      approvedAt: activatedAt,
      approvedBy: 'sundar',
      receiptUrl: null,
      metadata: {},
      createdAt: activatedAt,
      updatedAt: activatedAt,
    },
    {
      id: 'pay_seed_lease',
      ref: 'CHEDI-R-20260720-002',
      memberId: '0500',
      context: 'lease',
      status: 'succeeded',
      amountInr: 250000,
      amountFormatted: formatInr(250000),
      currency: 'INR',
      method: 'bank_transfer',
      label: 'Annual subscription · Sivaganga-1 · Family of 8',
      date: '2026-07-20',
      dueDate: '2026-07-27',
      collectedAt: '2026-07-20',
      approvedAt: activatedAt,
      approvedBy: 'sundar',
      receiptUrl: null,
      metadata: { plotKey: 'sivaganga-1', planKey: 'family8', subscriptionId: 'sub_demo_sivaganga' },
      createdAt: activatedAt,
      updatedAt: activatedAt,
    },
  ]);

  await seedDeliverySchedule('0500', 'sub_demo_sivaganga');

  const { seedAdmin } = require('./adminSeed');
  const admin = await seedAdmin(db);

  await db.collection('notifications').insertMany([
    {
      id: 'ntf_1',
      memberId: '0500',
      icon: 'truck',
      title: 'Out for delivery',
      description: 'Your Saturday basket from Sivaganga-1 is on the way.',
      createdAt: new Date('2026-07-25T06:00:00Z'),
      unread: true,
      deepLinkTab: 'deliveries',
      deepLinkPath: '/app/deliveries',
    },
    {
      id: 'ntf_2',
      memberId: '0500',
      icon: 'leaf',
      title: 'Harvest update',
      description: 'Tomatoes on Sivaganga-1 are fruiting this week.',
      createdAt: new Date('2026-07-24T10:00:00Z'),
      unread: true,
      deepLinkTab: 'my-plot',
      deepLinkPath: '/app/my-plot',
    },
    {
      id: 'ntf_3',
      memberId: '0500',
      icon: 'card',
      title: 'Membership activated',
      description: 'Welcome to Farm Club. Your ₹500 membership is active.',
      createdAt: activatedAt,
      unread: false,
      deepLinkTab: 'overview',
      deepLinkPath: '/app/overview',
    },
  ]);

  console.log('Seed complete.');
  console.log('  Demo member: Priya Balan · priya@email.com');
  console.log('  Demo OTP (non-prod): 1234');
  console.log(`  Staff login: anitha@chedi.in / ${admin.staffPassword}`);
}

if (require.main === module) {
  seed()
    .then(() => closeDB())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { seed };
