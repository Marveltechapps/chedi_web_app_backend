const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { normalizePhone, isValidIndianMobile, displayPhone } = require('../phone');
const { toPlan } = require('../serializers');
const { insertMemberNotification } = require('./notify');
const {
  toMemberDto,
  memberPublicId,
  farmFromPlotKey,
} = require('./dto');
const {
  requireMemberByAnyId,
  findMemberByAnyId,
  latestSubscription,
  defaultAddress,
  loadPlan,
  loadPlot,
  findRegistration,
} = require('./lookups');
const { findMemberByEmail, findMemberByPhone, nextMemberId, refreshMemberPlotStats, softDeleteMember } = require('../members');
const jwtService = require('../../services/jwt.service');
const { nanoid } = require('nanoid');
const { isoDate } = require('../dates');
const { buildWelcomeTracking } = require('../payments');

async function hydrateMember(member) {
  if (!member) return null;
  const db = getDB();
  const sub = await latestSubscription(member.id);
  let planKey = sub?.planKey || member.planKey;
  let plotKey = sub?.plotKey || member.plotKey;
  if (!planKey) {
    const pending = await db.collection('payments').findOne({
      memberId: member.id,
      context: 'lease',
      status: 'pending',
    });
    planKey = pending?.metadata?.planKey || planKey;
    plotKey = pending?.metadata?.plotKey || plotKey;
    if (pending && member.subStatus !== 'payment_pending') {
      member = { ...member, subStatus: 'payment_pending', hasPlot: true, planKey, plotKey };
    }
  }
  const plot = await loadPlot(plotKey);
  const plan = await loadPlan(planKey);
  const address = await defaultAddress(member.id);
  return toMemberDto(
    { ...member, planKey: planKey || member.planKey, plotKey: plotKey || member.plotKey, planName: member.planName || plan?.name, plotName: member.plotName || plot?.name },
    {
      subscription: sub,
      plot,
      plan,
      address,
      farm: farmFromPlotKey(plotKey || plot?.key),
    }
  );
}

function registrationAsMember(reg) {
  const address = reg.address || {};
  return toMemberDto(
    {
      id: reg.memberId || reg.id,
      memberCode: reg.memberCode || null,
      name: reg.name,
      phone: reg.phone,
      phoneDisplay: reg.phoneDisplay,
      email: reg.email,
      accountStatus: 'pending',
      subStatus: 'none',
      isMember: false,
      memberSince: isoDate(reg.createdAt),
      hasPlot: false,
      plotCount: 0,
      createdAt: reg.createdAt,
      preferences: {
        notifications: { delivery: true, harvest: true, promos: false },
        channel: 'push',
      },
      deletedAt: null,
    },
    {
      address: { line: address.line, city: address.city, pin: address.pin },
    }
  );
}

async function listPendingRegistrations() {
  const db = getDB();
  const regs = await db
    .collection('registrations')
    .find({ status: { $ne: 'completed' } })
    .toArray();
  const pending = [];
  for (const reg of regs) {
    const existing = await db.collection('members').findOne({
      deletedAt: null,
      $or: [{ phone: reg.phone }, { email: reg.email }],
    });
    if (existing?.isMember) continue;
    if (existing && !existing.isMember) {
      pending.push(await hydrateMember(existing));
    } else {
      pending.push(registrationAsMember(reg));
    }
  }
  return pending;
}

function matchesQuery(dto, q) {
  if (!q) return true;
  const hay = [dto.id, dto.name, dto.email, dto.phone, dto.phoneDisplay, dto.memberCode, dto.city]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function memberFilterMatch(dto, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'active') return dto.accountStatus === 'active';
  if (filter === 'pending') return dto.accountStatus === 'pending';
  if (filter === 'suspended') return dto.accountStatus === 'suspended';
  if (filter === 'renewal') return dto.subStatus === 'renewal_due';
  return true;
}

