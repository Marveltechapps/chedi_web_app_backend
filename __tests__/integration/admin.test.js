const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createApp } = require('../../app');
const { connectDB, closeDB, getDB } = require('../../config/db');
const { seed } = require('../../seed/seed');

describe('admin console API', () => {
  let mongod;
  let app;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    process.env.MONGODB_DB = 'chedi_admin_test';
    process.env.STAFF_SEED_PASSWORD = 'ChediAdmin123!';
    await connectDB();
    await seed();
    app = createApp();
  });

  afterAll(async () => {
    await closeDB();
    if (mongod) await mongod.stop();
  });

  async function login(email = 'anitha@chedi.in', password = 'ChediAdmin123!') {
    const res = await request(app).post('/api/v1/admin/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.staff.role).toBeTruthy();
    return res.body.data.accessToken;
  }

  it('rejects unknown staff', async () => {
    const res = await request(app)
      .post('/api/v1/admin/login')
      .send({ email: 'nobody@chedi.in', password: 'ChediAdmin123!' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns dashboard KPIs for staff JWT', async () => {
    const token = await login();
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.kpis.totalMembers).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data.pendingActions)).toBe(true);
  });

  it('lists members with filter counts', async () => {
    const token = await login();
    const res = await request(app)
      .get('/api/v1/admin/members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.counts.all).toBeGreaterThanOrEqual(1);
    expect(res.body.data.some((m) => m.id === '0500')).toBe(true);
  });

  it('forbids farm manager from marking payments', async () => {
    const token = await login('murugan@chedi.in');
    const db = getDB();
    const pay = await db.collection('payments').findOne({ context: 'lease' });
    const res = await request(app)
      .post(`/api/v1/admin/payments/${pay.id}/mark-paid`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'test-forbid-1')
      .send({ method: 'upi' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('keeps legacy approve working with shared secret', async () => {
    const res = await request(app)
      .get('/api/v1/admin/payments?status=all')
      .set('Authorization', 'Bearer chedi-admin-demo');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('returns staff list and settings', async () => {
    const token = await login();
    const staff = await request(app).get('/api/v1/admin/staff').set('Authorization', `Bearer ${token}`);
    expect(staff.body.data.map((s) => s.id)).toEqual(
      expect.arrayContaining(['anitha', 'murugan', 'sundar', 'kavya', 'ramesh'])
    );
    const settings = await request(app).get('/api/v1/admin/settings').set('Authorization', `Bearer ${token}`);
    expect(settings.body.data.membershipFeeInr).toBe(500);
  });
});
