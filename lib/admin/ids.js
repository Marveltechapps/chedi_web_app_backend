const { getDB } = require('../../config/db');
const { nanoid } = require('nanoid');

async function nextSeq(name, startAt = 1) {
  const db = getDB();
  const counter = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = (counter && (counter.seq ?? counter.value?.seq)) || startAt;
  return seq;
}

function newId(prefix, size = 8) {
  return `${prefix}${nanoid(size)}`;
}

module.exports = { nextSeq, newId };
