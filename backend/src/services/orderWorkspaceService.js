'use strict';

// services/orderWorkspaceService.js — Unified Operator Workspace (Phase 5).
//
// Aggregates EVERYTHING about one order into a single read-only payload so the operator
// never navigates across screens: Declaration data, WhatsApp history, email/lab threads,
// attachments, payments, status (+ the Status Verification result), and pending agent
// recommendations.
//
// assembleWorkspace() is PURE (no I/O) and exported for tests. getWorkspace() does the
// defensive DB fetch and delegates to it. READ-ONLY: nothing here writes or sends.

const { matchKey } = require('../utils/phoneUtils');

// ─── Pure: normalize already-fetched pieces into the unified workspace shape ────
function assembleWorkspace(input = {}) {
  const order = input.order || {};
  const declaration = input.declaration || null;
  const whatsapp = Array.isArray(input.whatsapp) ? input.whatsapp : [];
  const emails = Array.isArray(input.emails) ? input.emails : [];
  const emailDrafts = Array.isArray(input.emailDrafts) ? input.emailDrafts : [];
  const audits = Array.isArray(input.audits) ? input.audits : [];
  const dangers = Array.isArray(input.dangers) ? input.dangers : [];
  const statusVerification = input.statusVerification || null;

  const client = order.client || {};
  const layouts = Array.isArray(order.layouts) ? order.layouts : [];
  const original = order.original || {};
  const payments = (Array.isArray(order.payments) ? order.payments : []).map(p => ({
    date: p.date, amount: p.amount, method: p.method, voided: !!p.voided, note: p.note,
  }));

  // Attachments aggregated from every source the order touches.
  const attachments = [];
  for (const l of layouts) if (l.file_name || l.file_ref) attachments.push({ source: 'mockup', kind: 'layout', name: l.file_name || null, ref: l.file_ref || null, at: l.received_at || null });
  if (original.tracking_ref) attachments.push({ source: 'original', kind: 'original', name: null, ref: original.tracking_ref, at: original.received_at || null });
  for (const m of whatsapp) if (m.file_name || m.media_ref) attachments.push({ source: 'whatsapp', kind: m.mime_type || 'media', name: m.file_name || null, ref: m.media_ref || null, at: m.received_at || null });
  for (const t of emails) if (t.reply_has_attachment) attachments.push({ source: 'email', kind: 'lab_reply', name: null, ref: t.thread_id || null, at: t.reply_detected_at || null });

  // Pending agent recommendations (status audits + lab email drafts), normalized.
  const recommendations = [];
  for (const a of audits) recommendations.push({
    type: 'status_audit', id: String(a._id || ''), state: a.state,
    label: a.proposed_status ? `«${a.current_status}» → «${a.proposed_status}»` : `Проверка статуса «${a.current_status}»`,
    confidence: a.confidence_band || a.confidence, recommend: !!a.recommend,
  });
  for (const d of emailDrafts) recommendations.push({
    type: 'email_draft', id: String(d._id || ''), state: d.state,
    label: d.subject || `Письмо в лабораторию (${d.draft_type || ''})`, to: d.to_email || d.lab_name || null,
  });

  return {
    order_id: String(order._id || ''),
    status: order.status || null,
    balance_due: order.balance_due || 0,
    client: { name: client.name || null, company: client.companyName || null, phone: client.phone || null, email: client.email || null },

    declaration: declaration ? {
      present: true,
      status: declaration.status || null,
      phone: declaration.phone || null,
      payment_amount: declaration.payment_amount ?? null,
      client_name: declaration.client_name || null,
      sheet_row_id: declaration.sheet_row_id || null,
    } : { present: false },

    status_verification: statusVerification ? {
      current_status: statusVerification.current_status,
      proposed_status: statusVerification.proposed_status || null,
      confidence: statusVerification.confidence,
      confidence_band: statusVerification.confidence_band,
      recommend: !!statusVerification.recommend,
      findings: statusVerification.findings || [],
      reasoning: statusVerification.reasoning || null,
    } : null,

    payments,
    whatsapp: whatsapp.slice(0, 25).map(m => ({
      direction: m.direction || null, from: m.from_phone || null,
      body: m.body || null, at: m.received_at || m.sent_at || null,
      has_media: !!(m.file_name || m.media_ref), match_status: m.match_status || null,
    })),
    emails: emails.map(t => ({
      recipient: t.recipient_email || null, status: t.status || null, thread_id: t.thread_id || null,
      last_at: t.reply_detected_at || t.sent_at || t.created_at || null,
      has_attachment: !!t.reply_has_attachment, lab_version: t.lab_interaction_version ?? null,
    })),
    email_drafts: emailDrafts.map(d => ({ subject: d.subject || null, to: d.to_email || null, type: d.draft_type || null, state: d.state || null })),
    attachments,
    mockups: layouts.map(l => ({
      version: l.version, file_name: l.file_name || null, received_at: l.received_at || null,
      sent_to_client_at: l.sent_to_client_at || null, client_decision: l.client_decision || null,
    })),
    recommendations,
    dangers,
    counts: {
      whatsapp: whatsapp.length, emails: emails.length, payments: payments.length,
      attachments: attachments.length, recommendations: recommendations.length, dangers: dangers.length,
    },
    recommend_only: true,
  };
}

// ─── DB-backed: fetch the pieces and assemble (defensive) ──────────────────────
async function getWorkspace(orderId, deps = {}) {
  const models = deps.models || require('../models');
  const { Order, Declaration, WhatsAppMessage, LabCommThread, EmailDraft, AuditPackage } = models;

  const order = await Order.findById(orderId).lean();
  if (!order) return { found: false };

  const safe = async (p) => { try { return await p; } catch (_) { return []; } };

  const phoneKey = order.client && order.client.phone ? matchKey(order.client.phone) : '';
  const waQuery = { $or: [{ order_id: order._id }, { matched_order_id: order._id }] };
  if (phoneKey) waQuery.$or.push({ phone_key: phoneKey });

  const [declaration, whatsapp, emails, emailDrafts, audits] = await Promise.all([
    order.declaration_id ? safe(Declaration.findById(order.declaration_id).lean()) : null,
    safe(WhatsAppMessage.find(waQuery).sort({ received_at: -1 }).limit(25).lean()),
    safe(LabCommThread.find({ order_id: order._id }).sort({ created_at: -1 }).lean()),
    safe(EmailDraft.find({ order_id: order._id, state: { $in: ['pending_approval', 'changes_requested', 'approved'] } }).lean()),
    safe(AuditPackage.find({ order_id: order._id, state: 'pending' }).lean()),
  ]);

  // Status verification (Phase 1 engine) + operational dangers — read-only.
  let statusVerification = null, dangers = [];
  try {
    const wf = require('./workflowAuditService');
    statusVerification = wf.auditOrder({ current_status: order.status, evidence: wf.collectEvidenceFromOrder(order) });
  } catch (_) { /* best-effort */ }
  try { dangers = require('./controlCenterService').orderDangers(order); } catch (_) { /* best-effort */ }

  return {
    found: true,
    workspace: assembleWorkspace({
      order, declaration: Array.isArray(declaration) ? null : declaration,
      whatsapp, emails, emailDrafts, audits, dangers, statusVerification,
    }),
  };
}

module.exports = { assembleWorkspace, getWorkspace };
