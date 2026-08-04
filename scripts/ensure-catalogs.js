require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB, closeDB, getDB } = require('../config/db');

async function ensureCatalogs() {
  await connectDB();
  const db = getDB();

  const plots = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plots.json'), 'utf8'));
  const plans = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plans.json'), 'utf8'));

  if (!(await db.collection('plots').countDocuments())) {
    await db.collection('plots').insertMany(plots);
    console.log('plots inserted', plots.length);
  } else {
    console.log('plots already present');
  }

  if (!(await db.collection('plans').countDocuments())) {
    await db.collection('plans').insertMany(plans);
    console.log('plans inserted', plans.length);
  } else {
    console.log('plans already present');
  }

  if (!(await db.collection('produce_shares').countDocuments())) {
    const staples = [
      ['Onion', '500 g'],
      ['Ginger', '100 g'],
      ['Tomato', '1 kg'],
      ['Green Chilli', '200 g'],
      ['Coriander', '2 bunches'],
    ].map(([name, qty], i) => ({ no: i + 1, name, qty }));
    const seasonal = [
      ['Brinjal', '1 kg'],
      ["Lady's Finger", '750 g'],
      ['Carrot', '1 kg'],
      ['Beetroot', '750 g'],
      ['Cabbage', '1 head'],
    ].map(([name, qty], i) => ({ no: i + 1, name, qty }));
    await db.collection('produce_shares').insertOne({
      planKey: 'default',
      staples,
      seasonal,
    });
    console.log('produce_shares inserted');
  }

  console.log(
    'counts',
    'members=',
    await db.collection('members').countDocuments({ deletedAt: null }),
    'plots=',
    await db.collection('plots').countDocuments(),
    'plans=',
    await db.collection('plans').countDocuments()
  );
  await closeDB();
}

ensureCatalogs().catch((err) => {
  console.error(err);
  process.exit(1);
});
