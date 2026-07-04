'use strict';

// services/newApplicationProposalService.js — НОВАЯ ЗАЯВКА → предложение оператору.
//
// Клиент заполнил Новую форму → агент: классифицирует (ДС/СС), считает протоколы (ПИ) и
// ориентировочную сумму, готовит ЧЕРНОВИК ответа клиенту. Всё OUTPUT-ONLY: оператор
// подтверждает/правит/отклоняет (recommendation mode). Ничего не отправляется и не пишется
// в Декларацию. Источник заявок — лист Новой формы (read-only).
//
// Слои:
//   • buildProposal(app)  — ЧИСТАЯ функция: classify + computePi + шаблон ответа. Тестируема.
//   • generate(deps)      — читает строки формы, строит предложения, апсертит (идемпотентно).
//   • listPending/decide  — очередь оператора.

const crypto = require('crypto');
const classifier = require('./newFormClassificationService');
const pi = require('./piCalculationService');
const templates = require('./leadReplyTemplates');

function matchKey(v) { const d = String(v || '').replace(/\D/g, ''); return d ? d.slice(-9) : ''; }

const NEED_INFO_REPLY =
  'Здравствуйте! Чтобы точно посчитать стоимость и количество протоколов испытаний, ' +
  'уточните, пожалуйста: товар детский или взрослый, состав ткани по каждому товару и ' +
  'код ТН ВЭД (если есть).';

// buildProposal(app) — app в форме formFieldMapper.mapRow (applicant{}, age, items_text,
// composition_text, tnved_text) ИЛИ плоский { applicant_name, phone, age, items_text, ... }.
function buildProposal(app = {}) {
  const applicant_name = (app.applicant && app.applicant.name) || app.applicant_name || '';
  const phone = (app.applicant && app.applicant.phone) || app.phone || app.applicant_phone || '';
  const items_text = app.items_text || '';
  const composition_text = app.composition_text || '';
  const tnved_text = app.tnved_text || '';

  const cls = classifier.classify({ age: app.age || '', items_text, composition_text, tnved_text });
  const warnings = Array.isArray(cls.warnings) ? cls.warnings : [];
  const needs = [];

  let calc = null;
  if (cls.doc_type === 'ДС' || cls.doc_type === 'СС') {
    try { calc = pi.computePi({ doc_type: cls.doc_type, pi_count: cls.estimated_protocol_count }); }
    catch (_) { calc = null; }
  } else {
    needs.push('determine_doc_type'); // возраст/категория неясны — тип документа за оператором
  }
  if (calc && calc.needs_workshop_clarification) needs.push('confirm_workshop_docs');

  const draft_reply = calc ? templates.render('calculation_offer', { calc }) : NEED_INFO_REPLY;

  return {
    generated: true,
    applicant_name,
    applicant_phone: phone,
    phone_key: matchKey(phone),
    doc_type: cls.doc_type || null,
    category: cls.category || 'unknown',
    age: (cls.age && cls.age.value) || 'unknown',
    // ПИ на карточке = как в расчёте (calc.pi_count форсит минимум 1, если состав не распознан),
    // чтобы карточка не расходилась с текстом ответа. Без расчёта — оценка классификатора.
    protocol_count: calc ? calc.pi_count : (cls.estimated_protocol_count != null ? cls.estimated_protocol_count : null),
    additional_pi: calc ? calc.additional_pi : null,
    total_estimate: calc ? calc.total_estimate : null,
    currency: calc ? calc.currency : null,
    is_minimum: calc ? calc.is_minimum : true,
    samples_required: (calc && calc.samples_required != null) ? calc.samples_required : (cls.samples_required != null ? cls.samples_required : null),
    laboratory: (calc && calc.laboratory) || cls.laboratory || null,
    draft_reply,
    warnings: warnings.map(w => ({ code: w.code, message: w.message })),
    needs,
    evidence: calc ? calc.basis : [],
  };
}

// Контентный ключ строки (позиция-независимый) → идемпотентность апсерта.
function dedupeKey(app = {}) {
  const name = (app.applicant && app.applicant.name) || app.applicant_name || '';
  const phone = (app.applicant && app.applicant.phone) || app.phone || app.applicant_phone || '';
  const items = app.items_text || '';
  const tnved = app.tnved_text || '';
  const h = crypto.createHash('sha1').update(`${name}|${phone}|${items}|${tnved}`).digest('hex').slice(0, 16);
  return `newapp:${h}`;
}

// generate(opts, deps) — прочитать форму, построить предложения, апсертить. Идемпотентно.
// opts.limit — максимум НОВЫХ предложений за прогон (чтобы не завалить инбокс 500+ строк
// разом; последующие прогоны доберут остальное). Новые заявки формы дописываются вниз,
// поэтому opts.newestFirst=true обрабатывает с конца листа (свежие заявки — раньше).
async function generate(opts = {}, deps = {}) {
  const NewApplicationProposal = deps.NewApplicationProposal || require('../models/NewApplicationProposal').NewApplicationProposal;
  const formClient = deps.newFormClient || require('../integrations/newFormClient');
  const mapper = deps.formFieldMapper || require('./formFieldMapper');
  const limit = Number.isFinite(opts.limit) ? opts.limit : null;

  const r = deps.readFormRows ? await deps.readFormRows() : await formClient.readFormRows();
  if (!r || !r.ok) return { generated: 0, skipped: 0, empty: 0, reason: (r && r.reason) || 'read_failed' };

  const { header, dataRows, tab } = r;
  const summary = { generated: 0, skipped: 0, empty: 0, tab, total: (dataRows || []).length };

  const order = opts.newestFirst ? [...dataRows.keys()].reverse() : [...dataRows.keys()];
  for (const i of order) {
    if (limit != null && summary.generated >= limit) break;
    const app = mapper.mapRow(header, dataRows[i]);
    const p = buildProposal(app);
    if (!p.applicant_name && !p.applicant_phone && !String(app.items_text || '').trim()) { summary.empty++; continue; }

    const dedupe_key = dedupeKey(app);
    if (await NewApplicationProposal.exists({ dedupe_key })) { summary.skipped++; continue; }

    const doc = { ...p, source: { sheet_tab: tab, row_index: i, applicant: p.applicant_name, phone: p.applicant_phone }, dedupe_key, status: 'pending' };
    delete doc.generated;
    try { await NewApplicationProposal.create(doc); summary.generated++; }
    catch (e) { if (e && (e.code === 11000 || e.code === 'E11000')) summary.skipped++; else throw e; }
  }
  return summary;
}

async function listPending(limit = 50, deps = {}) {
  const NewApplicationProposal = deps.NewApplicationProposal || require('../models/NewApplicationProposal').NewApplicationProposal;
  return NewApplicationProposal.find({ status: 'pending' }).sort({ created_at: -1 }).limit(limit).lean();
}

async function decide(id, decision, opts = {}, deps = {}) {
  const NewApplicationProposal = deps.NewApplicationProposal || require('../models/NewApplicationProposal').NewApplicationProposal;
  const status = decision === 'approve' ? 'approved' : decision === 'dismiss' ? 'dismissed' : null;
  if (!status) throw new Error(`Unknown decision "${decision}" (use approve|dismiss)`);
  const doc = await NewApplicationProposal.findByIdAndUpdate(
    id, { $set: { status, decided_by: opts.decidedBy || undefined, decided_at: new Date() } }, { new: true },
  );
  return doc;
}

module.exports = { buildProposal, dedupeKey, generate, listPending, decide, NEED_INFO_REPLY };
