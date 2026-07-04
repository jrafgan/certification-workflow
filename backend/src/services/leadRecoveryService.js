'use strict';

// services/leadRecoveryService.js — Lead Recovery Engine.
//
// Finds leads that have stalled on the CLIENT side and proposes a re-engagement message
// for operator review. A lead is an Order awaiting a client action (layout approval,
// payment/info) that has gone idle, or an intake application that never progressed.
//
// HARD RULE — OUTPUT ONLY. Clients are reached on WhatsApp ONLY (never email). The engine
// NEVER sends, never changes order status, and never marks anything read. It reads inputs
// and writes only its OWN proposal store (lead_recoveries). 'approve' authorizes the text;
// the send is operator-performed.
//
// The assess/build functions are PURE (no I/O) and exported for testing. The DB-backed
// scan/decide functions mirror the other engines.

const errorUtils = require('../utils/errorUtils');
const { normalizeLocal, matchKey } = require('../utils/phoneUtils');

const MS_PER_DAY = 86_400_000;

// Idle thresholds (days) before a client-side stall is worth recovering, and severity steps.
const IDLE_MIN_DAYS  = parseInt(process.env.LEAD_RECOVERY_IDLE_MIN_DAYS, 10) || 3;
const IDLE_MED_DAYS  = 7;
const IDLE_HIGH_DAYS = 14;

const IMPACT =
  'If approved, the operator sends this WhatsApp follow-up to the client. Nothing is sent ' +
  'automatically; no order status changes and no chat is marked read. WhatsApp is the only ' +
  'client channel.';

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function daysSince(date, now = Date.now()) {
  if (!date) return null;
  return Math.floor((now - new Date(date).getTime()) / MS_PER_DAY);
}

function severityFor(daysIdle, deadlinePassed) {
  let sev = 'LOW';
  if (daysIdle >= IDLE_HIGH_DAYS) sev = 'HIGH';
  else if (daysIdle >= IDLE_MED_DAYS) sev = 'MEDIUM';
  if (deadlinePassed && sev === 'LOW') sev = 'MEDIUM';   // a missed deadline always bumps
  return sev;
}

// Map an order status to a client-side recovery stage (or null if the stall isn't client-side).
const STATUS_STAGE = {
  'На согласовании': 'awaiting_client_approval',
  'Запустить':       'awaiting_payment',
};

// ─── Pure: normalize an Order into a lead candidate ───────────────────────────
// Picks the client-side idle anchor relevant to the order's stage.
function leadFromOrder(order = {}) {
  const stage = STATUS_STAGE[order.status];
  if (!stage) return null;

  const layout = Array.isArray(order.layouts) && order.layouts.length
    ? order.layouts[order.layouts.length - 1]
    : null;

  // Anchor = the last time the ball was in the client's court.
  const anchor = stage === 'awaiting_client_approval'
    ? (layout?.sent_to_client_at || order.updated_at || order.created_at)
    : (order.updated_at || order.created_at);

  return {
    source:               'order',
    ref:                  order.sheet_row_id ? `order_row:${order.sheet_row_id}` : `order:${order._id}`,
    order_id:             order._id,
    status:               order.status,
    stage,
    client_name:          order.client?.companyName || order.client?.name || null,
    phone:                order.client?.phone || null,
    anchor_at:            anchor,
    client_response_due:  order.deadlines?.client_response_due || null,
    already_decided:      stage === 'awaiting_client_approval' ? !!(layout && layout.client_decision) : false,
  };
}

// ─── Pure: normalize an intake application into a lead candidate ───────────────
function leadFromApplication(app = {}) {
  return {
    source:      'application',
    ref:         `application_row:${app.row ?? 'na'}`,
    status:      'application',
    stage:       'stale_application',
    client_name: app.legal_entity || null,
    phone:       app.phone || null,
    anchor_at:   app.submitted_at || null,
    client_response_due: null,
    already_decided: false,
  };
}

