'use strict';

// services/authService.js — password hashing, authentication, and user management.
//
// Hashing uses Node's built-in crypto.scrypt (no external bcrypt dependency): a random
// 16-byte salt per user + a 64-byte scrypt hash, compared in constant time. Plaintext
// passwords are never stored or logged.

const crypto = require('crypto');
const errorUtils = require('../utils/errorUtils');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const hash = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function publicUser(u) {
  if (!u) return null;
  return { id: String(u._id), username: u.username, display_name: u.display_name || u.username, role: u.role, active: u.active };
}

async function authenticate(username, password, deps = {}) {
  const { User } = deps.User ? deps : require('../models');
  const u = await User.findOne({ username: String(username || '').trim().toLowerCase() });
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.password_salt, u.password_hash)) return null;
  u.last_login_at = new Date();
  await u.save();
  return publicUser(u);
}

async function createUser({ username, password, role = 'operator', display_name } = {}, deps = {}) {
  const { User, ROLES } = deps.User ? deps : require('../models');
  if (!username || !password) throw errorUtils.validationError('username and password are required');
  if (!ROLES.includes(role)) throw errorUtils.validationError(`role must be one of ${ROLES.join(', ')}`);
  const { salt, hash } = hashPassword(password);
  try {
    const u = await User.create({
      username: String(username).trim().toLowerCase(), display_name: display_name || username,
      role, password_hash: hash, password_salt: salt, active: true,
    });
    return publicUser(u);
  } catch (err) {
    if (err && (err.code === 11000 || err.code === 'E11000')) throw errorUtils.conflictError('Пользователь с таким логином уже существует');
    throw err;
  }
}

// Self-service password change: verify the CURRENT password, then set a new salt+hash.
// Returns { ok:true } | { ok:false, reason:'bad_current' }. Plaintext never stored/logged.
async function changePassword({ username, currentPassword, newPassword } = {}, deps = {}) {
  const { User } = deps.User ? deps : require('../models');
  if (!newPassword || String(newPassword).length < 6) throw errorUtils.validationError('Новый пароль — минимум 6 символов');
  const u = await User.findOne({ username: String(username || '').trim().toLowerCase() });
  if (!u) throw errorUtils.notFoundError('Пользователь не найден');
  if (!verifyPassword(currentPassword, u.password_salt, u.password_hash)) return { ok: false, reason: 'bad_current' };
  const { salt, hash } = hashPassword(newPassword);
  u.password_salt = salt; u.password_hash = hash;
  await u.save();
  return { ok: true };
}

async function listUsers(deps = {}) {
  const { User } = deps.User ? deps : require('../models');
  const us = await User.find({}).sort({ created_at: 1 }).lean();
  return us.map(publicUser);
}

async function setActive(userId, active, deps = {}) {
  const { User } = deps.User ? deps : require('../models');
  const u = await User.findByIdAndUpdate(userId, { active: !!active }, { new: true });
  if (!u) throw errorUtils.notFoundError('Пользователь не найден');
  return publicUser(u);
}

// Boot-time convenience: if no users exist, create a default administrator so the system is
// reachable. Loud console warning to change the password. Configurable via env.
async function ensureSeedAdmin(deps = {}) {
  const { User } = deps.User ? deps : require('../models');
  if (await User.countDocuments({}) > 0) return { seeded: false };
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  await createUser({ username, password, role: 'administrator', display_name: 'Администратор' }, deps);
  console.warn(`[auth] Seeded initial administrator "${username}" with ${process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'default password "admin"'} — CHANGE IT.`);
  return { seeded: true, username };
}

module.exports = { hashPassword, verifyPassword, authenticate, createUser, changePassword, listUsers, setActive, ensureSeedAdmin, publicUser };
