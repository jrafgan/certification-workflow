'use strict';

// services/leadConversionService.js — Lead Conversion Agent orchestration.
//
// Drives a social-media lead through the 8-state machine (no lead disappears silently):
//   new → educating → waiting_application → waiting_calculation → waiting_payment
//        → transferred_whatsapp ;  any active → dormant → recovered → (re-enter)
//
// HARD RULES:
//   • OUTPUT ONLY — never sends autonomously. Every outbound is a LeadMessageDraft the
//     operator releases (even spec-"auto_allowed" kinds; per the operator's V1 decision).
//   • Operator-gated kinds (calculation, payment, recovery, exact pricing) always wait.
//   • NOT responsible for lab comms, document approval, status management, final pricing,
//     or document edits — those stay in the main workflow.
//
// The state-machine + timing functions are PURE (no I/O) and exported for testing. DB-backed
// functions reuse existing engines: piCalculationService (calc), paymentRecognitionService
// (payment), newFormClient (application detection), and the platformAdapter (delivery).

const leadIntent = require('./leadIntentService');
const templates  = require('./leadReplyTemplates');
const pi          = require('./piCalculationService');
const payments    = require('./paymentRecognitionService');
const errorUtils  = require('../utils/errorUtils');
const { StubAdapter } = require('../integrations/platformAdapter');

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY  = 86_400_000;

// Stage 5 reminders (hours since the application link was sent) → then dormant.
const REMINDER_HOURS = [24, 72, 168]; // 24h, 72h, 7d
// Stage 11 recovery waves (days since dormant).
const RECOVERY_DAYS  = [30, 60, 90];

const IMPACT =
  'If released, this message is sent to the lead on their platform. Nothing is sent ' +
  'automatically — the operator releases it. No price/PI/payment/order is finalized here.';

// ─── Pure: state transitions ────────────────────────────────────────────────────
// nextState(current, trigger) → next state (or current if the trigger doesn't apply).
const TRIGGERS = {
  inquiry:              { from: ['new'],                                    to: 'educating' },
  app_link_sent:        { from: ['educating', 'recovered'],                 to: 'waiting_application' },
  application_detected: { from: ['waiting_application', 'recovered', 'educating'], to: 'waiting_calculation' },
  calculation_approved: { from: ['waiting_calculation'],                    to: 'waiting_payment' },
  payment_detected:     { from: ['waiting_payment'],                        to: 'transferred_whatsapp' },
  whatsapp_captured:    { from: ['waiting_payment', 'transferred_whatsapp'],to: 'transferred_whatsapp' },
  reminders_exhausted:  { from: ['waiting_application'],                    to: 'dormant' },
  recovery_reply:       { from: ['dormant'],                                to: 'recovered' },
};
function nextState(current, trigger) {
  const t = TRIGGERS[trigger];
  if (t && t.from.includes(current)) return t.to;
  return current;
}

// ─── Pure: Stage 5 follow-up schedule ──────────────────────────────────────────
// Returns { due:true, reminder_no } when the next reminder is due, { exhausted:true } when
// all reminders have passed (→ dormant), or { due:false } while still waiting.
function followUpDue(lead = {}, now = Date.now()) {
  const anchor = lead.application_link_at || lead.last_state_change_at;
  if (!anchor) return { due: false };
  const sent = lead.follow_up_count || 0;
  if (sent >= REMINDER_HOURS.length) {
    const elapsed = (now - new Date(anchor).getTime()) / MS_PER_HOUR;
    return elapsed >= REMINDER_HOURS[REMINDER_HOURS.length - 1] ? { exhausted: true } : { due: false };
  }
  const elapsedH = (now - new Date(anchor).getTime()) / MS_PER_HOUR;
  if (elapsedH >= REMINDER_HOURS[sent]) return { due: true, reminder_no: sent + 1 };
  return { due: false };
}

// ─── Pure: Stage 11 recovery schedule ──────────────────────────────────────────
function recoveryDue(lead = {}, now = Date.now()) {
  const anchor = lead.dormant_at;
  if (!anchor) return { due: false };
  const done = lead.recovery_count || 0;
  if (done >= RECOVERY_DAYS.length) return { due: false };
  const days = (now - new Date(anchor).getTime()) / MS_PER_DAY;
  if (days >= RECOVERY_DAYS[done]) return { due: true, wave: done + 1, day_marker: RECOVERY_DAYS[done] };
  return { due: false };
}

