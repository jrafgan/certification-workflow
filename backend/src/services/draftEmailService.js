'use strict';

// services/draftEmailService.js — Draft Email Engine.
//
// Scans Orders and, where the lab workflow needs an outbound LAB email, prepares a
// complete draft (recipient, subject, RU body) bound to that Order for operator review.
//
// HARD RULE — OUTPUT ONLY. Never sends. It reads Orders and writes only its OWN draft
// store (email_drafts). 'approve' authorizes the exact text; the actual send stays an
// operator action (gmailClient exposes no send path here). Email is a LAB-ONLY channel —
// these drafts are always addressed to a laboratory, never to a client.
//
// The trigger/template/build functions are PURE (no I/O) and exported for testing. The
// DB-backed generate/decide functions mirror whatsappDraftService + draftPackageService.

const errorUtils = require('../utils/errorUtils');

const MS_PER_DAY = 86_400_000;

// Default SLAs when the order/laboratory carries none (aligned with lab comm defaults).
const DEFAULT_LAYOUT_SLA_DAYS   = parseInt(process.env.LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS, 10)   || 2;
const DEFAULT_ORIGINAL_SLA_DAYS = parseInt(process.env.LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS, 10) || 4;

const IMPACT =
  'If approved, the operator sends this email to the laboratory. Nothing is sent automatically; ' +
  'no order status changes here. Email is a lab-only channel — the client is never emailed.';

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function daysSince(date, now = Date.now()) {
  if (!date) return null;
  return (now - new Date(date).getTime()) / MS_PER_DAY;
}

function orderRef(order) {
  return order.sheet_row_id ? `order_row:${order.sheet_row_id}` : `order:${order._id}`;
}

function clientLabel(order) {
  return order.client?.companyName || order.client?.name || 'клиент';
}

// The most recent lab_interaction (where the layout request lives), or null.
function latestLabInteraction(order) {
  const xs = Array.isArray(order.lab_interactions) ? order.lab_interactions : [];
  return xs.length ? xs[xs.length - 1] : null;
}

// ─── Pure: choose the applicable trigger for an order (or null) ───────────────
// Deterministic, no I/O. Decides WHICH lab email (if any) the order needs right now.
// Returns { draft_type, reason, evidence, confidence_band, overdue_days? } or null.
function chooseTrigger(order = {}, now = Date.now()) {
  // A lab email is only meaningful when we know where to send it.
  const labEmail = order.laboratory?.laboratoryEmail;
  if (!labEmail) return null;
  if (order.status === 'Отменен' || order.status === 'Завершен') return null;

  const ref = orderRef(order);
  const li  = latestLabInteraction(order);

  // 1) Ready to launch, lab request not yet sent → initial lab request.
  if (order.status === 'Запустить' && (!li || !li.sent_at)) {
    return {
      draft_type: 'lab_request',
      reason: 'Заказ готов к запуску, но запрос в лабораторию ещё не отправлен.',
      evidence: [
        { kind: 'order_status', ref, detail: 'Статус «Запустить» — оплата получена, можно отправлять в лабораторию.' },
      ],
      confidence_band: 'MEDIUM',
    };
  }

  // 2) Awaiting layout (макет) and the layout SLA has passed → layout reminder.
  if (order.status === 'Ждем макет' && li && li.sent_at) {
    const slaDays = order.laboratory?.expectedLayoutDays || DEFAULT_LAYOUT_SLA_DAYS;
    const waited  = daysSince(li.sent_at, now);
    if (waited != null && waited > slaDays) {
      return {
        draft_type: 'lab_reminder_layout',
        reason: `Лаборатория не прислала макет: ждём ${Math.floor(waited)} дн. при SLA ${slaDays} дн.`,
        evidence: [
          { kind: 'order_status', ref, detail: 'Статус «Ждем макет».' },
          { kind: 'sla_overdue',  ref, detail: `Запрос отправлен ${Math.floor(waited)} дн. назад (SLA ${slaDays} дн.).` },
        ],
        confidence_band: 'HIGH',
        overdue_days: Math.floor(waited),
      };
    }
    return null;
  }

  // 3) Awaiting the original and its SLA has passed → original reminder.
  if (order.status === 'Ждем оригинал') {
    const expected = order.deadlines?.original_expected;
    const slaDays  = order.laboratory?.expectedOriginalDays || DEFAULT_ORIGINAL_SLA_DAYS;
    const anchor   = expected || li?.layout_received_at || li?.sent_at;
    const overdue  = expected
      ? (now > new Date(expected).getTime())
      : (daysSince(anchor, now) != null && daysSince(anchor, now) > slaDays);
    if (overdue) {
      const waited = Math.floor(daysSince(anchor, now) ?? slaDays + 1);
      return {
        draft_type: 'lab_reminder_original',
        reason: 'Оригинал документа не получен в ожидаемый срок — напоминание лаборатории.',
        evidence: [
          { kind: 'order_status',    ref, detail: 'Статус «Ждем оригинал».' },
          { kind: 'sla_overdue',     ref, detail: expected ? `Срок получения оригинала истёк (${new Date(expected).toISOString().slice(0,10)}).` : `Ожидание ${waited} дн. (SLA ${slaDays} дн.).` },
        ],
        confidence_band: 'HIGH',
        overdue_days: waited,
      };
    }
    return null;
  }

  return null;
}

