const { Server } = require('socket.io');
const { verifyAccessToken } = require('../services/jwt.service');
const { findMemberById } = require('./members');
const { getDB } = require('../config/db');
const { toStaffDto } = require('./admin/dto');
const { socketCorsOptions } = require('./cors');

const EVENTS = {
  CUSTOMER_CREATED: 'customer:created',
  CUSTOMER_UPDATED: 'customer:updated',
  CUSTOMER_DELETED: 'customer:deleted',
  CUSTOMER_PROFILE_UPDATED: 'customer:profile_updated',
  ADDRESS_CREATED: 'customer:address:created',
  ADDRESS_UPDATED: 'customer:address:updated',
  ADDRESS_DELETED: 'customer:address:deleted',
  PAYMENT_CREATED: 'payment:created',
  PAYMENT_UPDATED: 'payment:updated',
  SUBSCRIPTION_CREATED: 'subscription:created',
  SUBSCRIPTION_UPDATED: 'subscription:updated',
  DELIVERY_UPDATED: 'delivery:updated',
  NOTIFICATION_CREATED: 'notification:created',
  PLOT_UPDATED: 'plot:updated',
  CROP_UPDATED: 'crop:updated',
  BASKET_UPDATED: 'basket:updated',
  TICKET_UPDATED: 'ticket:updated',
  CANCELLATION_UPDATED: 'cancellation:updated',
  PAYMENT_METHOD_UPDATED: 'payment_method:updated',
};

const ROOMS = {
  ADMIN: 'admin',
  MEMBERS: 'members',
  customer: (memberId) => `customer:${memberId}`,
};

let io = null;

function handshakeToken(socket) {
  const authToken = socket.handshake?.auth?.token;
  if (authToken && typeof authToken === 'string') return authToken.trim();
  const queryToken = socket.handshake?.query?.token;
  if (queryToken && typeof queryToken === 'string') return queryToken.trim();
  const header = socket.handshake?.headers?.authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function loadStaff(staffId) {
  const db = getDB();
  return db.collection('staff').findOne({ id: staffId, active: { $ne: false } });
}

function rejectAuth(message, code = 'UNAUTHORIZED') {
  const err = new Error(message);
  err.data = { code, message };
  return err;
}

async function authenticateSocket(socket) {
  const token = handshakeToken(socket);
  if (!token) {
    throw rejectAuth('Missing socket authentication token');
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw rejectAuth('Invalid or expired access token');
  }
  if (!payload || !payload.sub) {
    throw rejectAuth('Invalid or expired access token');
  }

  if (payload.typ === 'staff_access') {
    const staff = await loadStaff(payload.sub);
    if (!staff) throw rejectAuth('Invalid admin credentials');
    return {
      kind: 'staff',
      id: staff.id,
      role: staff.role,
      staff: toStaffDto(staff),
    };
  }

  if (payload.typ === 'access' || !payload.typ) {
    const member = await findMemberById(payload.sub);
    if (!member || !member.isMember) {
      throw rejectAuth('Member session is no longer valid');
    }
    return {
      kind: 'member',
      id: member.id,
      role: 'member',
      memberId: member.id,
    };
  }

  throw rejectAuth('Invalid or expired access token');
}

function joinAssignedRooms(socket, identity) {
  if (identity.kind === 'staff') {
    socket.join(ROOMS.ADMIN);
    return;
  }
  socket.join(ROOMS.MEMBERS);
  socket.join(ROOMS.customer(identity.id));
}

function bindSocketGuards(socket) {
  socket.on('join', (room) => {
    socket.emit('realtime:error', {
      code: 'FORBIDDEN',
      message: 'Unauthorized room access',
      room: room || null,
    });
  });
  socket.on('leave', () => {
    socket.emit('realtime:error', {
      code: 'FORBIDDEN',
      message: 'Rooms are assigned by the server',
    });
  });
}

function attachRealtime(httpServer) {
  if (!httpServer) {
    throw new Error('attachRealtime requires an HTTP server');
  }
  if (io) {
    io.attach(httpServer);
    return io;
  }

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: socketCorsOptions(),
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 15000,
    allowEIO3: false,
  });

  io.use(async (socket, next) => {
    try {
      const identity = await authenticateSocket(socket);
      socket.data.identity = identity;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    const identity = socket.data.identity;
    if (!identity) {
      socket.emit('realtime:error', { code: 'UNAUTHORIZED', message: 'Authentication failed' });
      socket.disconnect(true);
      return;
    }
    joinAssignedRooms(socket, identity);
    bindSocketGuards(socket);
    socket.emit('realtime:ready', {
      ok: true,
      kind: identity.kind,
      role: identity.role,
    });
  });

  io.engine.on('connection_error', (err) => {
    console.error('[realtime] connection_error', err && err.message);
  });

  return io;
}

