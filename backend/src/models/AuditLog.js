'use strict';

// models/AuditLog.js — immutable trail of who changed what, when.
//
// Every operator/administrator action that changes state records one of these:
// the user, the timestamp, the action, and the before/after of the thing changed.
// Read endpoints are never audited; only mutations. Records are append-only.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const auditLogSchema = new Schema({
  at:          { type: Date, default: Date.now },
  user:        { type: String, required: true },   // username
  role:        { type: String },
  action:      { type: String, required: true },   // e.g. 'approve_lead_reply', 'edit_kb', 'login'
  // Human-readable Russian summary shown in the UI ("Оператор одобрил ответ клиенту").
  summary:     { type: String },
  target_type: { type: String },                   // lead_message | email_draft | audit | kb | user | settings | ...
  target_id:   { type: String },
  before:      { type: Schema.Types.Mixed, default: null },
  after:       { type: Schema.Types.Mixed, default: null },
}, {
  collection: 'audit_logs',
  versionKey: false,
});

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ user: 1, at: -1 });
auditLogSchema.index({ target_type: 1, target_id: 1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = { AuditLog };
