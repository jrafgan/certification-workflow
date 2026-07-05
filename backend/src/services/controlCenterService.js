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
const operatorAssistant = require('./operatorAssistantService');
const newApplicationProposal = require('./newApplicationProposalService');
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
  return { type: 'email_draft', id: String(d._id), title: `Письмо лаборатории · ${EMAIL_KIND_RU[d.draft_type] || d.draft_type}`, subtitle: `${d.to_email || 'получатель не задан'} · ${d.client_name || ''}`,
    body: `${d.subject}\n\n${d.body}`, reason: d.reason, evidence: evidenceList(d.evidence), confidence: d.confidence_band,
    editable: true, actions: ['approve', 'reject', 'edit'], created_at: d.created_at, state: d.state, order_id: d.order_id ? String(d.order_id) : null };
}
function auditCard(d) {
  return { type: 'audit', id: String(d._id), title: `Статус заказа · ${d.client_name || d.sheet_row_id || ''}`,
    subtitle: `«${d.current_status}» → «${d.proposed_status || 'без изменений'}»`,
    body: d.reasoning, reason: d.reasoning, evidence: evidenceList(d.evidence).concat((d.findings || []).map(f => f.detail)),
    confidence: d.confidence_band, editable: false, actions: d.proposed_status ? ['approve', 'reject'] : ['acknowledge', 'reject'],
    created_at: d.created_at, state: d.state,
    // Status-audit card (Task 5): discrete fields for the Current | Evidence | Suggested | Confidence layout.
    audit_kind: 'status_audit', current_status: d.current_status, proposed_status: d.proposed_status || null,
    order_id: d.order_id ? String(d.order_id) : null };
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
    actions: ['approve', 'reject'], created_at: d.created_at, state: d.state, order_id: d.order_id ? String(d.order_id) : null };
}
// Incoming WhatsApp message — informational, NOT a gated decision (no approve/reject).
// If matched to an order, order_id enables the "Open order"/"Timeline" buttons.
const WA_MATCH_RU = { received: 'не разобрано', matched: 'привязано к заказу', needs_review: 'нужна проверка', unmatched: 'без заказа' };
function whatsappMessageCard(m) {
  const who = m.from_phone || m.lid || 'неизвестный';
  const hasMedia = (m.attachments || []).length > 0;
  const cands = m.candidates || [];
  // Show the matched order (client + status from the live-sheet match), not just "без заказа".
  let subtitle = WA_MATCH_RU[m.match_status] || m.match_status || '';
  if (m.match_status === 'matched' && cands[0]) subtitle = `${cands[0].client_name ? '«' + cands[0].client_name + '»' : 'заказ'}${cands[0].status ? ' · ' + cands[0].status : ''}`;
  else if (m.match_status === 'needs_review' && cands.length) subtitle = `нужна проверка · ${cands.length} заказ(ов)`;
  return { type: 'whatsapp_message', id: String(m._id), title: `💬 WhatsApp · ${who}`,
    subtitle, body: m.body || (hasMedia ? '[вложение]' : ''),
    evidence: [], confidence: null, editable: false, actions: [],
    created_at: m.received_at || m.created_at, order_id: m.matched_order_id ? String(m.matched_order_id) : null };
}
// Новая заявка (Новая форма) → предложение с расчётом ПИ/суммы + черновик ответа клиенту.
function newApplicationCard(d) {
  const subtitle = d.total_estimate != null
    ? `${d.doc_type} · ПИ ${d.protocol_count} · ~${d.total_estimate} ${d.currency || 'сом'}${d.is_minimum ? ' (от)' : ''}${d.laboratory ? ' · ' + d.laboratory : ''}`
    : (d.doc_type ? `${d.doc_type} · нужен расчёт` : 'тип документа не определён — нужен оператор');
  return { type: 'new_application', id: String(d._id),
    title: `📝 Новая заявка · ${d.applicant_name || d.applicant_phone || 'без имени'}`,
    subtitle, body: d.draft_reply,
    reason: (d.needs && d.needs.length) ? `Требует уточнения: ${d.needs.join(', ')}` : 'Готов расчёт и черновик ответа клиенту',
    evidence: (d.evidence || []).concat((d.warnings || []).map(w => `⚠ ${w.message}`)),
    confidence: d.doc_type ? null : 'LOW', editable: true,
    actions: ['approve', 'reject'], created_at: d.created_at, state: d.status };
}

