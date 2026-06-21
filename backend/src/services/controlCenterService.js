'use strict';

// services/controlCenterService.js — read/aggregation layer for the Agent Control Center.
//
// Fuses the existing engines into the six operator screens (Dashboard, Inbox, Draft Center,
// Pipeline, Agent Chat, KB Viewer). READ-mostly: the only writes are operator decisions,
// dispatched to each engine's own gated decide()/edit path — nothing new is auto-applied,
// and the never-auto-send rule is unchanged.
//
// DB-resilient: every read checks the Mongoose connection first and returns
// { db_connected:false } with empty data when the database is offline, so the UI degrades
// gracefully instead of hanging on buffered queries.

const mongoose = require('mongoose');

const leadConversion   = require('./leadConversionService');
const draftEmail       = require('./draftEmailService');
const draftPackage     = require('./draftPackageService');
const workflowAudit    = require('./workflowAuditService');
const extractionReview = require('./extractionReviewService');
const leadRecovery     = require('./leadRecoveryService');
const knowledgeBase    = require('./knowledgeBaseService');
const pi               = require('./piCalculationService');
const authService      = require('./authService');
const audit            = require('./auditService');
const errorUtils       = require('../utils/errorUtils');

function connected() { return mongoose.connection.readyState === 1; }
function M() { return require('../models'); }

// The lead states the Dashboard surfaces (Stage cards) + pipeline columns.
const LEAD_STATE_LABELS = {
  new: 'New', educating: 'Educating', waiting_application: 'Waiting Application',
  waiting_calculation: 'Waiting Calculation', waiting_payment: 'Waiting Payment',
  transferred_whatsapp: 'Transferred to WhatsApp', dormant: 'Dormant', recovered: 'Recovered',
};

// ─── Dashboard summary ───────────────────────────────────────────────────────
async function summary() {
  if (!connected()) return { db_connected: false, leads: {}, attention: {}, attention_total: 0 };
  const { Lead, AuditPackage, ExtractionReview, LeadMessageDraft, EmailDraft, DraftPackage, LeadRecovery } = M();

  const states = Object.keys(LEAD_STATE_LABELS);
  const leads = {};
  await Promise.all(states.map(async s => { leads[s] = await Lead.countDocuments({ state: s }); }));

  const attention = {
    audits:             await AuditPackage.countDocuments({ state: 'pending' }),
    payment_reviews:    await ExtractionReview.countDocuments({ status: 'pending', doc_type: 'receipt' }),
    document_reviews:   await ExtractionReview.countDocuments({ status: 'pending', doc_type: { $ne: 'receipt' } }),
    lead_drafts:        await LeadMessageDraft.countDocuments({ state: { $in: ['pending_approval', 'changes_requested'] } }),
    email_drafts:       await EmailDraft.countDocuments({ state: { $in: ['pending_approval', 'changes_requested'] } }),
    order_proposals:    await DraftPackage.countDocuments({ status: 'pending' }),
    lead_recoveries:    await LeadRecovery.countDocuments({ state: { $in: ['pending', 'changes_requested'] } }),
  };
  const attention_total = Object.values(attention).reduce((a, b) => a + b, 0);
  return { db_connected: true, leads, labels: LEAD_STATE_LABELS, attention, attention_total };
}

// ─── Lead pipeline (counts per column, spec order) ───────────────────────────
async function pipeline() {
  if (!connected()) return { db_connected: false, columns: [] };
  const { Lead } = M();
  const order = ['new', 'educating', 'waiting_application', 'waiting_calculation', 'waiting_payment', 'transferred_whatsapp', 'dormant', 'recovered'];
  const columns = [];
  for (const s of order) columns.push({ state: s, label: LEAD_STATE_LABELS[s], count: await Lead.countDocuments({ state: s }) });
  return { db_connected: true, columns };
}

// ─── Normalizers: each engine item → a common card shape ─────────────────────
function evidenceList(e) {
  if (!Array.isArray(e)) return [];
  return e.map(x => (typeof x === 'string' ? x : (x.detail || x.value || x.cue || JSON.stringify(x))));
}