// ─── Pure: assess a normalized lead → recovery assessment or null ─────────────
function assessLead(lead = {}, now = Date.now()) {
  if (!lead || !lead.stage) return null;
  if (lead.already_decided) return null;                 // client already responded
  if (!matchKey(lead.phone)) return null;                // no WhatsApp channel → can't recover

  const daysIdle = daysSince(lead.anchor_at, now);
  const deadlinePassed = !!(lead.client_response_due && now > new Date(lead.client_response_due).getTime());

  // Not stalled yet (and no missed deadline) → nothing to recover.
  if ((daysIdle == null || daysIdle < IDLE_MIN_DAYS) && !deadlinePassed) return null;

  const idle = daysIdle ?? IDLE_MIN_DAYS;
  const severity = severityFor(idle, deadlinePassed);

  const evidence = [];
  if (lead.source === 'order') {
    evidence.push({ kind: 'order_status', ref: lead.ref, detail: `Статус «${lead.status}» — ожидается действие клиента.` });
  } else {
    evidence.push({ kind: 'application', ref: lead.ref, detail: 'Заявка не перешла в заказ.' });
  }
  evidence.push({ kind: 'idle', ref: lead.ref, detail: `Без активности клиента ${idle} дн.` });
  if (deadlinePassed) evidence.push({ kind: 'deadline_passed', ref: lead.ref, detail: 'Срок ответа клиента истёк.' });

  return {
    stage:           lead.stage,
    severity,
    days_idle:       idle,
    deadline_passed: deadlinePassed,
    evidence,
    confidence_band: severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
    reason:          `Лид остановился на этапе «${lead.stage}»: ${idle} дн. без ответа клиента${deadlinePassed ? ', срок истёк' : ''}.`,
  };
}

// ─── Pure: the RU WhatsApp follow-up text for a stage ─────────────────────────
function recoveryMessage(stage, clientName) {
  const who = clientName ? `${clientName}, здравствуйте!` : 'Здравствуйте!';
  switch (stage) {
    case 'awaiting_client_approval':
      return `${who} Напоминаем: мы направляли макет на согласование. Подскажите, всё ли устраивает или нужны правки?`;
    case 'awaiting_payment':
      return `${who} По вашей заявке всё готово к запуску. Подскажите, удобно ли провести оплату, чтобы мы начали оформление?`;
    case 'stale_application':
      return `${who} Вы оставляли заявку на оформление документов. Подскажите, актуально ли ещё — будем рады помочь.`;
    default:
      return `${who} Подскажите, актуальна ли ваша заявка?`;
  }
}

// ─── Pure: build a recovery proposal from a lead + assessment ─────────────────
function buildRecoveryProposal(lead = {}, assessment = assessLead(lead)) {
  if (!assessment) return { generated: false, reason: 'not_stalled' };

  return {
    generated:       true,
    source:          lead.source,
    order_id:        lead.order_id || null,
    application_ref: lead.source === 'application' ? lead.ref : null,
    client_name:     lead.client_name,
    to_phone:        normalizeLocal(lead.phone),
    channel:         'whatsapp',
    lead_stage:      assessment.stage,
    severity:        assessment.severity,
    days_idle:       assessment.days_idle,
    proposed_text:   recoveryMessage(assessment.stage, lead.client_name),
    reason:          assessment.reason,
    evidence:        assessment.evidence,
    impact:          IMPACT,
    confidence_band: assessment.confidence_band,
  };
}

// ─── Pure: idempotency key (one open recovery per lead + stage) ────────────────
function dedupeKey(lead = {}, stage) {
  return ['RECOVER_LEAD', lead.ref || 'na', stage].join('|');
}

