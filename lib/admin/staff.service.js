const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { hashPassword } = require('../password');
const { writeAudit } = require('../audit');
const { newId } = require('./ids');
const { toStaffDto } = require('./dto');
const { ROLE_LABELS, ROLE_SCOPES } = require('./constants');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function emailTakenQuery(email, exceptId) {
  const query = { email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } };
  if (exceptId) query.id = { $ne: exceptId };
  return query;
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function validateProfile(body, { creating }) {
  const details = [];
  const name = cleanName(body.name);
  const email = String(body.email || '').trim().toLowerCase();
  const role = String(body.role || '').trim();
  const password = body.password == null ? '' : String(body.password);

  if (!name || name.length < 2) details.push({ field: 'name', message: 'Enter a name' });
  if (!email) details.push({ field: 'email', message: 'Required' });
  else if (!EMAIL_RE.test(email)) details.push({ field: 'email', message: 'Invalid email address' });
  if (!ROLE_LABELS[role]) details.push({ field: 'role', message: 'Choose a valid role' });
  if (creating && password.length < 8) {
    details.push({ field: 'password', message: 'Use at least 8 characters' });
  } else if (!creating && password && password.length < 8) {
    details.push({ field: 'password', message: 'Use at least 8 characters' });
  }
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid staff', details);
  return { name, email, role, password };
}

async function assertNotLastSuperAdmin(db, staffId) {
  const others = await db.collection('staff').countDocuments({
    role: 'super_admin',
    active: { $ne: false },
    id: { $ne: staffId },
  });
  if (others < 1) {
    throw new ApiError(409, 'INVALID_STATUS', 'Keep at least one active Super Admin');
  }
}

async function revokeSessions(staffId) {
  await getDB().collection('staff_sessions').updateMany(
    { staffId, revoked: { $ne: true } },
    { $set: { revoked: true, revokedAt: new Date() } }
  );
}

async function createStaff(body, actor) {
  const { name, email, role, password } = validateProfile(body, { creating: true });
  const db = getDB();
  const existing = await db.collection('staff').findOne(emailTakenQuery(email));
  if (existing) {
    throw new ApiError(409, 'CONFLICT', 'A staff account with this email already exists', [
      { field: 'email', message: 'Already in use' },
    ]);
  }

  const now = new Date();
  const doc = {
    id: newId('stf_'),
    name,
    email,
    role,
    roleLabel: ROLE_LABELS[role],
    initial: name[0].toUpperCase(),
    scope: ROLE_SCOPES[role],
    passwordHash: await hashPassword(password),
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.collection('staff').insertOne(doc);
  } catch (err) {
    if (err && err.code === 11000) {
      throw new ApiError(409, 'CONFLICT', 'A staff account with this email already exists', [
        { field: 'email', message: 'Already in use' },
      ]);
    }
    throw err;
  }

  await writeAudit({
    actorId: actor?.id,
    actorName: actor?.name,
    action: 'Staff created',
    entity: name,
    entityType: 'staff',
    detail: `${email} · ${ROLE_LABELS[role]}`,
  });

  return toStaffDto(doc);
}

async function updateStaff(staffId, body, actor) {
  const db = getDB();
  const current = await db.collection('staff').findOne({ id: staffId });
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Staff not found');

  const $set = { updatedAt: new Date() };
  let passwordChanged = false;
  let roleChanged = false;
  const touchesProfile = body.name != null || body.email != null || body.role != null || Boolean(body.password);

  if (touchesProfile) {
    const parsed = validateProfile(
      {
        name: body.name != null ? body.name : current.name,
        email: body.email != null ? body.email : current.email,
        role: body.role != null ? body.role : current.role,
        password: body.password || '',
      },
      { creating: false }
    );
    if (parsed.email !== String(current.email || '').toLowerCase()) {
      const taken = await db.collection('staff').findOne(emailTakenQuery(parsed.email, staffId));
      if (taken) {
        throw new ApiError(409, 'CONFLICT', 'A staff account with this email already exists', [
          { field: 'email', message: 'Already in use' },
        ]);
      }
    }
    if (current.role === 'super_admin' && parsed.role !== 'super_admin' && current.active !== false) {
      await assertNotLastSuperAdmin(db, staffId);
    }
    $set.name = parsed.name;
    $set.email = parsed.email;
    $set.role = parsed.role;
    $set.roleLabel = ROLE_LABELS[parsed.role];
    $set.initial = parsed.name[0].toUpperCase();
    $set.scope = ROLE_SCOPES[parsed.role];
    roleChanged = parsed.role !== current.role;
    if (parsed.password) {
      $set.passwordHash = await hashPassword(parsed.password);
      passwordChanged = true;
    }
  }

  if (body.active != null) {
    const active = Boolean(body.active);
    if (!active && current.active !== false) {
      if (actor?.id === staffId) {
        throw new ApiError(409, 'INVALID_STATUS', 'You cannot remove your own account');
      }
      if ((touchesProfile ? $set.role : current.role) === 'super_admin') {
        await assertNotLastSuperAdmin(db, staffId);
      }
    }
    $set.active = active;
  }

  try {
    await db.collection('staff').updateOne({ id: staffId }, { $set });
  } catch (err) {
    if (err && err.code === 11000) {
      throw new ApiError(409, 'CONFLICT', 'A staff account with this email already exists', [
        { field: 'email', message: 'Already in use' },
      ]);
    }
    throw err;
  }

  if (passwordChanged || roleChanged || $set.active === false) {
    await revokeSessions(staffId);
  }

  const updated = await db.collection('staff').findOne({ id: staffId }, { projection: { passwordHash: 0 } });
  const restored = body.active === true && current.active === false;
  const removed = $set.active === false && current.active !== false;
  await writeAudit({
    actorId: actor?.id,
    actorName: actor?.name,
    action: removed ? 'Staff removed' : restored ? 'Staff restored' : 'Staff updated',
    entity: updated.name,
    entityType: 'staff',
    detail: `${updated.email} · ${updated.roleLabel || ROLE_LABELS[updated.role] || updated.role}`,
  });
  return toStaffDto(updated);
}

async function removeStaff(staffId, actor) {
  return updateStaff(staffId, { active: false }, actor);
}

module.exports = { createStaff, updateStaff, removeStaff };