const LEAD_KIND_RU = { greeting: 'приветствие', education: 'консультация', application_link: 'ссылка на заявку', reminder: 'напоминание', calculation_offer: 'расчёт', payment_instructions: 'инструкции по оплате', whatsapp_request: 'переход в WhatsApp', recovery: 'возврат клиента' };
const EMAIL_KIND_RU = { lab_request: 'запрос в лабораторию', lab_reminder_layout: 'напоминание (макет)', lab_reminder_original: 'напоминание (оригинал)', lab_corrections: 'правки' };
function leadDraftCard(d) {
  return { type: 'lead_message', id: String(d._id), title: `Ответ клиенту · ${LEAD_KIND_RU[d.kind] || d.kind}`, subtitle: `${d.platform} · ${d.to_handle}`,
    body: d.proposed_text, reason: d.reason, evidence: [], confidence: d.auto_allowed ? 'авто-ответ' : 'нужно одобрение',
    editable: true, actions: ['approve', 'reject', 'edit'], created_at: d.created_at, state: d.state };
}
function emailDraftCard(d) {
  return { type: 'email_draft', id: String(d._id), title: `Письмо лаборатории · ${EMAIL_KIND_RU[d.draft_type] || d.draft_type}`, subtitle: `${d.to_email} · ${d.client_name || ''}`,
    body: `${d.subject}\n\n${d.body}`, reason: d.reason, evidence: evidenceList(d.evidence), confidence: d.confidence_band,
    editable: true, actions: ['approve', 'reject', 'edit'], created_at: d.created_at, state: d.state };
}
function auditCard(d) {
  return { type: 'audit', id: String(d._id), title: `Статус заказа · ${d.client_name || d.sheet_row_id || ''}`,
    subtitle: `«${d.current_status}» → «${d.proposed_status || 'без изменений'}»`,
    body: d.reasoning, reason: d.reasoning, evidence: evidenceList(d.evidence).concat((d.findings || []).map(f => f.detail)),
    confidence: d.confidence_band, editable: false, actions: d.proposed_status ? ['approve', 'reject'] : ['acknowledge', 'reject'],
    created_at: d.created_at, state: d.state };
}
function reviewCard(d) {
  return { type: 'extraction_review', id: String(d._id), title: `${d.doc_type === 'receipt' ? 'Проверка оплаты' : 'Проверка документа'}`,
    subtitle: `${(d.source && d.source.file_name) || ''}`, body: JSON.stringify(d.extracted_fields || {}, null, 1),
    reason: d.reason, evidence: evidenceList(d.evidence), confidence: d.confidence_band, editable: false,
    actions: ['approve', 'reject'], created_at: d.created_at, state: d.status };
}
function packageCard(d) {
  return { type: 'draft_package', id: String(d._id), title: `Новая заявка · ${(d.source && d.source.legal_entity) || ''}`, subtitle: d.impact ? '' : '',
    body: d.reason, reason: d.reason, evidence: evidenceList(d.evidence), confidence: d.confidence_band, editable: false,
    actions: ['approve', 'reject'], created_at: d.created_at, state: d.status };
}
function recoveryCard(d) {
  return { type: 'lead_recovery', id: String(d._id), title: `Возврат клиента · ${d.client_name || ''}`, subtitle: `важность: ${d.severity}`,
    body: d.proposed_text, reason: d.reason, evidence: evidenceList(d.evidence), confidence: d.confidence_band, editable: false,
    actions: ['approve', 'reject'], created_at: d.created_at, state: d.state };
}

