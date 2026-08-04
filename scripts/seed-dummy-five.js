/**
 * Inserts 5 dummy member records (non-destructive).
 * Usage: node scripts/seed-dummy-five.js
 */
require('dotenv').config();

const { connectDB, closeDB, getDB } = require('../config/db');
const { displayPhone } = require('../lib/phone');
const { ensureFixedNetBanking } = require('../lib/payments');

const DUMMY_MEMBERS = [
  {
    id: '0601',
    name: 'Arun Kumar',
    phone: '+919876543210',
    email: 'arun.kumar@example.com',
    address: {
      label: 'Home',
      line: '21, Lake View Road, T Nagar',
      city: 'Chennai',
      pin: '600017',
    },
  },
  {
    id: '0602',
    name: 'Meera Iyer',
    phone: '+919811122233',
    email: 'meera.iyer@example.com',
    address: {
      label: 'Home',
      line: '8, Temple Street, Mylapore',
      city: 'Chennai',
      pin: '600004',
    },
  },
  {
    id: '0603',
    name: 'Karthik Rajan',
    phone: '+919900112233',
    email: 'karthik.rajan@example.com',
    address: {
      label: 'Home',
      line: '45, Cross Cut Road',
      city: 'Coimbatore',
      pin: '641012',
    },
  },
  {
    id: '0604',
    name: 'Divya Nair',
    phone: '+919944556677',
    email: 'divya.nair@example.com',
    address: {
      label: 'Home',
      line: '3, Beach Road, Neelankarai',
      city: 'Chennai',
      pin: '600115',
    },
  },
  {
    id: '0605',
    name: 'Suresh Pandian',
    phone: '+919955667788',
    email: 'suresh.pandian@example.com',
    address: {
      label: 'Home',
      line: '17, Anna Nagar West',
      city: 'Madurai',
      pin: '625020',
    },
  },
];

async function seedFive() {
  await connectDB();
  const db = getDB();
  const now = new Date();
  const memberSince = now.toISOString().slice(0, 10);

  let inserted = 0;
  let skipped = 0;

  for (const item of DUMMY_MEMBERS) {
    const existing = await db.collection('members').findOne({
      $or: [{ id: item.id }, { phone: item.phone }, { email: item.email }],
      deletedAt: null,
    });
    if (existing) {
      console.log(`  skip ${item.id} (${item.name}) — already exists`);
      skipped += 1;
      continue;
    }

    await db.collection('members').insertOne({
      id: item.id,
      memberCode: `CHEDI-${item.id}`,
      name: item.name,
      phone: item.phone,
      phoneDisplay: displayPhone(item.phone),
      email: item.email,
      isMember: true,
      memberSince,
      hasPlot: false,
      plotCount: 0,
      statusLabel: 'Member · no plot yet',
      preferences: {
        notifications: { delivery: true, harvest: true, promos: false },
        channel: 'push',
      },
      activeSubscriptionId: null,
      welcomeBasket: {
        status: 'dispatched',
        etaLabel: 'Soon',
        etaDate: memberSince,
        imageUrl: 'https://chediwebsite.s3.us-east-1.amazonaws.com/images/2148224020.jpg',
        description: 'Seasonal vegetable sample box',
      },
      membershipFeePaidInr: 500,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    await db.collection('addresses').insertOne({
      id: `addr_dummy_${item.id}`,
      memberId: item.id,
      label: item.address.label,
      line: item.address.line,
      city: item.address.city,
      pin: item.address.pin,
      isDefault: true,
      createdAt: now,
    });

    await ensureFixedNetBanking(item.id);
    inserted += 1;
    console.log(`  + ${item.id} ${item.name} · ${item.phone}`);
  }

  // Keep memberId counter above seeded IDs
  await db.collection('counters').updateOne(
    { _id: 'memberId' },
    { $max: { seq: 605 } },
    { upsert: true }
  );

  console.log(`Done. inserted=${inserted} skipped=${skipped}`);
  await closeDB();
}

seedFive().catch((err) => {
  console.error(err);
  process.exit(1);
});