async function listMembers(query = {}) {
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const q = String(query.q || '').trim().toLowerCase();
  const filter = String(query.filter || 'all');
  const members = await db.collection('members').find({ deletedAt: null }).sort({ createdAt: -1 }).toArray();
  const hydrated = [];
  for (const m of members) hydrated.push(await hydrateMember(m));
  const pendingRegs = await listPendingRegistrations();
  const pendingIds = new Set(hydrated.filter((m) => m.accountStatus === 'pending').map((m) => m.id));
  for (const p of pendingRegs) {
    if (!pendingIds.has(p.id) && !hydrated.some((m) => m.email === p.email || m.phone === p.phone)) {
      hydrated.push(p);
    }
  }

  const counts = {
    all: hydrated.length,
    active: hydrated.filter((m) => m.accountStatus === 'active').length,
    pending: hydrated.filter((m) => m.accountStatus === 'pending').length,
    suspended: hydrated.filter((m) => m.accountStatus === 'suspended').length,
    renewal: hydrated.filter((m) => m.subStatus === 'renewal_due').length,
  };

  let rows = hydrated.filter((m) => matchesQuery(m, q) && memberFilterMatch(m, filter));
  return {
    data: slicePage(rows, page, limit),
    pagination: paginationMeta(page, limit, rows.length),
    meta: { counts },
  };
}

async function resolveMemberOrRegistration(memberId) {
  const member = await findMemberByAnyId(memberId);
  if (member) return { member, registration: null };
  const registration = await findRegistration(memberId);
  if (registration && registration.status !== 'completed') {
    return { member: null, registration };
  }
  throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Member not found');
}

async function getMemberDrawer(memberId) {
  const db = getDB();
  const { member, registration } = await resolveMemberOrRegistration(memberId);
  if (!member) {
    return {
      member: registrationAsMember(registration),
      addresses: registration.address
        ? [
            {
              id: 'addr_reg',
              label: registration.address.label || 'Home',
              line: registration.address.line,
              city: registration.address.city,
              pin: registration.address.pin,
              isDefault: true,
            },
          ]
        : [],
      paymentMethods: [],
      payments: await db
        .collection('payments')
        .find({ 'metadata.registrationId': registration.id })
        .sort({ createdAt: -1 })
        .toArray(),
      deliveries: [],
      subscriptions: [],
      timeline: [
        {
          action: 'Registration submitted',
          timeLabel: registration.createdAt ? require('../dates').formatJoinedLabel(registration.createdAt) : '',
        },
      ],
    };
  }

  const dto = await hydrateMember(member);
  const addresses = await db.collection('addresses').find({ memberId: member.id }).sort({ isDefault: -1 }).toArray();
  const paymentMethods = await db.collection('payment_methods').find({ memberId: member.id }).toArray();
  const payments = await db.collection('payments').find({ memberId: member.id }).sort({ createdAt: -1 }).toArray();
  const deliveries = await db.collection('deliveries').find({ memberId: member.id }).sort({ weekIndex: 1 }).toArray();
  const subscriptions = await db.collection('subscriptions').find({ memberId: member.id }).sort({ createdAt: -1 }).toArray();
  const { toPaymentDto, toDeliveryDto, toSubscriptionDto } = require('./dto');
  const planCache = {};
  const plotCache = {};
  const subDtos = [];
  for (const s of subscriptions) {
    if (s.planKey && !planCache[s.planKey]) planCache[s.planKey] = await loadPlan(s.planKey);
    if (s.plotKey && !plotCache[s.plotKey]) plotCache[s.plotKey] = await loadPlot(s.plotKey);
    subDtos.push(
      toSubscriptionDto(s, { member, plot: plotCache[s.plotKey], plan: planCache[s.planKey] })
    );
  }
  const { toAuditDto } = require('../audit');
  let timeline = await db
    .collection('audit_log')
    .find({
      $or: [{ 'meta.memberId': member.id }, { entity: member.memberCode }, { entity: memberPublicId(member) }],
    })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  if (!timeline.length) {
    timeline = [
      {
        action: 'Member joined CHEDI Farm Club',
        timeLabel: dto.joinedLabel,
      },
    ];
  } else {
    timeline = timeline.map(toAuditDto);
  }

  const addrDefault = addresses.find((a) => a.isDefault) || addresses[0];
  const addressDisplay = addrDefault
    ? `${addrDefault.line}, ${addrDefault.city} ${addrDefault.pin}`
    : dto.addressDisplay;

  return {
    member: dto,
    addresses: addresses.map((a) => ({
      id: a.id,
      label: a.label,
      line: a.line,
      city: a.city,
      pin: a.pin,
      isDefault: Boolean(a.isDefault),
    })),
    paymentMethods: paymentMethods.map((pm) => ({
      id: pm.id,
      kind: pm.kind,
      label: pm.label,
      isPrimary: Boolean(pm.isPrimary),
      removable: pm.removable !== false && !pm.isFixed,
    })),
    payments: payments.map((p) =>
      toPaymentDto(p, {
        memberId: member.id,
        memberCode: memberPublicId(member),
        memberName: member.name,
        memberEmail: member.email,
        memberPhone: member.phoneDisplay,
      })
    ),
    deliveries: deliveries.map((d) =>
      toDeliveryDto(d, {
        memberId: member.id,
        memberCode: memberPublicId(member),
        memberName: member.name,
        addressDisplay,
        plotKey: dto.plotKey,
        plotName: dto.plotName,
        boxesPerWeek: dto.planKey === 'family12' ? 3 : dto.planKey === 'family8' ? 2 : 1,
      })
    ),
    subscriptions: subDtos,
    timeline,
  };
}