function getIO() {
  return io;
}

function closeRealtime() {
  if (!io) return Promise.resolve();
  return new Promise((resolve) => {
    const current = io;
    const timer = setTimeout(() => {
      io = null;
      resolve();
    }, 2000);
    current.close(() => {
      clearTimeout(timer);
      io = null;
      resolve();
    });
  });
}

function isValidPayload(payload) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
}

function stamp(payload) {
  return {
    ...payload,
    occurredAt: payload.occurredAt || new Date().toISOString(),
  };
}

function emitToAdmin(event, payload) {
  if (!io || !event || !isValidPayload(payload)) return false;
  io.to(ROOMS.ADMIN).emit(event, stamp(payload));
  return true;
}

function emitToCustomer(memberId, event, payload) {
  if (!io || !memberId || !event || !isValidPayload(payload)) return false;
  io.to(ROOMS.customer(memberId)).emit(event, stamp(payload));
  return true;
}

function emitToMembers(event, payload) {
  if (!io || !event || !isValidPayload(payload)) return false;
  io.to(ROOMS.MEMBERS).emit(event, stamp(payload));
  return true;
}

function emitToAdminAndCustomer(memberId, event, payload) {
  emitToAdmin(event, payload);
  if (memberId) emitToCustomer(memberId, event, payload);
}

async function emitSafe(task) {
  try {
    await task;
  } catch (err) {
    console.error('[realtime] emit failed:', err && err.message);
  }
}

function toPublicAddress(a) {
  if (!a) return null;
  return {
    id: a.id,
    label: a.label || 'Home',
    line: a.line,
    city: a.city,
    pin: a.pin,
    isDefault: Boolean(a.isDefault),
  };
}

async function listMemberAddresses(memberId) {
  const db = getDB();
  const items = await db
    .collection('addresses')
    .find({ memberId })
    .sort({ isDefault: -1, createdAt: 1 })
    .toArray();
  return items.map(toPublicAddress);
}

async function hydrateMemberDto(memberId) {
  if (!memberId) return null;
  const { hydrateMember } = require('./admin/members.service');
  const { findMemberByAnyId } = require('./admin/lookups');
  const doc = await findMemberByAnyId(memberId);
  if (!doc) return null;
  return hydrateMember(doc);
}

async function activeSubscriberIds() {
  const db = getDB();
  return db.collection('subscriptions').distinct('memberId', {
    status: { $in: ['active', 'past_due'] },
  });
}

async function notifyAddressChange(event, memberId, extra = {}) {
  if (!memberId || !event) return;
  const addresses = extra.addresses || (await listMemberAddresses(memberId));
  const member = extra.member || (await hydrateMemberDto(memberId));
  const payload = {
    memberId,
    address: extra.address || null,
    addressId: extra.addressId || extra.address?.id || null,
    addresses,
    member,
  };
  emitToAdminAndCustomer(memberId, event, payload);
}

async function notifyMemberChange(event, memberId, extra = {}) {
  if (!event) return;
  const member = extra.member || (memberId ? await hydrateMemberDto(memberId) : null);
  const id = memberId || member?.id || null;
  emitToAdminAndCustomer(id, event, { ...extra, memberId: id, member });
}

async function notifyPaymentChange(event, extra = {}) {
  const payment = extra.payment || extra.data?.payment || extra.data || extra;
  const memberId = extra.memberId || payment?.memberId || null;
  const payload = { memberId, payment };
  emitToAdminAndCustomer(memberId, event, payload);
  if (memberId) {
    const member = await hydrateMemberDto(memberId);
    if (member) emitToAdminAndCustomer(memberId, EVENTS.CUSTOMER_UPDATED, { memberId, member });
  }
}

