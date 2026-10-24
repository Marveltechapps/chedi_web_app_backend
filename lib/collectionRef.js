const REF_PATTERN = /^(?:[A-Z0-9]{12}|[A-Z0-9]{16}|[A-Z0-9]{22})$/;
const UNIQUE_INDEX = 'payments_collectionRefNorm_unique';

function normalizeCollectionRef(raw) {
  const value = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  if (!value) {
    return { ok: false, message: 'Enter the payment reference / UTR' };
  }
  if (!REF_PATTERN.test(value)) {
    return {
      ok: false,
      message: 'Enter a UPI/IMPS (12), NEFT (16), or RTGS (22) UTR',
    };
  }
  return { ok: true, value, message: '' };
}

function formatCollectionRef(raw) {
  const parsed = normalizeCollectionRef(raw);
  if (!parsed.ok) return String(raw || '').trim();
  return parsed.value.replace(/(.{4})(?=.)/g, '$1 ');
}

async function ensureUniqueCollectionRefIndex(db) {
  const rows = await db.collection('payments')
    .find({ collectionRef: { $type: 'string' }, collectionRefNorm: { $exists: false } }, { projection: { collectionRef: 1 } })
    .toArray();
  const groups = new Map();
  for (const row of rows) {
    const parsed = normalizeCollectionRef(row.collectionRef);
    if (!parsed.ok) continue;
    const list = groups.get(parsed.value) || [];
    list.push(row._id);
    groups.set(parsed.value, list);
  }
  for (const [value, ids] of groups) {
    if (ids.length !== 1) continue;
    await db.collection('payments').updateOne(
      { _id: ids[0], collectionRefNorm: { $exists: false } },
      { $set: { collectionRefNorm: value } }
    );
  }
  await db.collection('payments').createIndex(
    { collectionRefNorm: 1 },
    {
      unique: true,
      partialFilterExpression: { collectionRefNorm: { $type: 'string' } },
      name: UNIQUE_INDEX,
    }
  );
}

module.exports = { normalizeCollectionRef, formatCollectionRef, ensureUniqueCollectionRefIndex, REF_PATTERN };