// ─── Pure: the next outbound the agent should propose for a lead (or null) ──────
// Returns { kind, auto_allowed, gated, reason } or a { transition } directive or null.
function nextAction(lead = {}, now = Date.now()) {
  switch (lead.state) {
    case 'new':
      return { kind: 'greeting', auto_allowed: true, gated: false, reason: 'New lead — establish contact (Stage 1).' };
    case 'educating':
      return { kind: 'application_link', auto_allowed: true, gated: false, reason: 'Educated — move to application (Stage 4).' };
    case 'waiting_application': {
      const f = followUpDue(lead, now);
      if (f.exhausted) return { transition: 'reminders_exhausted', reason: 'Reminders exhausted (Stage 5) → dormant.' };
      if (f.due) return { kind: 'reminder', auto_allowed: true, gated: false, reminder_no: f.reminder_no, reason: `Application not submitted — reminder #${f.reminder_no} (Stage 5).` };
      return null;
    }
    case 'waiting_calculation':
      return null; // calc proposal is operator-gated; generated on demand, not auto-pushed
    case 'waiting_payment':
      return { kind: 'payment_instructions', auto_allowed: false, gated: true, reason: 'Calculation approved — provide payment instructions (Stage 8, operator-gated).' };
    case 'dormant': {
      const r = recoveryDue(lead, now);
      if (r.due) return { kind: 'recovery', auto_allowed: false, gated: true, wave: r.wave, day_marker: r.day_marker, reason: `Dormant ${r.day_marker}d — recovery proposal (Stage 11, operator-gated).` };
      return null;
    }
    case 'recovered':
      return { kind: 'application_link', auto_allowed: true, gated: false, reason: 'Re-engaged — nudge back to application.' };
    case 'transferred_whatsapp':
    default:
      return null;
  }
}

// ─── DB helpers ─────────────────────────────────────────────────────────────────
function models(deps) {
  return {
    Lead:             deps.Lead             || require('../models/Lead').Lead,
    LeadMessageDraft: deps.LeadMessageDraft || require('../models/LeadMessageDraft').LeadMessageDraft,
  };
}

function dedupeKey(leadId, kind, windowTag = '') {
  return ['LEAD_MSG', String(leadId), kind, windowTag].filter(Boolean).join('|');
}

async function transition(lead, trigger, extra = {}) {
  const to = nextState(lead.state, trigger);
  if (to !== lead.state) {
    lead.history.push({ from: lead.state, to, note: trigger });
    lead.state = to;
    lead.last_state_change_at = new Date();
    if (to === 'dormant') lead.dormant_at = new Date();
  }
  Object.assign(lead, extra);
  await lead.save();
  return lead;
}

// Build + persist a draft proposal (idempotent per lead+kind+window). Never sends.
async function proposeDraft(lead, kind, ctx = {}, deps = {}) {
  const { LeadMessageDraft } = models(deps);
  const windowTag = kind === 'reminder' ? `r${ctx.reminder_no || ''}` : kind === 'recovery' ? `w${ctx.wave || ''}` : '';
  const dedupe_key = dedupeKey(lead._id, kind, windowTag);

  const open = await LeadMessageDraft.exists({ dedupe_key, state: { $in: ['pending_approval', 'changes_requested', 'approved'] } });
  if (open) return { skipped: true, reason: 'open_draft_exists' };

  const language = lead.language || 'ru';
  const text = templates.render(kind, { ...ctx, language, service_category: lead.service_category, lead });
  const doc = {
    lead_id:       lead._id,
    platform:      lead.platform,
    to_handle:     lead.handle,
    kind,
    auto_allowed:  templates.isAutoAllowed(kind),
    proposed_text: text,
    language,
    reason:        ctx.reason || `Proposed ${kind} for lead in state «${lead.state}».`,
    impact:        IMPACT,
    payload:       ctx.payload || null,
    dedupe_key,
    state:         'pending_approval',
  };
  try {
    const draft = await LeadMessageDraft.create(doc);
    return { created: true, draft };
  } catch (err) {
    if (err && (err.code === 11000 || err.code === 'E11000')) return { skipped: true, reason: 'open_draft_exists' };
    throw err;
  }
}