// ─── DB-backed: scan orders (+ optional applications) for stalled leads ───────
// Reads inputs (read-only) and writes only the lead_recoveries store. Idempotent via
// dedupe_key (skips when an OPEN recovery for the same lead+stage already exists). Never
// sends. deps: { Order, LeadRecovery, applicationsReader?, now? }.
async function scan(deps = {}) {
  const Order        = deps.Order        || require('../models/Order').Order;
  const LeadRecovery = deps.LeadRecovery || require('../models/LeadRecovery').LeadRecovery;
  const now = deps.now || Date.now();

  const candidates = [];

  const orders = await Order.find({ status: { $in: Object.keys(STATUS_STAGE) } })
    .select('status sheet_row_id client deadlines layouts created_at updated_at')
    .limit(2000)
    .lean();
  for (const o of orders) {
    const lead = leadFromOrder(o);
    if (lead) candidates.push(lead);
  }

  if (deps.applicationsReader) {
    const { applications = [] } = await deps.applicationsReader.readApplications();
    // Заявки Новой формы часто БЕЗ даты подачи (у формы нет колонки времени —
    // real-applications-source). Тогда «клиент пропал» меряем от ПОСЛЕДНЕЙ активности в
    // WhatsApp (deps.lastActivityByPhone: phone_key → ms). Клиент написал/мы посчитали →
    // тишина N дней = зависший лид, которому пора напомнить.
    const lastAct = deps.lastActivityByPhone || {};
    for (const a of applications) {
      const lead = leadFromApplication(a);
      if (!lead.anchor_at) {
        const k = matchKey(lead.phone);
        if (k && lastAct[k]) lead.anchor_at = new Date(lastAct[k]).toISOString();
      }
      candidates.push(lead);
    }
  }

  const summary = { generated: 0, skipped: 0, recoveries: [], reasons: {} };
  const bump = (k) => { summary.reasons[k] = (summary.reasons[k] || 0) + 1; };

  for (const lead of candidates) {
    const assessment = assessLead(lead, now);
    if (!assessment) { summary.skipped++; bump('not_stalled'); continue; }

    const proposal = buildRecoveryProposal(lead, assessment);
    if (!proposal.generated) { summary.skipped++; bump(proposal.reason); continue; }

    const dedupe_key = dedupeKey(lead, assessment.stage);
    const open = await LeadRecovery.exists({ dedupe_key, state: { $in: ['pending', 'changes_requested', 'approved'] } });
    if (open) { summary.skipped++; bump('open_recovery_exists'); continue; }

    const doc = {
      source:          proposal.source,
      order_id:        proposal.order_id || undefined,
      application_ref: proposal.application_ref || undefined,
      client_name:     proposal.client_name || undefined,
      to_phone:        proposal.to_phone || undefined,
      channel:         'whatsapp',
      lead_stage:      proposal.lead_stage,
      severity:        proposal.severity,
      days_idle:       proposal.days_idle,
      proposed_text:   proposal.proposed_text,
      reason:          proposal.reason,
      evidence:        proposal.evidence,
      impact:          proposal.impact,
      confidence_band: proposal.confidence_band,
      dedupe_key,
      state:           'pending',
    };

    try {
      const created = await LeadRecovery.create(doc);
      summary.generated++;
      summary.recoveries.push(created);
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'E11000')) { summary.skipped++; bump('open_recovery_exists'); }
      else throw err;
    }
  }

  return summary;
}

// ─── Read: pending recoveries for the operator queue (most severe first) ──────
async function listPending(limit = 50, deps = {}) {
  const LeadRecovery = deps.LeadRecovery || require('../models/LeadRecovery').LeadRecovery;
  const SEV = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const docs = await LeadRecovery.find({ state: { $in: ['pending', 'changes_requested'] } })
    .limit(limit)
    .lean();
  return docs
    .map(d => ({
      id:              d._id,
      source:          d.source,
      order_id:        d.order_id,
      application_ref: d.application_ref,
      client_name:     d.client_name,
      to_phone:        d.to_phone,
      channel:         d.channel,
      lead_stage:      d.lead_stage,
      severity:        d.severity,
      days_idle:       d.days_idle,
      proposed_text:   d.proposed_text,
      reason:          d.reason,
      evidence:        d.evidence || [],
      impact:          d.impact,
      confidence_band: d.confidence_band,
      state:           d.state,
      created_at:      d.created_at,
    }))
    .sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || (new Date(b.created_at) - new Date(a.created_at)));
}

// ─── Pure: legal decision transitions ─────────────────────────────────────────
function applyDecisionTransition(currentState, decision) {
  const DECIDABLE = ['pending', 'changes_requested'];
  if (!DECIDABLE.includes(currentState)) {
    throw errorUtils.conflictError(`Recovery in state "${currentState}" cannot be decided`);
  }
  switch (decision) {
    case 'approve':         return 'approved';   // does NOT send
    case 'reject':          return 'rejected';
    case 'request_changes': return 'changes_requested';
    default:
      throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject|request_changes)`);
  }
}

// ─── DB-backed: apply an operator decision (never sends) ──────────────────────
async function decide(recoveryId, decision, { decidedBy = 'operator', changeNote } = {}, deps = {}) {
  const LeadRecovery = deps.LeadRecovery || require('../models/LeadRecovery').LeadRecovery;

  const rec = await LeadRecovery.findById(recoveryId);
  if (!rec) throw errorUtils.notFoundError('Lead recovery not found');

  const nextState = applyDecisionTransition(rec.state, decision);
  rec.state      = nextState;
  rec.decision   = decision;
  rec.decided_by = decidedBy;
  rec.decided_at = new Date();
  if (decision === 'request_changes') {
    rec.change_request_note = changeNote || '';
    rec.revision = (rec.revision || 1) + 1;
  }
  await rec.save();
  return rec;
}

module.exports = {
  // pure
  leadFromOrder,
  leadFromApplication,
  assessLead,
  severityFor,
  recoveryMessage,
  buildRecoveryProposal,
  dedupeKey,
  applyDecisionTransition,
  // db-backed
  scan,
  listPending,
  decide,
  // constants
  IMPACT,
  IDLE_MIN_DAYS,
  STATUS_STAGE,
};