// ─── Pure: render the RU subject + body for a trigger ─────────────────────────
function renderEmail(order, trigger) {
  const lab    = order.laboratory?.laboratoryName || 'лаборатория';
  const client = clientLabel(order);
  const li     = latestLabInteraction(order);
  const ver    = li?.version ? ` (версия ${li.version})` : '';

  switch (trigger.draft_type) {
    case 'lab_request':
      return {
        subject: `Заявка на оформление — ${client}`,
        body: [
          `Здравствуйте!`,
          ``,
          `Просим принять в работу заявку на оформление документа для «${client}».`,
          `Все необходимые данные и документы прилагаются.`,
          ``,
          `Пожалуйста, подтвердите получение и ориентировочные сроки подготовки макета.`,
          ``,
          `С уважением,`,
          `Отдел сертификации`,
        ].join('\n'),
      };
    case 'lab_reminder_layout':
      return {
        subject: `Напоминание: ожидаем макет — ${client}${ver}`,
        body: [
          `Здравствуйте!`,
          ``,
          `Напоминаем по заявке «${client}»${ver}: ожидаем макет (${trigger.overdue_days ?? ''} дн. с момента отправки запроса).`,
          `Просим сообщить статус и ожидаемую дату готовности.`,
          ``,
          `С уважением,`,
          `Отдел сертификации`,
        ].join('\n'),
      };
    case 'lab_reminder_original':
      return {
        subject: `Напоминание: ожидаем оригинал — ${client}${ver}`,
        body: [
          `Здравствуйте!`,
          ``,
          `По заявке «${client}»${ver} ожидаем оригинал документа — срок получения уже подошёл.`,
          `Просим сообщить статус отправки оригинала.`,
          ``,
          `С уважением,`,
          `Отдел сертификации`,
        ].join('\n'),
      };
    case 'lab_corrections':
      return {
        subject: `Правки по макету — ${client}${ver}`,
        body: [
          `Здравствуйте!`,
          ``,
          `По заявке «${client}»${ver} направляем правки по макету (см. вложение/ниже).`,
          `Просим внести изменения и прислать обновлённый макет.`,
          ``,
          `С уважением,`,
          `Отдел сертификации`,
        ].join('\n'),
      };
    default:
      return { subject: `По заявке — ${client}`, body: 'Здравствуйте!' };
  }
}

// ─── Pure: build a full draft from an order + chosen trigger ───────────────────
function buildLabEmailDraft(order = {}, trigger = chooseTrigger(order)) {
  if (!trigger) return { generated: false, reason: 'no_trigger' };
  const labEmail = order.laboratory?.laboratoryEmail;
  if (!labEmail) return { generated: false, reason: 'no_lab_email' };

  const { subject, body } = renderEmail(order, trigger);
  return {
    generated:       true,
    order_id:        order._id,
    sheet_row_id:    order.sheet_row_id || null,
    client_name:     clientLabel(order),
    to_email:        labEmail,
    lab_name:        order.laboratory?.laboratoryName || null,
    draft_type:      trigger.draft_type,
    subject,
    body,
    reason:          trigger.reason,
    evidence:        trigger.evidence || [],
    impact:          IMPACT,
    confidence_band: trigger.confidence_band || 'MEDIUM',
  };
}

// ─── Pure: idempotency key (one open draft per order + type) ───────────────────
function dedupeKey(order = {}, draftType) {
  return ['LAB_EMAIL', String(order._id || order.sheet_row_id || 'na'), draftType].join('|');
}