// ─── Agent Inbox: unified recent stream across all engines ───────────────────
async function inbox({ limit = 60 } = {}) {
  if (!connected()) return { db_connected: false, items: [] };
  const { LeadMessageDraft, EmailDraft, AuditPackage, ExtractionReview, DraftPackage, LeadRecovery, WhatsAppMessage, NewApplicationProposal } = M();
  const [ld, ed, au, er, dp, lr, wa, np] = await Promise.all([
    LeadMessageDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    EmailDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    AuditPackage.find({ state: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
    ExtractionReview.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
    DraftPackage.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
    LeadRecovery.find({ state: { $in: ['pending', 'changes_requested'] } }).sort({ created_at: -1 }).limit(limit).lean(),
    // Incoming WhatsApp — direct + group-addressed only (archived group chatter excluded here).
    WhatsAppMessage.find({ direction: 'inbound', $or: [{ is_group: { $ne: true } }, { addressed_me: true }] }).sort({ received_at: -1 }).limit(limit).lean(),
    NewApplicationProposal.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean(),
  ]);
  const items = [
    ...ld.map(leadDraftCard), ...ed.map(emailDraftCard), ...au.map(auditCard),
    ...er.map(reviewCard), ...dp.map(packageCard), ...lr.map(recoveryCard),
    ...wa.map(whatsappMessageCard), ...np.map(newApplicationCard),
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
      case 'new_application':   { const d = await newApplicationProposal.decide(id, action === 'approve' ? 'approve' : 'dismiss', { decidedBy }); result = { ok: true, id, type, state: d && d.status }; break; }
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
  // Задача теперь НЕОБЯЗАТЕЛЬНА — можно задать общий вопрос по работе.
  const item = (type && id) ? await loadItem(type, id) : null;

  // Быстрые детерминированные ответы по конкретной задаче (без вызова LLM).
  if (item && /recalc|пересчит|recalculate/.test(q)) {
    const payload = item.payload || (item.proposed_data && item.proposed_data.pi) || null;
    if (payload && payload.doc_type) {
      const calc = pi.computePi({ doc_type: payload.doc_type, pi_count: payload.pi_count, compositions: payload.compositions, base_price: payload.base_price });
      return { answer: `Recalculated (${calc.doc_type}): ПИ ${calc.pi_count}, оценка ${calc.total_estimate} ${calc.currency}${calc.is_minimum ? ' (от)' : ''}. Требует подтверждения оператора.`, calc, evidence: calc.basis };
    }
    return { answer: 'No calculation inputs stored on this item to recalculate.', evidence: [] };
  }

  const reason = item ? (item.reason || item.reasoning || '(no stored reason)') : null;
  const evidence = item ? evidenceList(item.evidence).concat((item.findings || []).map(f => `${f.type}: ${f.detail}`)) : [];

  if (item && /evidence|докаж|основани|покажи/.test(q)) {
    return { answer: evidence.length ? `Stored evidence (${evidence.length}):` : 'No structured evidence stored for this item.', evidence };
  }

  // Свободный вопрос → живой ИИ-помощник оператора (grounded в БЗ + контексте задачи).
  if (operatorAssistant.isConfigured()) {
    const contextItem = item ? { title: itemTitle(type, item), reason, evidence } : null;
    const r = await operatorAssistant.ask({ question, contextItem });
    if (r.ok) return { answer: r.answer, evidence, llm: true };
    // ошибка LLM → откат на canned ниже
  }

  // Fallback без LLM: если есть задача — объясняем сохранённое обоснование; иначе подсказка.
  if (!item) {
    return { answer: 'Задайте вопрос по конкретной задаче (выберите её слева) — или включите ИИ-помощника, задав ANTHROPIC_API_KEY в .env.', evidence: [] };
  }
  return { answer: `Why: ${reason}`, evidence, confidence: item.confidence_band || item.confidence || null };
}

// Краткий заголовок задачи для контекста ассистента (мягко, без обязательности схемы).
function itemTitle(type, item) {
  return item.client_name || item.subject || item.reason || `${type} ${item._id || ''}`.trim();
}

async function loadItem(type, id) {
  const { LeadMessageDraft, EmailDraft, AuditPackage, ExtractionReview, DraftPackage, LeadRecovery, NewApplicationProposal } = M();
  switch (type) {
    case 'lead_message':      return LeadMessageDraft.findById(id).lean();
    case 'email_draft':       return EmailDraft.findById(id).lean();
    case 'audit':             return AuditPackage.findById(id).lean();
    case 'extraction_review': return ExtractionReview.findById(id).lean();
    case 'draft_package':     return DraftPackage.findById(id).lean();
    case 'lead_recovery':     return LeadRecovery.findById(id).lean();
    case 'new_application':   return NewApplicationProposal.findById(id).lean();
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

  // Declaration — LIVE read of the «Декларация» Google Sheet (the sheet is the source of
  // truth; the Mongo replica is intentionally unused/empty, so counting it falsely showed
  // "не загружены"). Independent of Mongo; graceful fallback if the sheet is unreachable.
  try {
    const rows = await require('./workQueueService').defaultReadDeclaration();
    const n = Array.isArray(rows) ? rows.length : 0;
    push('declaration', 'Декларации (таблица)', n > 0 ? 'ok' : 'empty', n > 0 ? `Строк в таблице: ${n}` : 'Таблица «Декларация» пуста', n);
  } catch (err) {
    push('declaration', 'Декларации (таблица)', 'unavailable', `Не удалось прочитать таблицу «Декларация»: ${err.message}`);
  }

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

// Per-user activity counter — «кто что сделал и сколько», for oversight / error review.
// Aggregates the immutable audit trail by user, with a breakdown by action and last-active time.
const AUDIT_ACTION_RU = {
  login: 'входы', logout: 'выходы', change_password: 'смена пароля',
  approve: 'одобрено', reject: 'отклонено', edit: 'правки',
  application_mark_not_new: 'заявки «не новая»', application_reopen: 'заявки возвращены',
  thread_done: 'треды «готово»', thread_snooze: 'треды отложены', thread_seen: 'просмотры',
  create_user: 'создано пользователей', kb_decision: 'решения по БЗ',
};
async function userActivity({ days = 30 } = {}) {
  if (!connected()) return { db_connected: false, users: [] };
  const { AuditLog } = require('../models');
  const since = days ? new Date(Date.now() - Number(days) * 86_400_000) : null;
  const rows = await AuditLog.aggregate([
    ...(since ? [{ $match: { at: { $gte: since } } }] : []),
    { $group: { _id: { user: '$user', action: '$action' }, n: { $sum: 1 }, last: { $max: '$at' }, role: { $last: '$role' } } },
  ]);
  const byUser = new Map();
  for (const r of rows) {
    const u = r._id.user || '—';
    let e = byUser.get(u);
    if (!e) { e = { user: u, role: r.role || null, total: 0, last_at: null, by_action: {} }; byUser.set(u, e); }
    e.total += r.n;
    e.by_action[r._id.action] = (e.by_action[r._id.action] || 0) + r.n;
    if (r.role) e.role = r.role;
    if (!e.last_at || new Date(r.last) > new Date(e.last_at)) e.last_at = r.last;
  }
  const users = [...byUser.values()].sort((a, b) => b.total - a.total).map(e => ({
    ...e,
    breakdown: Object.entries(e.by_action).sort((a, b) => b[1] - a[1])
      .map(([action, n]) => ({ action, label: AUDIT_ACTION_RU[action] || action, n })),
  }));
  return { db_connected: true, days: Number(days), users };
}

// Авто-ответчик: список решений (что агент ОТВЕТИЛ БЫ / ответил / отложил) для проверки
// оператором ПЕРЕД включением реальной отправки (mode=auto). Read-only.
const WA_DECISION_RU = { shadow: 'ответил бы (не отправлено)', auto_sent: 'отправлено', gated: 'оператору', skipped: 'пропущено' };
async function autoReplies({ limit = 80, decision } = {}) {
  if (!connected()) return { db_connected: false, items: [], counts: {}, mode: process.env.WA_AUTORESPONDER_MODE || 'shadow' };
  const { WaAutoReply } = require('../models');
  const q = {};
  if (decision) q.decision = decision;
  const [docs, agg] = await Promise.all([
    WaAutoReply.find(q).sort({ created_at: -1 }).limit(Math.min(Number(limit) || 80, 300)).lean(),
    WaAutoReply.aggregate([{ $group: { _id: '$decision', n: { $sum: 1 } } }]),
  ]);
  const counts = {}; for (const a of agg) counts[a._id || 'unknown'] = a.n;
  return {
    db_connected: true,
    mode: process.env.WA_AUTORESPONDER_MODE || 'shadow',
    counts,
    items: docs.map(d => ({
      id: String(d._id), phone: d.to_phone || d.phone_key || '', kind: d.kind, topic: d.topic || null,
      inbound: d.inbound_text || '', answer: d.answer_text || '', matched: d.matched_kb_ref || null,
      decision: d.decision, decision_ru: WA_DECISION_RU[d.decision] || d.decision,
      skip_reason: d.skip_reason || null, at: d.created_at || null,
    })),
  };
}

// ─── Attention queue + Critical Issues (operational control center) ──────────
const MS_DAY = 86_400_000;
function _daysSince(d, now) { return d == null ? null : Math.floor((now - new Date(d).getTime()) / MS_DAY); }
function _latest(a) { return Array.isArray(a) && a.length ? a[a.length - 1] : null; }
const _ACTIVE = ['Запустить', 'Ждем макет', 'На согласовании', 'Ждем оригинал', 'Оригинал получен'];
const SEV_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const CONF_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

// PURE: the most dangerous condition(s) for one order — "what is most dangerous for the
// business" (lab overdue, original overdue, approval overdue, paid-but-not-launched,
// client waiting too long). One order yields at most one specific danger (+ a generic
// long-idle flag only if nothing specific fired). Exported for testing.
function orderDangers(order = {}, now = Date.now()) {
  const st = String(order.status || '').trim();
  const li = _latest(order.lab_interactions);
  const layout = _latest(order.layouts);
  const original = _latest(order.originals);
  const client = order.client?.companyName || order.client?.name || 'клиент';
  const ref = order.sheet_row_id ? `order_row:${order.sheet_row_id}` : `order:${order._id}`;
  const oid = String(order._id);
  const layoutSla = order.laboratory?.expectedLayoutDays || 5;
  const origSla = order.laboratory?.expectedOriginalDays || 10;
  const out = [];
  const add = (type, severity, label, detail) => out.push({ type, severity, label, detail, order_id: oid, ref });

  if (st === 'Запустить') {
    const paid = (order.payments || []).some(p => !p.voided && (p.amount || 0) > 0);
    const idle = _daysSince(order.updated_at || order.created_at, now);
    if (paid && !(li && li.sent_at) && idle != null && idle >= 2)
      add('paid_not_launched', 'HIGH', 'Оплата получена, но не запущено', `«${client}»: оплачено, но заявка в лабораторию не отправлена (${idle} дн.)`);
  } else if (st === 'Ждем макет' && li && li.sent_at) {
    const w = _daysSince(li.sent_at, now);
    if (w != null && w > layoutSla) add('lab_overdue', 'HIGH', 'Лаборатория задерживает макет', `«${client}»: ждём макет ${w} дн. (SLA ${layoutSla})`);
  } else if (st === 'Ждем оригинал') {
    const due = order.deadlines?.original_expected;
    const anchor = due || li?.layout_received_at || li?.sent_at;
    const over = due ? now > new Date(due).getTime() : (_daysSince(anchor, now) != null && _daysSince(anchor, now) > origSla);
    if (over) add('original_overdue', 'HIGH', 'Оригинал просрочен', `«${client}»: оригинал не получен (${_daysSince(anchor, now)} дн.)`);
  } else if (st === 'На согласовании') {
    const due = order.deadlines?.client_response_due;
    const anchor = due || layout?.sent_to_client_at || order.updated_at;
    const decided = layout?.client_decision;
    const over = !decided && (due ? now > new Date(due).getTime() : (_daysSince(anchor, now) != null && _daysSince(anchor, now) > 3));
    if (over) add('approval_overdue', 'MEDIUM', 'Клиент не согласовал макет', `«${client}»: на согласовании ${_daysSince(anchor, now)} дн.`);
  } else if (st === 'Завершен') {
    // Completion integrity (Status Verification Engine): a «Завершен» order must have NO debt AND
    // a recorded delivery to the client. Otherwise the status claims more than reality supports.
    const debt = Number(order.balance_due || 0);
    if (debt > 0)
      add('completed_with_debt', 'HIGH', 'Завершён, но есть долг', `«${client}»: статус «Завершен», но числится долг ${debt} сом — оригинал не выдаётся до полной оплаты (KB).`);
    else if (!(original && original.sent_to_client_at))
      add('completed_not_delivered', 'HIGH', 'Завершён, но оригинал не выдан', `«${client}»: статус «Завершен», но нет отметки о выдаче оригинала клиенту.`);
  }

  // Generic: active order with no specific danger but very long idle.
  if (out.length === 0 && _ACTIVE.includes(st)) {
    const idle = _daysSince(order.updated_at || order.created_at, now);
    if (idle != null && idle >= 14) add('client_waiting_long', 'MEDIUM', 'Заказ давно без движения', `«${client}»: ${idle} дн. без изменений (статус «${st}»)`);
  }
  return out;
}

// PURE: the 6-step client timeline for one order, each step done|current|pending.
function orderTimelineSteps(order = {}) {
  const st = String(order.status || '').trim();
  const li = _latest(order.lab_interactions), layout = _latest(order.layouts), original = _latest(order.originals);
  const paid = (order.payments || []).some(p => !p.voided && (p.amount || 0) > 0);
  const past = (set) => set.includes(st);
  const reached = {
    application: true,
    payment:  paid || past(['Запустить', 'Ждем макет', 'На согласовании', 'Ждем оригинал', 'Оригинал получен', 'Завершен']),
    lab:      !!(li && li.sent_at) || past(['Ждем макет', 'На согласовании', 'Ждем оригинал', 'Оригинал получен', 'Завершен']),
    approval: (layout && layout.client_decision === 'approved') || past(['Ждем оригинал', 'Оригинал получен', 'Завершен']),
    original: !!(original && original.received_at) || past(['Оригинал получен', 'Завершен']),
    complete: st === 'Завершен' || !!(original && original.sent_to_client_at),
  };
  const keys = ['application', 'payment', 'lab', 'approval', 'original', 'complete'];
  const labels = { application: 'Заявка', payment: 'Оплата', lab: 'Лаборатория', approval: 'Согласование', original: 'Оригинал', complete: 'Завершено' };
  let currentIdx = keys.findIndex(k => !reached[k]);
  if (currentIdx === -1) currentIdx = keys.length;
  return keys.map((k, i) => ({ key: k, label: labels[k], state: reached[k] ? 'done' : (i === currentIdx ? 'current' : 'pending') }));
}

// DB: the attention screen — critical issues + the prioritized "needs attention" queue +
// waiting/completed bucket counts. Reuses inbox() (agent proposals) and scans Orders.
async function attention() {
  if (!connected()) return { db_connected: false, critical_issues: [], buckets: { needs_attention: [] } };
  const { Order, Lead } = M();
  const now = Date.now();

  const items = (await inbox({ limit: 100 })).items || [];
  // Priority, not recency: recommended/confident first, then severity, then newest.
  items.sort((a, b) => (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0) || new Date(b.created_at) - new Date(a.created_at));

  // Include «Завершен» so completion-integrity issues (debt / undelivered) surface as critical.
  const orders = await Order.find({ status: { $in: [..._ACTIVE, 'Завершен'] } })
    .select('status client laboratory deadlines payments lab_interactions layouts originals balance_due created_at updated_at sheet_row_id')
    .limit(2000).lean();

  const critical_issues = [];
  for (const o of orders) critical_issues.push(...orderDangers(o, now));
  critical_issues.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));

  const st = (s) => orders.filter(o => String(o.status || '').trim() === s).length;
  const buckets = {
    needs_attention: items,
    waiting_lab: st('Ждем макет') + st('Ждем оригинал'),
    waiting_client: st('На согласовании') + await Lead.countDocuments({ state: { $in: ['waiting_application', 'waiting_payment'] } }),
    waiting_operator: st('Запустить') + st('Оригинал получен'),
    completed: await Order.countDocuments({ status: 'Завершен' }),
  };
  return { db_connected: true, critical_issues, buckets };
}

// DB: one order's client timeline.
async function orderTimeline(orderId) {
  if (!connected()) return { db_connected: false };
  const { Order } = M();
  const o = await Order.findById(orderId).lean();
  if (!o) throw errorUtils.notFoundError('Заказ не найден');
  return { db_connected: true, order_id: String(o._id), client: o.client?.companyName || o.client?.name || null, status: o.status, steps: orderTimelineSteps(o) };
}

// DB: one order's UNIFIED workspace (Declaration + WhatsApp + email + attachments + payments
// + status verification + agent recommendations). Read-only. See orderWorkspaceService.
async function orderWorkspace(orderId) {
  if (!connected()) return { db_connected: false };
  const r = await require('./orderWorkspaceService').getWorkspace(orderId);
  if (!r.found) throw errorUtils.notFoundError('Заказ не найден');
  return { db_connected: true, ...r.workspace };
}

// DB: the Attention Center — 7 categories of what needs the operator today. Read-only.
async function attentionCenter() {
  if (!connected()) return { db_connected: false, categories: [], total: 0 };
  const r = await require('./attentionCenterService').build();
  return { db_connected: true, ...r };
}

// ─── Task Inbox (WhatsApp-style To-Do) — read-only, see taskInboxService ─────────
async function taskInbox() {
  if (!connected()) return { db_connected: false, tasks: [], total: 0 };
  const r = await require('./taskInboxService').tasks();
  return { db_connected: true, ...r };
}
async function clientEmails(phone) {
  if (!connected()) return { db_connected: false, emails: [] };
  const r = await require('./taskInboxService').clientEmails(phone);
  return { db_connected: true, ...r };
}
async function taskThread(phone) {
  if (!connected()) return { db_connected: false };
  const r = await require('./taskInboxService').thread(phone);
  return { db_connected: true, ...r };
}
// Full archive search (all WhatsApp, both directions) — for analysing old conversations.
async function waSearch({ q, phone, limit } = {}) {
  if (!connected()) return { db_connected: false, messages: [] };
  const messages = await require('./taskInboxService').searchArchive({ q, phone, limit });
  return { db_connected: true, messages, count: messages.length };
}
// The ONLY mutation here — operator UI state (read/done/snooze), AUDITED.
async function markThread({ phone, action, until, actor = {} } = {}) {
  if (!connected()) throw errorUtils.validationError('Нет подключения к базе данных');
  if (!phone || !action) throw errorUtils.validationError('phone, action обязательны');
  const r = await require('./taskInboxService').markThread(phone, action, { until, updated_by: actor.username || 'operator' });
  if (r.ok) await audit.record({ user: actor.username, role: actor.role, action: `thread_${action}`,
    summary: `${actor.role === 'administrator' ? 'Администратор' : 'Оператор'} отметил тред ${phone} (${action})`,
    target_type: 'inbox_thread', target_id: r.phone_key });
  return r;
}

// Operator marks/reopens a New-Form application as «не новая» — AUDITED. Trusts the human over
// the agent's «новая заявка» guess (see taskInboxService.markApplication).
const APP_REASON_RU = {
  already_replied: 'уже ответили', not_relevant: 'не актуальна', duplicate: 'дубликат',
  spam_wrong: 'спам/ошибка', handled_offline: 'обработана вне системы',
  already_client: 'уже клиент', other: 'другое',
};
async function markApplication({ phone, sheet_row, client_name, reason, note, actor = {} } = {}) {
  if (!connected()) throw errorUtils.validationError('Нет подключения к базе данных');
  const r = await require('./taskInboxService').markApplication({ phone, sheet_row, client_name, reason, note, operator: actor.username || 'operator' });
  if (r.ok) await audit.record({ user: actor.username, role: actor.role, action: 'application_mark_not_new',
    summary: `${actor.role === 'administrator' ? 'Администратор' : 'Оператор'} отметил заявку${client_name ? ` «${client_name}»` : ''} как не новую (${APP_REASON_RU[r.reason] || r.reason})`,
    target_type: 'application_override', target_id: r.app_key });
  return r;
}
async function reopenApplication({ phone, sheet_row, actor = {} } = {}) {
  if (!connected()) throw errorUtils.validationError('Нет подключения к базе данных');
  const r = await require('./taskInboxService').reopenApplication({ phone, sheet_row });
  if (r.ok) await audit.record({ user: actor.username, role: actor.role, action: 'application_reopen',
    summary: `${actor.role === 'administrator' ? 'Администратор' : 'Оператор'} вернул заявку в новые`,
    target_type: 'application_override', target_id: r.app_key });
  return r;
}

module.exports = {
  summary, pipeline, inbox, drafts, kb, decide, chat, LEAD_STATE_LABELS,
  businessDashboard, sources, listUsers, createUser, setUserActive, kbPending, kbDecide, auditLog, userActivity,
  // attention-first (pure + db)
  orderDangers, orderTimelineSteps, attention, orderTimeline, orderWorkspace, attentionCenter,
  // task inbox (WhatsApp-style to-do)
  taskInbox, taskThread, markThread, waSearch, markApplication, reopenApplication,
  autoReplies, clientEmails,
};
