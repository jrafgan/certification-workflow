'use strict';

// services/auditService.js — append-only audit trail helpers.

function record(entry, deps = {}) {
  const { AuditLog } = deps.AuditLog ? deps : require('../models');
  // Fire-and-forget friendly, but return the promise so callers can await when they want.
  return AuditLog.create({
    at: new Date(),
    user: entry.user || 'unknown',
    role: entry.role || null,
    action: entry.action,
    summary: entry.summary || null,
    target_type: entry.target_type || null,
    target_id: entry.target_id ? String(entry.target_id) : null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  }).catch(err => { console.error('[audit] failed to record:', err.message); return null; });
}

async function list({ limit = 100, user, target_type } = {}, deps = {}) {
  const { AuditLog } = deps.AuditLog ? deps : require('../models');
  const q = {};
  if (user) q.user = user;
  if (target_type) q.target_type = target_type;
  const rows = await AuditLog.find(q).sort({ at: -1 }).limit(limit).lean();
  return rows.map(r => ({
    id: String(r._id), at: r.at, user: r.user, role: r.role, action: r.action,
    summary: r.summary, target_type: r.target_type, target_id: r.target_id, before: r.before, after: r.after,
  }));
}

module.exports = { record, list };