// ─── Agent Inbox: unified recent stream across all engines ───────────────────
async function inbox({ limit = 60 } = {}) {
  if (!connected()) return { db_connected: false, items: [] };
  const { LeadMessageDraft, EmailDraft, AuditPackage, ExtractionReview, DraftPackage, LeadRecovery } = M();
  const [ld, ed, au, er, dp, lr] = await Promise.all([
    LeadMessageDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    EmailDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    AuditPackage.find({ state: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
    ExtractionReview.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
    DraftPackage.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
    LeadRecovery.find({ state: { $in: ['pending', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
  ]);
  const items = [
    ...ld.map(leadDraftCard), ...ed.map(emailDraftCard), ...au.map(auditCard),
    ...er.map(reviewCard), ...dp.map(packageCard), ...lr.map(recoveryCard),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  return { db_connected: true, items };
}

// ─── Draft Center: the editable/decidable drafts ─────────────────────────────
async function drafts({ limit = 100 } = {}) {
  if (!connected()) return { db_connected: false, groups: {} };
  const { LeadMessageDraft, EmailDraft, AuditPackage, DraftPackage } = M();
  const [ld, ed, au, dp] = await Promise.all([
    LeadMessageDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    EmailDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    AuditPackage.find({ state: 'pending', proposed_status: { $ne: null } }).sort({ created_at: -1 }).limit(limit).lean(),
    DraftPackage.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
  ]);
  return {
    db_connected: true,
    groups: {
      replies:        ld.map(leadDraftCard),
      calculations:   ld.filter(d => d.kind === 'calculation_offer').map(leadDraftCard),
      emails:         ed.map(emailDraftCard),
      status_changes: au.map(auditCard).concat(dp.map(packageCard)),
    },
  };
}

// ─── Knowledge Base Viewer ───────────────────────────────────────────────────
async function kb({ category } = {}) {
  if (!connected()) return { db_connected: false, entries: [] };
  const entries = await knowledgeBase.getApprovedKnowledge(category);
  return { db_connected: true, entries: entries.map(e => ({ id: String(e._id), category: e.category, type: e.type, text: e.text, possibly_outdated: !!e.possibly_outdated })) };
}

// ─── Audit summaries (Russian, business language) ─────────────────────────────
const TYPE_RU = {
  lead_message: 'ответ клиенту', email_draft: 'письмо лаборатории', draft_package: 'создание заявки',
  audit: 'изменение статуса', extraction_review: 'проверку документа/оплаты', lead_recovery: 'возврат клиента',
};
const ACTION_RU = { approve: 'одобрил', reject: 'отклонил', acknowledge: 'отметил', edit: 'изменил', request_changes: 'отправил на доработку' };
function auditSummary(role, action, type) {
  const who = role === 'administrator' ? 'Администратор' : 'Оператор';
  return `${who} ${ACTION_RU[action] || action} ${TYPE_RU[type] || type}`;
}
function snapshot(item) {
  if (!item) return null;
  return { state: item.state || item.status, status: item.current_status, proposed_status: item.proposed_status,
    text: item.proposed_text, subject: item.subject };
}

// ─── Unified operator decision dispatch (Draft Center actions), AUDITED ───────
// type → the engine's gated decide path. 'edit' updates the proposed text on text-bearing
// drafts (operator edits before approving); it never auto-approves. Nothing here bypasses a
// gate: each engine's own decide() is the authority. Every action records an audit entry
// (user, time, action, before, after).
async function decide({ type, id, action, text, note, actor = {} } = {}) {
  if (!connected()) throw errorUtils.validationError('Нет подключения к базе данных');
  if (!type || !id || !action) throw errorUtils.validationError('type, id, action обязательны');
  const decidedBy = actor.username || 'operator';

  const before = snapshot(await loadItem(type, id));
  let result;

  if (action === 'edit') {
    const { LeadMessageDraft, EmailDraft } = M();
    if (type === 'lead_message') {
      const d = await LeadMessageDraft.findById(id);
      if (!d) throw errorUtils.notFoundError('Черновик не найден');
      if (!['pending_approval', 'changes_requested'].includes(d.state)) throw errorUtils.conflictError(`Нельзя редактировать черновик в статусе ${d.state}`);
      d.proposed_text = String(text || d.proposed_text); d.state = 'pending_approval'; d.revision += 1; await d.save();
      result = { ok: true, id, type, edited: true, state: d.state };
    } else if (type === 'email_draft') {
      const d = await EmailDraft.findById(id);
      if (!d) throw errorUtils.notFoundError('Черновик не найден');
      if (text) d.body = String(text); d.state = 'pending_approval'; d.revision = (d.revision || 1) + 1; await d.save();
      result = { ok: true, id, type, edited: true, state: d.state };
    } else throw errorUtils.validationError(`Редактирование недоступно для «${type}»`);
  } else {
    switch (type) {
      case 'lead_message':      { const d = await leadConversion.decideDraft(id, action, { decidedBy, changeNote: note }); result = { ok: true, id, type, state: d.state }; break; }
      case 'email_draft':       { const d = await draftEmail.decide(id, action, { decidedBy, changeNote: note }); result = { ok: true, id, type, state: d.state }; break; }
      case 'draft_package':     { const d = await draftPackage.decide(id, action, { decidedBy }); result = { ok: true, id, type, state: d.status }; break; }
      case 'audit':             { const d = await workflowAudit.decide(id, action, { decidedBy }); result = { ok: true, id, type, state: d.state }; break; }
      case 'extraction_review': { const d = await extractionReview.decide(id, action, { decidedBy }); result = { ok: true, id, type, state: d.status }; break; }
      case 'lead_recovery':     { const d = await leadRecovery.decide(id, action, { decidedBy }); result = { ok: true, id, type, state: d.state }; break; }
      default: throw errorUtils.validationError(`Неизвестный тип «${type}»`);
    }
  }

  const after = snapshot(await loadItem(type, id));
  await audit.record({ user: decidedBy, role: actor.role, action: `${action}_${type}`, summary: auditSummary(actor.role, action, type), target_type: type, target_id: id, before, after });
  return result;
}

// ─── Agent Chat: answer from STORED evidence (no LLM, no new inference) ───────
// Supports: why / explain proposal, show evidence, recalculate. Always grounded in the
// referenced item's persisted reason/evidence/reasoning.
async function chat({ type, id, question = '' } = {}) {
  if (!connected()) return { answer: 'Database is offline — no stored evidence available.', evidence: [] };
  const q = String(question).toLowerCase();
  const item = await loadItem(type, id);
  if (!item) return { answer: 'Item not found.', evidence: [] };

  // recalculate — only meaningful for a lead calculation carrying its inputs.
  if (/recalc|пересчит|recalculate/.test(q)) {
    const payload = item.payload || (item.proposed_data && item.proposed_data.pi) || null;
    if (payload && payload.doc_type) {
      const calc = pi.computePi({ doc_type: payload.doc_type, pi_count: payload.pi_count, compositions: payload.compositions, base_price: payload.base_price });
      return { answer: `Recalculated (${calc.doc_type}): ПИ ${calc.pi_count}, оценка ${calc.total_estimate} ${calc.currency}${calc.is_minimum ? ' (от)' : ''}. Требует подтверждения оператора.`, calc, evidence: calc.basis };
    }
    return { answer: 'No calculation inputs stored on this item to recalculate.', evidence: [] };
  }

  const reason = item.reason || item.reasoning || '(no stored reason)';
  const evidence = evidenceList(item.evidence).concat((item.findings || []).map(f => `${f.type}: ${f.detail}`));

  if (/evidence|докаж|основани|покажи/.test(q)) {
    return { answer: evidence.length ? `Stored evidence (${evidence.length}):` : 'No structured evidence stored for this item.', evidence };
  }
  // default: why / explain proposal
  return { answer: `Why: ${reason}`, evidence, confidence: item.confidence_band || item.confidence || null };
}

async function loadItem(type, id) {
  const { LeadMessageDraft, EmailDraft, AuditPackage, ExtractionReview, DraftPackage, LeadRecovery } = M();
  switch (type) {
    case 'lead_message':      return LeadMessageDraft.findById(id).lean();
    case 'email_draft':       return EmailDraft.findById(id).lean();
    case 'audit':             return AuditPackage.findById(id).lean();
    case 'extraction_review': return ExtractionReview.findById(id).lean();
    case 'draft_package':     return DraftPackage.findById(id).lean();
    case 'lead_recovery':     return LeadRecovery.findById(id).lean();
    default: return null;
  }
}

// ─── Operator Dashboard: business priorities (Russian) ───────────────────────
async function businessDashboard() {
  if (!connected()) return { db_connected: false, tiles: [] };
  const { Lead, EmailDraft, Task } = M();
  const now = new Date();
  const c = (s) => Lead.countDocuments({ state: s });
  const [neu, wapp, wcalc, wpay, dormant, labEmails, overdueTasks, sm] = await Promise.all([
    c('new'), c('waiting_application'), c('waiting_calculation'), c('waiting_payment'), c('dormant'),
    EmailDraft.countDocuments({ state: { $in: ['pending_approval', 'changes_requested'] } }),
    Task.countDocuments({ status: 'open', due_date: { $lt: now } }),
    summary(),
  ]);
  const tiles = [
    { key: 'new',        label: 'Новые клиенты',     count: neu,           hint: 'Только что написали — нужно ответить',         screen: 'pipeline', urgent: neu > 0 },
    { key: 'wapp',       label: 'Ждут заявку',        count: wapp,          hint: 'Отправили ссылку на заявку, ждём заполнения',   screen: 'pipeline', urgent: false },
    { key: 'wcalc',      label: 'Ждут расчёт',        count: wcalc,         hint: 'Заявка получена — нужно подготовить расчёт',    screen: 'drafts',   urgent: wcalc > 0 },
    { key: 'wpay',       label: 'Ждут оплату',        count: wpay,          hint: 'Расчёт одобрен — ждём оплату от клиента',       screen: 'pipeline', urgent: false },
    { key: 'attention',  label: 'Требуют внимания',   count: sm.attention_total, hint: 'Предложения агента, ожидающие вашего решения', screen: 'inbox', urgent: sm.attention_total > 0 },
    { key: 'silent',     label: 'Клиенты без ответа', count: dormant,       hint: 'Перестали отвечать — можно вернуть',            screen: 'pipeline', urgent: false },
    { key: 'lab_emails', label: 'Письма лабораторий', count: labEmails,     hint: 'Письма в лабораторию, ожидающие одобрения',     screen: 'drafts',   urgent: labEmails > 0 },
    { key: 'overdue',    label: 'Просроченные задачи', count: overdueTasks, hint: 'Срок выполнения уже прошёл',                    screen: 'inbox',    urgent: overdueTasks > 0 },
  ];
  return { db_connected: true, tiles };
}

// ─── Real Data Visibility: source status with a clear explanation each ───────
async function sources() {
  const dbOn = connected();
  const out = [];
  const push = (key, label, status, detail, count) => out.push({ key, label, status, detail, count });

  // Declaration (Mongo replica of the sheet)
  if (dbOn) { const n = await M().Declaration.countDocuments(); push('declaration', 'Декларации (таблица)', n > 0 ? 'ok' : 'empty', n > 0 ? `Загружено строк: ${n}` : 'Декларации не загружены в систему', n); }
  else push('declaration', 'Декларации (таблица)', 'unavailable', 'Нет подключения к базе данных');

  // WhatsApp (ingested messages)
  if (dbOn) { const n = await M().WhatsAppMessage.countDocuments(); push('whatsapp', 'WhatsApp', n > 0 ? 'ok' : 'empty', n > 0 ? `Сообщений в системе: ${n}` : 'Сообщения WhatsApp ещё не загружены в систему', n); }
  else push('whatsapp', 'WhatsApp', 'unavailable', 'Нет подключения к базе данных');

  // Knowledge Base
  if (dbOn) { const { KbEntry } = require('../models/KbEntry'); const n = await KbEntry.countDocuments({ status: 'approved' }); push('kb', 'База знаний', n > 0 ? 'ok' : 'empty', n > 0 ? `Одобренных записей: ${n}` : 'Нет одобренных записей', n); }
  else push('kb', 'База знаний', 'unavailable', 'Нет подключения к базе данных');

  // New Form (Google Sheets — network)
  try {
    const newForm = require('../integrations/newFormClient');
    const r = await newForm.readApplications();
    const n = (r.applications || []).length;
    push('new_form', 'Новая форма (заявки)', n > 0 ? 'ok' : 'empty', n > 0 ? `Заявок в форме: ${n}` : (r.reason || 'Заявок не найдено'), n);
  } catch (e) { push('new_form', 'Новая форма (заявки)', 'unavailable', `Нет доступа к Google-таблице: ${e.message}`); }

  // Gmail (network)
  try {
    const gmail = require('../integrations/gmailClient');
    const email = await gmail.getOperatorEmail();
    push('gmail', 'Почта (Gmail)', 'ok', `Подключён ящик: ${email}`);
  } catch (e) { push('gmail', 'Почта (Gmail)', 'unavailable', `Нет доступа к почте: ${e.message}`); }

  return { sources: out };
}

// ─── Admin: user management ──────────────────────────────────────────────────
async function listUsers() { return authService.listUsers(); }
async function createUser(payload, actor = {}) {
  const u = await authService.createUser(payload);
  await audit.record({ user: actor.username, role: actor.role, action: 'create_user', summary: `Администратор создал пользователя «${u.username}» (${u.role})`, target_type: 'user', target_id: u.id, after: u });
  return u;
}
async function setUserActive(userId, active, actor = {}) {
  const u = await authService.setActive(userId, active);
  await audit.record({ user: actor.username, role: actor.role, action: 'set_user_active', summary: `Администратор ${active ? 'включил' : 'отключил'} пользователя «${u.username}»`, target_type: 'user', target_id: u.id, after: u });
  return u;
}

// ─── Admin: KB management (pending review + decide) ──────────────────────────
async function kbPending() {
  if (!connected()) return { db_connected: false, entries: [] };
  const rows = await knowledgeBase.listForReview({ limit: 200 });
  return { db_connected: true, entries: rows.map(e => ({ id: String(e._id), category: e.category, type: e.type, text: e.text, possibly_outdated: !!e.possibly_outdated })) };
}
async function kbDecide(entryId, decision, actor = {}) {
  const e = await knowledgeBase.decideEntry(entryId, decision, { decidedBy: actor.username, note: '' });
  await audit.record({ user: actor.username, role: actor.role, action: `kb_${decision}`, summary: `Администратор ${decision === 'approve' ? 'одобрил' : 'отклонил'} запись базы знаний`, target_type: 'kb', target_id: entryId, after: { status: e.status } });
  return { ok: true, id: entryId, status: e.status };
}

// ─── Audit log read ──────────────────────────────────────────────────────────
async function auditLog({ limit = 100 } = {}) {
  if (!connected()) return { db_connected: false, entries: [] };
  return { db_connected: true, entries: await audit.list({ limit }) };
}

module.exports = {
  summary, pipeline, inbox, drafts, kb, decide, chat, LEAD_STATE_LABELS,
  businessDashboard, sources, listUsers, createUser, setUserActive, kbPending, kbDecide, auditLog,
};