// ─── Stage 1–3: ingest an inbound inquiry ───────────────────────────────────────
// Upserts the lead, (re)classifies language/intent/service, advances new→educating (or
// dormant→recovered), and proposes greeting + education drafts. deps.adapter normalizes raw.
async function ingestInquiry(raw, deps = {}) {
  const { Lead } = models(deps);
  const adapter = deps.adapter || StubAdapter;
  const msg = adapter.receive(raw);
  if (!msg.platform || !msg.handle) throw errorUtils.validationError('platform and handle are required');

  const cls = leadIntent.classify(msg.text);

  let lead = await Lead.findOne({ platform: msg.platform, handle: msg.handle });
  const isNew = !lead;
  if (!lead) {
    lead = await Lead.create({
      platform: msg.platform, handle: msg.handle, display_name: msg.display_name || undefined,
      language: cls.language, intent: cls.intent, service_category: cls.service_category,
      state: 'new',
    });
  } else {
    lead.last_inbound_at = new Date();
    if (cls.language !== 'unknown') lead.language = cls.language;
    if (cls.intent !== 'unknown') lead.intent = cls.intent;
    if (cls.service_category !== 'unknown') lead.service_category = cls.service_category;
    // A reply from a dormant lead is a recovery signal.
    if (lead.state === 'dormant') await transition(lead, 'recovery_reply', { recovery_count: lead.recovery_count });
    else await lead.save();
  }

  const drafts = [];
  if (lead.state === 'new') {
    await transition(lead, 'inquiry');
    const g = await proposeDraft(lead, 'greeting', { reason: 'New lead — establish contact (Stage 1).' }, deps);
    if (g.draft) drafts.push(g.draft);
    const e = await proposeDraft(lead, 'education', {
      include_pi: /pi|пи|состав|композиц/i.test(msg.text), include_tnved: /тн\s*вэд|tnved|код/i.test(msg.text),
      reason: 'Reduce uncertainty — basic education (Stage 3).',
    }, deps);
    if (e.draft) drafts.push(e.draft);
  } else if (lead.state === 'recovered') {
    const a = await proposeDraft(lead, 'application_link', { reason: 'Recovered lead — back to application.' }, deps);
    if (a.draft) drafts.push(a.draft);
  }

  return { lead, classification: cls, is_new_lead: isNew, drafts };
}

// Run nextAction and materialize it (proposes a draft and/or applies a transition).
async function advance(leadId, deps = {}) {
  const { Lead } = models(deps);
  const lead = await Lead.findById(leadId);
  if (!lead) throw errorUtils.notFoundError('Lead not found');

  const action = nextAction(lead, deps.now || Date.now());
  if (!action) return { lead, action: null };
  if (action.transition) { await transition(lead, action.transition); return { lead, action }; }

  const ctx = { reason: action.reason };
  if (action.kind === 'reminder')  { ctx.reminder_no = action.reminder_no; }
  if (action.kind === 'recovery')  { ctx.wave = action.wave; }
  const res = await proposeDraft(lead, action.kind, ctx, deps);
  if (action.kind === 'reminder' && res.draft) { lead.follow_up_count = (lead.follow_up_count || 0) + 1; await lead.save(); }
  if (action.kind === 'recovery' && res.draft) { lead.recovery_count = (lead.recovery_count || 0) + 1; await lead.save(); }
  if (action.kind === 'application_link' && res.draft && !lead.application_link_at) { lead.application_link_at = new Date(); await transition(lead, 'app_link_sent'); }
  return { lead, action, draft: res.draft || null, skipped: res.skipped || false };
}

// ─── Stage 7: preliminary calculation (operator-gated) ──────────────────────────
async function generateCalculationProposal(leadId, calcInput = {}, deps = {}) {
  const { Lead } = models(deps);
  const lead = await Lead.findById(leadId);
  if (!lead) throw errorUtils.notFoundError('Lead not found');

  const calc = pi.computePi(calcInput); // throws on bad doc_type
  const res = await proposeDraft(lead, 'calculation_offer', {
    calc, payload: calc, reason: 'Preliminary calculation — operator approval required (Stage 7).',
  }, deps);
  if (lead.state === 'waiting_application' || lead.state === 'waiting_calculation') {
    await transition(lead, 'application_detected'); // ensure ≥ waiting_calculation
  }
  return { lead, calc, draft: res.draft || null, skipped: res.skipped || false };
}