async function cancelUpcomingDeliveries(memberId) {
  const db = getDB();
  await db.collection('deliveries').updateMany(
    { memberId, opsStatus: { $in: ['scheduled', 'packed'] } },
    {
      $set: {
        opsStatus: 'cancelled',
        cancelled: true,
        cancellable: false,
        locked: true,
        updatedAt: new Date(),
      },
    }
  );
}

async function releasePlotForMember(member, { keepAccountActive }) {
  const db = getDB();
  const subs = await db
    .collection('subscriptions')
    .find({ memberId: member.id, status: { $in: ['active', 'past_due', 'paused', 'payment_pending', 'pending_activation'] } })
    .toArray();
  for (const sub of subs) {
    if (sub.plotKey) {
      const plot = await loadPlot(sub.plotKey);
      if (plot) {
        const nextUnits = (plot.availableUnits || 0) + 1;
        const nextStatus =
          plot.status === 'soon' ? 'soon' : nextUnits > 0 && plot.status === 'booked' ? 'available' : plot.status;
        await db.collection('plots').updateOne(
          { key: plot.key },
          { $set: { availableUnits: nextUnits, status: nextStatus, updatedAt: new Date() } }
        );
      }
    }
    await db.collection('subscriptions').updateOne(
      { id: sub.id },
      { $set: { status: 'cancelled', updatedAt: new Date() } }
    );
  }
  await cancelUpcomingDeliveries(member.id);
  const $set = {
    hasPlot: false,
    plotCount: 0,
    plotKey: null,
    subStatus: 'cancelled',
    activeSubscriptionId: null,
    statusLabel: keepAccountActive ? 'Member · no plot yet' : 'Cancelled',
    updatedAt: new Date(),
  };
  if (!keepAccountActive) {
    $set.accountStatus = 'cancelled';
    $set.isMember = false;
  }
  await db.collection('members').updateOne({ id: member.id }, { $set });
}

async function welcomeBasketFor(now = new Date()) {
  const etaDays = Number(process.env.WELCOME_BASKET_ETA_DAYS || 2);
  const eta = new Date(now.getTime() + etaDays * 24 * 60 * 60 * 1000);
  return {
    status: 'dispatched',
    etaLabel: eta.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
    etaDate: eta.toISOString().slice(0, 10),
    imageUrl: 'https://chediwebsite.s3.us-east-1.amazonaws.com/images/2148224020.jpg',
    description: 'Token of Love',
    tracking: buildWelcomeTracking(now, eta),
  };
}

