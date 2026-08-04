require('dotenv').config();
const { connectDB, closeDB, getDB } = require('../config/db');

async function main() {
  await connectDB();
  const db = getDB();
  const plots = await db.collection('plots').find({}).toArray();
  for (const p of plots) {
    const total = Math.max(p.totalUnits || 0, 5);
    await db.collection('plots').updateOne(
      { _id: p._id },
      { $set: { totalUnits: total, availableUnits: total, status: 'available' } }
    );
  }
  const after = await db
    .collection('plots')
    .find({}, { projection: { key: 1, availableUnits: 1, totalUnits: 1, status: 1 } })
    .toArray();
  console.log(after);
  await closeDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
