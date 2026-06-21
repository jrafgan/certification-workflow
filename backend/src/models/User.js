'use strict';

// models/User.js — an employee account for the Agent Control Center.
//
// Two roles only (Viewer was removed — the business doesn't need it):
//   administrator — full access: settings, KB management, integrations, user management.
//   operator      — review drafts; approve/reject proposals, calculations, status changes,
//                   emails, order creation.
//
// Passwords are NEVER stored in plaintext: a per-user random salt + scrypt hash (Node's
// built-in crypto, no external dependency). There is no anonymous access — every request to
// the Control Center requires a logged-in user.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const ROLES = ['administrator', 'operator'];

const userSchema = new Schema({
  username:      { type: String, required: true, unique: true, trim: true, lowercase: true },
  display_name:  { type: String, trim: true },
  role:          { type: String, enum: ROLES, required: true, default: 'operator' },

  // scrypt(password, salt) — both stored hex; the plaintext is never persisted.
  password_hash: { type: String, required: true },
  password_salt: { type: String, required: true },

  active:        { type: Boolean, default: true },
  created_at:    { type: Date, default: Date.now },
  last_login_at: { type: Date },
}, {
  collection: 'users',
  versionKey: false,
});

userSchema.index({ username: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);

module.exports = { User, ROLES };