async function activateMember(memberId, staff) {
  const db = getDB();
  const { member, registration } = await resolveMemberOrRegistration(memberId);
  let doc = member;
  if (!doc) {
    const now = new Date();
    const id = await nextMemberId();
    doc = {
      id,
      memberCode: `CHEDI-${id}`,
      name: registration.name,
      phone: registration.phone,
      phoneDisplay: registration.phoneDisplay,
      email: registration.email,
      isMember: true,
      accountStatus: 'active',
      subStatus: 'none',
      memberSince: isoDate(now),
      hasPlot: false,
      plotCount: 0,
      statusLabel: 'Member · no plot yet',
      welcomeBasket: await welcomeBasketFor(now),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await db.collection('members').insertOne(doc);
    if (registration.address) {
      await db.collection('addresses').insertOne({
        id: `addr_${nanoid(6)}`,
        memberId: id,
        label: registration.address.label || 'Home',
        line: registration.address.line,
        city: registration.address.city,
        pin: registration.address.pin,
        isDefault: true,
        createdAt: now,
      });
    }
    await db.collection('registrations').updateOne(
      { id: registration.id },
      { $set: { status: 'completed', memberId: id, updatedAt: now } }
    );
  } else {
    const current = doc.accountStatus || (doc.isMember ? 'active' : 'pending');
    if (current !== 'pending') {
      throw new ApiError(409, 'INVALID_STATUS', 'Member is not pending activation');
    }
    const now = new Date();
    await db.collection('members').updateOne(
      { id: doc.id },
      {
        $set: {
          isMember: true,
          accountStatus: 'active',
          statusLabel: 'Member · no plot yet',
          welcomeBasket: doc.welcomeBasket || (await welcomeBasketFor(now)),
          updatedAt: now,
        },
      }
    );
  }
  await insertMemberNotification({
    memberId: doc.id,
    icon: 'users',
    title: 'Account update',
    body: 'Your account is active.',
    deepLinkTab: 'overview',
    deepLinkPath: '/app/overview',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Member activate',
    entity: memberPublicId(doc),
    entityType: 'member',
    detail: doc.name,
    meta: { memberId: doc.id },
  });
  return hydrateMember(await requireMemberByAnyId(doc.id));
}

async function suspendMember(memberId, staff, reason) {
  const member = await requireMemberByAnyId(memberId);
  const status = member.accountStatus || (member.isMember ? 'active' : 'pending');
  if (status !== 'active') throw new ApiError(409, 'INVALID_STATUS', 'Only active members can be suspended');
  const db = getDB();
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { accountStatus: 'suspended', subStatus: 'paused', updatedAt: new Date() } }
  );
  await db.collection('subscriptions').updateMany(
    { memberId: member.id, status: 'active' },
    { $set: { status: 'paused', updatedAt: new Date() } }
  );
  await cancelUpcomingDeliveries(member.id);
  await insertMemberNotification({
    memberId: member.id,
    icon: 'users',
    title: 'Account update',
    body: 'Your account has been suspended. Contact support for help.',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Member suspend',
    entity: memberPublicId(member),
    entityType: 'member',
    detail: reason ? `${member.name} · ${reason}` : member.name,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

async function reactivateMember(memberId, staff) {
  const member = await requireMemberByAnyId(memberId);
  if (member.accountStatus !== 'suspended') {
    throw new ApiError(409, 'INVALID_STATUS', 'Only suspended members can be reactivated');
  }
  const db = getDB();
  const sub = await latestSubscription(member.id);
  const subStatus = sub ? 'active' : 'none';
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { accountStatus: 'active', isMember: true, subStatus, updatedAt: new Date() } }
  );
  if (sub) {
    await db.collection('subscriptions').updateMany(
      { memberId: member.id, status: 'paused' },
      { $set: { status: 'active', updatedAt: new Date() } }
    );
  }
  await insertMemberNotification({
    memberId: member.id,
    icon: 'users',
    title: 'Account update',
    body: 'Welcome back — your account is active again.',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Member reactivate',
    entity: memberPublicId(member),
    entityType: 'member',
    detail: member.name,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

async function cancelMember(memberId, staff, { keepAccountActive = false } = {}) {
  const member = await requireMemberByAnyId(memberId);
  await releasePlotForMember(member, { keepAccountActive });
  if (!keepAccountActive) {
    await insertMemberNotification({
      memberId: member.id,
      icon: 'users',
      title: 'Account update',
      body: 'Your membership has been cancelled. We hope to see you again.',
    });
    await writeAudit({
      actorId: staff.id,
      actorName: staff.name,
      action: 'Member cancel',
      entity: memberPublicId(member),
      entityType: 'member',
      detail: member.name,
      meta: { memberId: member.id },
    });
  }
  return hydrateMember(await requireMemberByAnyId(member.id));
}

function readAddress(body) {
  const address = body?.address && typeof body.address === 'object' ? body.address : null;
  if (!address) return null;
  return {
    line: String(address.line || '').trim(),
    city: String(address.city || '').trim(),
    pin: String(address.pin || '').trim(),
    label: String(address.label || 'Home').trim() || 'Home',
  };
}

function addressErrors(address) {
  const details = [];
  if (!address.line) details.push({ field: 'address.line', message: 'Required' });
  if (!address.city) details.push({ field: 'address.city', message: 'Required' });
  if (!/^\d{6}$/.test(address.pin)) details.push({ field: 'address.pin', message: 'PIN must be 6 digits' });
  return details;
}

async function saveDefaultAddress(memberId, address, now) {
  const db = getDB();
  const existing =
    (await db.collection('addresses').findOne({ memberId, isDefault: true })) ||
    (await db.collection('addresses').findOne({ memberId }));
  if (existing) {
    await db.collection('addresses').updateOne(
      { id: existing.id },
      { $set: { line: address.line, city: address.city, pin: address.pin, label: address.label, isDefault: true } }
    );
    return;
  }
  await db.collection('addresses').insertOne({
    id: `addr_${nanoid(6)}`,
    memberId,
    label: address.label,
    line: address.line,
    city: address.city,
    pin: address.pin,
    isDefault: true,
    createdAt: now,
  });
}

async function allocateMemberId(requested) {
  const db = getDB();
  const taken = async (id) =>
    db.collection('members').findOne({ $or: [{ id }, { memberCode: `CHEDI-${id}` }] });

  if (requested) {
    const clash = await taken(requested);
    if (clash) throw new ApiError(409, 'USER_ID_TAKEN', 'That user ID is already in use');
    return requested;
  }

  let id = await nextMemberId();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await taken(id))) return id;
    id = await nextMemberId();
  }
  throw new ApiError(409, 'USER_ID_TAKEN', 'Could not assign a user ID. Try again.');
}