// ─── Stage 9: payment detection (operator-gated review) ─────────────────────────
// Reuses paymentRecognitionService; returns the recognition (a Payment Review Package the
// operator confirms). Does NOT record a payment or change status.
function recognizePayment(message = {}) {
  return payments.recognizeFromMessage(message); // pure; needs_operator_confirmation:true
}

// ─── Operator decision on a message draft ───────────────────────────────────────
async function decideDraft(draftId, decision, { decidedBy = 'operator', changeNote } = {}, deps = {}) {
  const { LeadMessageDraft } = models(deps);
  const draft = await LeadMessageDraft.findById(draftId);
  if (!draft) throw errorUtils.notFoundError('Lead message draft not found');
  if (!['pending_approval', 'changes_requested'].includes(draft.state)) {
    throw errorUtils.conflictError(`Draft in state "${draft.state}" cannot be decided`);
  }
  if (decision === 'approve')          draft.state = 'approved';   // does NOT send
  else if (decision === 'reject')      draft.state = 'rejected';
  else if (decision === 'request_changes') { draft.state = 'changes_requested'; draft.change_request_note = changeNote || ''; draft.revision += 1; }
  else throw errorUtils.validationError(`Unknown decision "${decision}"`);
  draft.decision = decision; draft.decided_by = decidedBy; draft.decided_at = new Date();
  await draft.save();
  return draft;
}

// Release an APPROVED draft via the platform adapter (operator action). The stub adapter
// records intent but does not transmit (no live platform client in V1).
async function releaseDraft(draftId, deps = {}) {
  const { Lead, LeadMessageDraft } = models(deps);
  const adapter = deps.adapter || StubAdapter;
  const draft = await LeadMessageDraft.findById(draftId);
  if (!draft) throw errorUtils.notFoundError('Lead message draft not found');
  if (draft.state !== 'approved') throw errorUtils.conflictError(`Draft must be "approved" to release (is "${draft.state}")`);

  const result = await adapter.deliver(draft);
  if (!result.ok) return { ok: false, draft, result };
  draft.state = 'sent'; draft.released_at = new Date(); await draft.save();
  const lead = await Lead.findById(draft.lead_id);
  if (lead) { lead.last_outbound_at = new Date(); await lead.save(); }
  return { ok: true, draft, result };
}

// ─── Scans (Stage 5 / Stage 11) ─────────────────────────────────────────────────
async function scanFollowUps(deps = {}) {
  const { Lead } = models(deps);
  const now = deps.now || Date.now();
  const leads = await Lead.find({ state: 'waiting_application' }).limit(2000);
  const summary = { proposed: 0, dormant: 0, skipped: 0 };
  for (const lead of leads) {
    const r = await advance(lead._id, { ...deps, now });
    if (r.action?.transition === 'reminders_exhausted') summary.dormant++;
    else if (r.draft) summary.proposed++;
    else summary.skipped++;
  }
  return summary;
}

async function scanRecovery(deps = {}) {
  const { Lead } = models(deps);
  const now = deps.now || Date.now();
  const leads = await Lead.find({ state: 'dormant' }).limit(2000);
  const summary = { proposed: 0, skipped: 0 };
  for (const lead of leads) {
    const r = await advance(lead._id, { ...deps, now });
    if (r.draft) summary.proposed++; else summary.skipped++;
  }
  return summary;
}

// ─── Reads ───────────────────────────────────────────────────────────────────────
async function listLeads({ state, limit = 50 } = {}, deps = {}) {
  const { Lead } = models(deps);
  const q = state ? { state } : {};
  return Lead.find(q).sort({ last_state_change_at: -1 }).limit(limit).lean();
}
async function listPendingDrafts(limit = 50, deps = {}) {
  const { LeadMessageDraft } = models(deps);
  return LeadMessageDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } })
    .sort({ created_at: -1 }).limit(limit).lean();
}

module.exports = {
  // pure
  nextState, followUpDue, recoveryDue, nextAction, dedupeKey,
  // db-backed
  ingestInquiry, advance, generateCalculationProposal, recognizePayment,
  decideDraft, releaseDraft, scanFollowUps, scanRecovery, listLeads, listPendingDrafts,
  // constants
  REMINDER_HOURS, RECOVERY_DAYS, IMPACT, TRIGGERS,
};