async function notifySubscriptionChange(event, extra = {}) {
  const subscription = extra.subscription || extra.data || extra;
  const memberId = extra.memberId || subscription?.memberId || null;
  emitToAdminAndCustomer(memberId, event, { memberId, subscription });
  if (memberId) {
    const member = await hydrateMemberDto(memberId);
    if (member) emitToAdminAndCustomer(memberId, EVENTS.CUSTOMER_UPDATED, { memberId, member });
  }
}

async function notifyDeliveryChange(extra = {}) {
  const delivery = extra.delivery || extra;
  const memberId = extra.memberId || delivery?.memberId || null;
  emitToAdminAndCustomer(memberId, EVENTS.DELIVERY_UPDATED, { memberId, delivery });
}

async function notifyCancellationChange(extra = {}) {
  const cancellation = extra.cancellation || extra;
  const memberId = extra.memberId || cancellation?.memberId || null;
  emitToAdminAndCustomer(memberId, EVENTS.CANCELLATION_UPDATED, { memberId, cancellation });
}

async function notifyPlotChange(extra = {}) {
  const plot = extra.plot || extra;
  const memberId = extra.memberId || plot?.memberId || null;
  const payload = { memberId, plot };
  emitToAdmin(EVENTS.PLOT_UPDATED, payload);
  emitToMembers(EVENTS.PLOT_UPDATED, payload);
}

async function notifyCropChange(extra = {}) {
  const crop = extra.crop || extra.cultivation || extra;
  const memberId = extra.memberId || crop?.memberId || null;
  emitToAdmin(EVENTS.CROP_UPDATED, { memberId, ...extra, crop });
  if (memberId) emitToCustomer(memberId, EVENTS.CROP_UPDATED, { memberId, crop });
}

async function notifyBasketChange(extra = {}) {
  const basket = extra.basket || extra;
  const memberIds = extra.memberIds || (await activeSubscriberIds());
  emitToAdmin(EVENTS.BASKET_UPDATED, { basket, memberIds });
  for (const id of memberIds || []) {
    emitToCustomer(id, EVENTS.BASKET_UPDATED, { memberId: id, basket });
  }
}

async function notifyTicketChange(extra = {}) {
  const ticket = extra.ticket || extra;
  const memberId = extra.memberId || ticket?.memberId || null;
  emitToAdminAndCustomer(memberId, EVENTS.TICKET_UPDATED, { memberId, ticket });
}

function notifyNotificationCreated(memberId, notification) {
  if (!memberId || !notification) return;
  emitToCustomer(memberId, EVENTS.NOTIFICATION_CREATED, { memberId, notification });
  emitToAdmin(EVENTS.NOTIFICATION_CREATED, {
    memberId,
    notification: {
      id: notification.id,
      title: notification.title,
      memberId,
    },
  });
}

async function notifyPaymentMethodChange(memberId, extra = {}) {
  emitToAdminAndCustomer(memberId, EVENTS.PAYMENT_METHOD_UPDATED, {
    memberId,
    paymentMethod: extra.paymentMethod || null,
    items: extra.items || null,
  });
}

function extractMemberId(data) {
  if (!data || typeof data !== 'object') return null;
  return (
    data.memberId ||
    data.id ||
    data.member?.id ||
    data.payment?.memberId ||
    data.subscription?.memberId ||
    data.ticket?.memberId ||
    data.delivery?.memberId ||
    null
  );
}

module.exports = {
  EVENTS,
  ROOMS,
  attachRealtime,
  getIO,
  closeRealtime,
  emitToAdmin,
  emitToCustomer,
  emitToAdminAndCustomer,
  emitSafe,
  notifyAddressChange,
  notifyMemberChange,
  notifyPaymentChange,
  notifySubscriptionChange,
  notifyDeliveryChange,
  notifyCancellationChange,
  notifyPlotChange,
  notifyCropChange,
  notifyBasketChange,
  notifyTicketChange,
  notifyNotificationCreated,
  notifyPaymentMethodChange,
  extractMemberId,
  toPublicAddress,
};