async function createMember(body, staff) {
  const details = [];
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 80) {
    details.push({ field: 'name', message: 'Name must be 2–80 characters' });
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    details.push({ field: 'email', message: 'Invalid email address' });
  }
  const phone = normalizePhone(String(body.phone || ''));
  if (!phone || !isValidIndianMobile(phone)) {
    details.push({ field: 'phone', message: 'Invalid Indian mobile number' });
  }
  const address = readAddress(body);
  if (!address) details.push({ field: 'address.line', message: 'Required' });
  else details.push(...addressErrors(address));

  let requestedId = '';
  if (body.userId != null && String(body.userId).trim()) {
    requestedId = String(body.userId).trim().replace(/^CHEDI-/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(requestedId)) {
      details.push({ field: 'userId', message: 'User ID must be 2–32 letters, numbers, or hyphens' });
    }
  }
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Please complete all required fields', details);

  if (await findMemberByEmail(email)) {
    throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'This email is already registered');
  }
  if (await findMemberByPhone(phone)) {
    throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', 'This phone is already registered');
  }

  const id = await allocateMemberId(requestedId);
  const now = new Date();
  const doc = {
    id,
    memberCode: `CHEDI-${id}`,
    name,
    phone,
    phoneDisplay: displayPhone(phone),
    email,
    isMember: true,
    accountStatus: 'active',
    subStatus: 'none',
    memberSince: isoDate(now),
    hasPlot: false,
    plotCount: 0,
    statusLabel: 'Member · no plot yet',
    welcomeBasket: await welcomeBasketFor(now),
    preferences: {
      notifications: { delivery: true, harvest: true, promos: false },
      channel: 'push',
    },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const db = getDB();
  await db.collection('members').insertOne(doc);
  await saveDefaultAddress(id, address, now);
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Member created',
    entity: memberPublicId(doc),
    entityType: 'member',
    detail: name,
    meta: { memberId: id },
  });
  return hydrateMember(await requireMemberByAnyId(id));
}

