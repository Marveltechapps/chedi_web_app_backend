const path = require('path');
const http = require('http');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createApp } = require('../../app');
const { connectDB, closeDB, getDB } = require('../../config/db');
const { seed } = require('../../seed/seed');
const { attachRealtime, closeRealtime, EVENTS, ROOMS } = require('../../lib/realtime');
const jwtService = require('../../services/jwt.service');
const { toMemberSummary } = require('../../lib/members');

const clientPath = path.resolve(__dirname, '../../../chedi_web_app/node_modules/socket.io-client');
const { io: Client } = require(clientPath);

function waitFor(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Socket.IO realtime', () => {
  let mongod;
  let app;
  let server;
  let port;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    process.env.MONGODB_DB = 'chedi_realtime_test';
    process.env.STAFF_SEED_PASSWORD = 'ChediAdmin123!';
    await connectDB();
    await seed();
    app = createApp();
    server = http.createServer(app);
    attachRealtime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await closeRealtime();
    await new Promise((resolve) => server.close(resolve));
    await closeDB();
    if (mongod) await mongod.stop();
  });

  function clientOpts(token) {
    return {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      auth: token ? { token } : {},
      reconnection: false,
    };
  }

  async function memberToken() {
    const member = await getDB().collection('members').findOne({ id: '0500' });
    const tokens = await jwtService.issueTokens(toMemberSummary(member));
    return tokens.accessToken;
  }

  async function staffToken() {
    const res = await request(app).post('/api/v1/admin/login').send({
      email: 'anitha@chedi.in',
      password: 'ChediAdmin123!',
    });
    expect(res.status).toBe(200);
    return res.body.data.accessToken;
  }

  it('exposes admin and customer room helpers', () => {
    expect(ROOMS.ADMIN).toBe('admin');
    expect(ROOMS.customer('0500')).toBe('customer:0500');
    expect(EVENTS.ADDRESS_UPDATED).toBe('customer:address:updated');
  });

  it('rejects unauthenticated sockets', async () => {
    const socket = Client(`http://127.0.0.1:${port}`, clientOpts());
    const err = await waitFor(socket, 'connect_error');
    expect(String(err.message || err)).toMatch(/token|unauthorized|expired|invalid/i);
    socket.close();
  });

  it('joins staff to admin and members to their customer room', async () => {
    const [adminJwt, memberJwt] = await Promise.all([staffToken(), memberToken()]);
    const adminSock = Client(`http://127.0.0.1:${port}`, clientOpts(adminJwt));
    const memberSock = Client(`http://127.0.0.1:${port}`, clientOpts(memberJwt));
    const [adminReady, memberReady] = await Promise.all([
      waitFor(adminSock, 'realtime:ready'),
      waitFor(memberSock, 'realtime:ready'),
    ]);
    expect(adminReady.kind).toBe('staff');
    expect(memberReady.kind).toBe('member');

    const forbidden = waitFor(memberSock, 'realtime:error');
    memberSock.emit('join', 'admin');
    const denied = await forbidden;
    expect(denied.code).toBe('FORBIDDEN');

    adminSock.close();
    memberSock.close();
  });

  it('emits address updates to admin after a successful member PATCH', async () => {
    const [adminJwt, memberJwt] = await Promise.all([staffToken(), memberToken()]);
    const adminSock = Client(`http://127.0.0.1:${port}`, clientOpts(adminJwt));
    await waitFor(adminSock, 'realtime:ready');
    const received = waitFor(adminSock, EVENTS.ADDRESS_UPDATED);

    const nextLine = '88, Realtime Lane, Besant Nagar';
    const res = await request(app)
      .patch('/api/v1/addresses/addr_a1')
      .set('Authorization', `Bearer ${memberJwt}`)
      .send({ line: nextLine });
    expect(res.status).toBe(200);
    expect(res.body.address.line).toBe(nextLine);

    const payload = await received;
    expect(payload.memberId).toBe('0500');
    expect(payload.address.line).toBe(nextLine);
    expect(payload.member.addressDisplay).toContain(nextLine);
    expect(payload.member.city).toBe('Chennai');

    adminSock.close();
  });

  it('does not emit when an address update fails validation lookup', async () => {
    const memberJwt = await memberToken();
    const adminJwt = await staffToken();
    const adminSock = Client(`http://127.0.0.1:${port}`, clientOpts(adminJwt));
    await waitFor(adminSock, 'realtime:ready');

    let emitted = false;
    adminSock.on(EVENTS.ADDRESS_UPDATED, () => {
      emitted = true;
    });

    const res = await request(app)
      .patch('/api/v1/addresses/does-not-exist')
      .set('Authorization', `Bearer ${memberJwt}`)
      .send({ line: 'Should not save' });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 400));
    expect(emitted).toBe(false);
    adminSock.close();
  });

  it('emits profile updates to the customer after an admin member PATCH', async () => {
    const [adminJwt, memberJwt] = await Promise.all([staffToken(), memberToken()]);
    const memberSock = Client(`http://127.0.0.1:${port}`, clientOpts(memberJwt));
    await waitFor(memberSock, 'realtime:ready');
    const received = waitFor(memberSock, EVENTS.CUSTOMER_PROFILE_UPDATED);

    const res = await request(app)
      .patch('/api/v1/admin/members/0500')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'Priya Realtime' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Priya Realtime');

    const payload = await received;
    expect(payload.memberId).toBe('0500');
    expect(payload.member.name).toBe('Priya Realtime');

    memberSock.close();
  });
});
