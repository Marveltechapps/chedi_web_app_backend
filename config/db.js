const dns = require('dns');
const { MongoClient } = require('mongodb');

let client = null;
let db = null;

/**
 * Home/router DNS often fails SRV lookups for mongodb+srv:// (querySrv ECONNREFUSED).
 * Prefer public resolvers for Atlas connection strings only.
 */
function ensureSrvDns() {
  const uri = process.env.MONGODB_URI || '';
  if (!uri.startsWith('mongodb+srv://')) return;
  try {
    const current = dns.getServers();
    const preferred = ['8.8.8.8', '1.1.1.1'];
    const merged = [...new Set([...preferred, ...current])];
    dns.setServers(merged);
  } catch {
    /* ignore — fall through to system DNS */
  }
}

async function connectDB() {
  if (db) return db;

  ensureSrvDns();

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_DB || 'chedi_csa';
  const isAtlas = uri.startsWith('mongodb+srv://');

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: isAtlas ? 20000 : 5000,
    connectTimeoutMS: isAtlas ? 20000 : 5000,
  });
  await client.connect();
  db = client.db(dbName);
  return db;
}

function getDB() {
  if (!db) {
    throw new Error('Database not connected. Call connectDB() first.');
  }
  return db;
}

async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connectDB, getDB, closeDB };