async function deleteMember(memberId, staff) {
  const member = await requireMemberByAnyId(memberId);
  await releasePlotForMember(member, { keepAccountActive: false });
  await jwtService.revokeAllSessions(member.id);
  await softDeleteMember(member.id);
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Member deleted',
    entity: memberPublicId(member),
    entityType: 'member',
    detail: member.name,
    meta: { memberId: member.id },
  });
  return { id: member.id, memberCode: memberPublicId(member), deleted: true };
}

async function patchMember(memberId, body, staff) {
  const member = await requireMemberByAnyId(memberId);
  const details = [];
  const $set = { updatedAt: new Date() };
  if (body.name != null) {
    const name = String(body.name).trim();
    if (name.length < 2 || name.length > 80) {
      details.push({ field: 'name', message: 'Name must be 2–80 characters' });
    } else $set.name = name;
  }
  if (body.email != null) {
    const email = String(body.email).trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      details.push({ field: 'email', message: 'Invalid email address' });
    } else {
      const clash = await findMemberByEmail(email);
      if (clash && clash.id !== member.id) {
        throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'This email is already registered');
      }
      $set.email = email;
    }
  }
  if (body.phone != null) {
    const phone = normalizePhone(String(body.phone));
    if (!phone || !isValidIndianMobile(phone)) {
      details.push({ field: 'phone', message: 'Invalid Indian mobile number' });
    } else {
      const clash = await findMemberByPhone(phone);
      if (clash && clash.id !== member.id) {
        throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', 'This phone is already registered');
      }
      $set.phone = phone;
      $set.phoneDisplay = displayPhone(phone);
    }
  }
  const address = readAddress(body);
  if (address) details.push(...addressErrors(address));
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid profile fields', details);
  if (address) await saveDefaultAddress(member.id, address, new Date());
  const db = getDB();
  await db.collection('members').updateOne({ id: member.id }, { $set });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Member updated',
    entity: memberPublicId(member),
    entityType: 'member',
    detail: member.name,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

async function changePlan(memberId, planKey, staff) {
  const member = await requireMemberByAnyId(memberId);
  const planDoc = await loadPlan(planKey);
  if (!planDoc) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  const plan = toPlan(planDoc);
  const db = getDB();
  const sub = await latestSubscription(member.id);
  if (sub) {
    await db.collection('subscriptions').updateOne(
      { id: sub.id },
      { $set: { planKey, nextBillAmountInr: plan.totalInr, updatedAt: new Date() } }
    );
  }
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { planKey, updatedAt: new Date() } }
  );
  await insertMemberNotification({
    memberId: member.id,
    icon: 'refresh',
    title: 'Plan updated',
    body: `Your plan is now ${plan.name}.`,
    deepLinkTab: 'subscription',
    deepLinkPath: '/app/subscription',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plan changed',
    entity: memberPublicId(member),
    entityType: 'member',
    detail: `${member.name} → ${plan.name}`,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

module.exports = {
  hydrateMember,
  listMembers,
  getMemberDrawer,
  createMember,
  deleteMember,
  activateMember,
  suspendMember,
  reactivateMember,
  cancelMember,
  patchMember,
  changePlan,
  cancelUpcomingDeliveries,
  releasePlotForMember,
};
