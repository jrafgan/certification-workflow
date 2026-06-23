'use strict';

// services/attentionCenterService.js — Attention Center (Phase 6).
//
// The "what requires my attention today?" view. Composes the engines already built
// (orderDangers, the Status Verification auditor, order statuses, lead states) into
// SEVEN explicit categories:
//   new_clients · waiting_payment · waiting_mockup · waiting_approval ·
//   waiting_original · status_conflicts · forgotten
//
// categorize() is PURE (no I/O) and exported for tests. build() does the DB fetch and
// delegates. READ-ONLY and recommend-only — it surfaces work, it never acts.

// Order statuses that define the three "waiting" lanes.
const WAITING = {
  waiting_mockup:   'Ждем макет',
  waiting_approval: 'На согласовании',
  waiting_original: 'Ждем оригинал',
};

// Danger types that mean an order is drifting/forgotten (overdue or idle).
const FORGOTTEN_DANGERS = new Set(['lab_overdue', 'original_overdue', 'approval_overdue', 'client_waiting_long', 'paid_not_launched']);

// Audit finding types that mean the stored status disagrees with reality.
const CONFLICT_FINDINGS = new Set(['missing_transition', 'contradictory_state', 'unrecognized_status', 'completed_with_debt', 'completed_not_delivered']);

function clientLabel(order = {}) {
  const c = order.client || {};
  return c.companyName || c.name || (order.sheet_row_id ? `row ${order.sheet_row_id}` : String(order._id || '—'));
}

function leadLabel(lead = {}) {
  return lead.display_name || lead.handle || lead.whatsapp_phone || String(lead._id || '—');
}

// isConflict — does an auditOrder result mean status ≠ reality?
function isConflict(audit) {
  if (!audit) return false;
  if (audit.proposed_status) return true;
  return (audit.findings || []).some(f => CONFLICT_FINDINGS.has(f.type));
}

// categorize(input) → { categories:[{key,label,count,items}], total }
//   input = {
//     orders:         [order],                 // active orders (status-bearing)
//     newClients:     [lead],                  // leads in state 'new'
//     waitingPayment: [lead],                  // leads in state 'waiting_payment'
//     dangers:        [danger],                // flattened orderDangers (carry order_id)
//     audits:         [audit],                 // auditOrder results, each w/ order_id
//   }
function categorize(input = {}) {
  const orders = Array.isArray(input.orders) ? input.orders : [];
  const newClients = Array.isArray(input.newClients) ? input.newClients : [];
  const waitingPayment = Array.isArray(input.waitingPayment) ? input.waitingPayment : [];
  const dangers = Array.isArray(input.dangers) ? input.dangers : [];
  const audits = Array.isArray(input.audits) ? input.audits : [];

  const byStatus = (st) => orders
    .filter(o => String(o.status || '').trim() === st)
    .map(o => ({ order_id: String(o._id || ''), client: clientLabel(o), status: o.status }));

  const conflicts = audits.filter(isConflict).map(a => ({
    order_id: String(a.order_id || ''),
    client: a.client_name || null,
    current: a.current_status || null,
    proposed: a.proposed_status || null,
    confidence: a.confidence_band || a.confidence || null,
    reason: a.reasoning || (a.findings && a.findings[0] && a.findings[0].detail) || null,
  }));

  const forgotten = dangers.filter(d => FORGOTTEN_DANGERS.has(d.type)).map(d => ({
    order_id: String(d.order_id || ''), type: d.type, severity: d.severity,
    label: d.label || null, detail: d.detail || null,
  }));

  const categories = [
    { key: 'new_clients',      label: 'Новые клиенты',        items: newClients.map(l => ({ lead_id: String(l._id || ''), label: leadLabel(l), platform: l.platform || null })) },
    { key: 'waiting_payment',  label: 'Ожидают оплату',       items: waitingPayment.map(l => ({ lead_id: String(l._id || ''), label: leadLabel(l), platform: l.platform || null })) },
    { key: 'waiting_mockup',   label: 'Ожидают макет',        items: byStatus(WAITING.waiting_mockup) },
    { key: 'waiting_approval', label: 'Ожидают согласования', items: byStatus(WAITING.waiting_approval) },
    { key: 'waiting_original', label: 'Ожидают оригинал',     items: byStatus(WAITING.waiting_original) },
    { key: 'status_conflicts', label: 'Конфликты статуса',    items: conflicts },
    { key: 'forgotten',        label: 'Забытые заказы',       items: forgotten },
  ].map(c => ({ ...c, count: c.items.length }));

  return { categories, total: categories.reduce((n, c) => n + c.count, 0), recommend_only: true };
}

// ─── DB-backed build ───────────────────────────────────────────────────────────
async function build(deps = {}) {
  const models = deps.models || require('../models');
  const { Order, Lead } = models;
  const wf = deps.workflowAudit || require('./workflowAuditService');
  const orderDangers = deps.orderDangers || require('./controlCenterService').orderDangers;

  const ACTIVE = ['Запустить', 'Ждем макет', 'На согласовании', 'Ждем оригинал', 'Оригинал получен', 'Завершен'];
  const safe = async (p) => { try { return await p; } catch (_) { return []; } };

  const [orders, newClients, waitingPayment] = await Promise.all([
    safe(Order.find({ status: { $in: ACTIVE } })
      .select('status client sheet_row_id declaration_id payments lab_interactions layouts originals events deadlines balance_due laboratory created_at updated_at')
      .limit(2000).lean()),
    safe(Lead.find({ state: 'new' }).select('display_name handle whatsapp_phone platform').limit(500).lean()),
    safe(Lead.find({ state: 'waiting_payment' }).select('display_name handle whatsapp_phone platform').limit(500).lean()),
  ]);

  const dangers = [];
  const audits = [];
  for (const o of orders) {
    try { dangers.push(...orderDangers(o)); } catch (_) { /* skip */ }
    try {
      const a = wf.auditOrder({ current_status: o.status, evidence: wf.collectEvidenceFromOrder(o) });
      if (a) audits.push({ order_id: o._id, client_name: clientLabel(o), ...a });
    } catch (_) { /* skip */ }
  }

  return categorize({ orders, newClients, waitingPayment, dangers, audits });
}

module.exports = { categorize, isConflict, clientLabel, leadLabel, build, WAITING, FORGOTTEN_DANGERS, CONFLICT_FINDINGS };