// ─── Pure: legal decision transitions (shared shape with whatsappDraftService) ─
function applyDecisionTransition(currentState, decision) {
  const DECIDABLE = ['pending_approval', 'changes_requested'];
  if (!DECIDABLE.includes(currentState)) {
    throw errorUtils.conflictError(`Email draft in state "${currentState}" cannot be decided`);
  }
  switch (decision) {
    case 'approve':         return 'approved';   // does NOT send
    case 'reject':          return 'rejected';
    case 'request_changes': return 'changes_requested';
    default:
      throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject|request_changes)`);
  }
}

// ─── DB-backed: generate pending lab-email drafts from current orders ──────────
// Reads Orders (read-only) and writes only the email_drafts store. Idempotent via
// dedupe_key (skips when an OPEN draft of the same type already exists for the order).
// Never sends. deps inject Order/EmailDraft for testing.
async function generate(deps = {}) {
  const Order      = deps.Order      || require('../models/Order').Order;
  const EmailDraft = deps.EmailDraft || require('../models/EmailDraft').EmailDraft;
  const now = deps.now || Date.now();
  // Optional cap on NEW drafts per run — keeps the scheduler from flooding the inbox on the
  // first Declaration→Order sync (the backlog is worked through over subsequent runs). Dedupe
  // (one open draft per order+type) prevents regeneration regardless.
  const limit = Number.isFinite(deps.limit) ? deps.limit : null;

  const orders = await Order.find({ status: { $in: ['Запустить', 'Ждем макет', 'Ждем оригинал'] } })
    .select('status sheet_row_id client laboratory deadlines lab_interactions')
    .limit(2000)
    .lean();

  const summary = { generated: 0, skipped: 0, drafts: [], reasons: {} };
  const bump = (k) => { summary.reasons[k] = (summary.reasons[k] || 0) + 1; };

  for (const order of orders) {
    if (limit != null && summary.generated >= limit) break;
    const trigger = chooseTrigger(order, now);
    if (!trigger) { summary.skipped++; bump('no_trigger'); continue; }

    const draft = buildLabEmailDraft(order, trigger);
    if (!draft.generated) { summary.skipped++; bump(draft.reason); continue; }

    const dedupe_key = dedupeKey(order, draft.draft_type);
    // Skip when an OPEN draft of this type already exists (pending/changes/approved).
    const open = await EmailDraft.exists({ dedupe_key, state: { $in: ['pending_approval', 'changes_requested', 'approved'] } });
    if (open) { summary.skipped++; bump('open_draft_exists'); continue; }

    const doc = {
      order_id:        draft.order_id,
      sheet_row_id:    draft.sheet_row_id || undefined,
      client_name:     draft.client_name,
      to_email:        draft.to_email,
      lab_name:        draft.lab_name || undefined,
      draft_type:      draft.draft_type,
      subject:         draft.subject,
      body:            draft.body,
      reason:          draft.reason,
      evidence:        draft.evidence,
      impact:          draft.impact,
      confidence_band: draft.confidence_band,
      dedupe_key,
      state:           'pending_approval',
    };

    try {
      const created = await EmailDraft.create(doc);
      summary.generated++;
      summary.drafts.push(created);
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'E11000')) { summary.skipped++; bump('open_draft_exists'); }
      else throw err;
    }
  }

  return summary;
}

// ─── Read: pending drafts for the operator queue ──────────────────────────────
async function listPending(limit = 50, deps = {}) {
  const EmailDraft = deps.EmailDraft || require('../models/EmailDraft').EmailDraft;
  const docs = await EmailDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } })
    .sort({ created_at: -1 })
    .limit(limit)
    .lean();
  return docs.map(d => ({
    id:              d._id,
    order_id:        d.order_id,
    client_name:     d.client_name,
    to_email:        d.to_email,
    lab_name:        d.lab_name,
    draft_type:      d.draft_type,
    subject:         d.subject,
    body:            d.body,
    reason:          d.reason,
    evidence:        d.evidence || [],
    impact:          d.impact,
    confidence_band: d.confidence_band,
    state:           d.state,
    created_at:      d.created_at,
  }));
}

// ─── DB-backed: apply an operator decision (never sends) ──────────────────────
async function decide(draftId, decision, { decidedBy = 'operator', changeNote } = {}, deps = {}) {
  const EmailDraft = deps.EmailDraft || require('../models/EmailDraft').EmailDraft;

  const draft = await EmailDraft.findById(draftId);
  if (!draft) throw errorUtils.notFoundError('Email draft not found');

  const nextState = applyDecisionTransition(draft.state, decision);
  draft.state      = nextState;
  draft.decision   = decision;
  draft.decided_by = decidedBy;
  draft.decided_at = new Date();
  if (decision === 'request_changes') {
    draft.change_request_note = changeNote || '';
    draft.revision = (draft.revision || 1) + 1;
  }
  // NOTE: 'approved' does NOT send. Transmission is operator-performed.
  await draft.save();
  return draft;
}

module.exports = {
  // pure
  chooseTrigger,
  renderEmail,
  buildLabEmailDraft,
  dedupeKey,
  applyDecisionTransition,
  // db-backed
  generate,
  listPending,
  decide,
  // constants
  IMPACT,
  DEFAULT_LAYOUT_SLA_DAYS,
  DEFAULT_ORIGINAL_SLA_DAYS,
};
