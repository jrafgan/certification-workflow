'use strict';

// services/firstContactService.js — First-Contact Verification Engine.
//
// Finds WhatsApp numbers that appear in a New Form application but have NEVER messaged us,
// and prepares a GATED proposal to verify them ("оставляли ли вы заявку?"). The agent NEVER
// sends on its own: the operator approves, and the send goes out as a Meta-approved TEMPLATE
// (WhatsApp rejects free text to a number outside the 24h window — see the runbook).
//
// HARD RULE — OUTPUT ONLY. The scan reads inputs (New Form apps + inbound WhatsApp history)
// and writes ONLY the first_contact_proposals store. Idempotent: one proposal per number
// (unique phone_key). 'approve' authorizes + performs the template send (operator-triggered).
//
// The build/normalize helpers are PURE (no I/O) and exported for testing.

const { matchKey, normalizeLocal } = require('../utils/phoneUtils');

const IMPACT =
  'Если одобрить — клиенту уйдёт ОДНО проверочное сообщение по утверждённому шаблону WhatsApp ' +
  '(«оставляли ли вы заявку?»). Ничего не отправляется автоматически; статус заказа не меняется. ' +
  'WhatsApp — единственный клиентский канал.';

function templateName() { return process.env.FIRST_CONTACT_TEMPLATE_NAME || 'first_contact_check'; }
function templateLang() { return process.env.FIRST_CONTACT_TEMPLATE_LANG || 'ru'; }

// ─── Pure: build a proposal doc from an application + its canonical key ────────
function buildProposal(app = {}, key) {
  return {
    application_ref: `application_row:${app.row ?? 'na'}`,
    client_name:     app.legal_entity || null,
    to_phone:        normalizeLocal(app.phone),
    phone_key:       key,
    template_name:   templateName(),
    template_lang:   templateLang(),
    reason:          `В новой заявке указан номер ${normalizeLocal(app.phone)}, с которого нам ни разу не писали — стоит уточнить, оставляли ли они заявку.`,
    evidence: [
      { kind: 'application', ref: `application_row:${app.row ?? 'na'}`, detail: `Заявка${app.legal_entity ? ` от «${app.legal_entity}»` : ''} с номером ${normalizeLocal(app.phone)}.` },
      { kind: 'no_inbound',  ref: key, detail: 'Входящих сообщений WhatsApp с этого номера нет.' },
    ],
    impact: IMPACT,
    state:  'pending_approval',
  };
}

// ─── DB-backed: scan New Form applications for unknown numbers ─────────────────
// Reads inputs (read-only) and writes only the first_contact_proposals store. Idempotent
// via the unique phone_key index. Never sends. deps:
//   { applicationsReader?, WhatsAppMessage?, FirstContactProposal? }.
async function scanUnknownApplicants(deps = {}) {
  const applicationsReader = deps.applicationsReader || require('../integrations/newFormClient');
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const { FirstContactProposal } = deps.FirstContactProposal ? deps : require('../models/FirstContactProposal');

  const { applications = [] } = await applicationsReader.readApplications();

  const summary = { generated: 0, skipped: 0, proposals: [], reasons: {} };
  const bump = (k) => { summary.reasons[k] = (summary.reasons[k] || 0) + 1; };
  const seenThisScan = new Set();

  for (const app of applications) {
    const key = matchKey(app.phone);
    // Empty/short phone — flag, never silently assume (память empty-fields-always-question).
    if (!key) { summary.skipped++; bump('no_phone'); continue; }
    if (seenThisScan.has(key)) { summary.skipped++; bump('duplicate_in_form'); continue; }
    seenThisScan.add(key);

    // Known contact — they have already written us → not a cold number.
    const hasInbound = await WhatsAppMessage.exists({ direction: 'inbound', phone_key: key });
    if (hasInbound) { summary.skipped++; bump('already_known'); continue; }

    // Already proposed (any state) — idempotent.
    const existing = await FirstContactProposal.exists({ phone_key: key });
    if (existing) { summary.skipped++; bump('proposal_exists'); continue; }

    try {
      const created = await FirstContactProposal.create(buildProposal(app, key));
      summary.generated++;
      summary.proposals.push(created);
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'E11000')) { summary.skipped++; bump('proposal_exists'); }
      else throw err;
    }
  }

  return summary;
}

// ─── Chat-interest: propose a gated first-contact DM for someone who showed interest ──
// Called from the WhatsApp (GOWA) webhook when interestDetectionService flags a message
// (direct or group). Idempotent per number; SKIPS people we're already talking to (recent
// inbound) so we never "cold-contact" an active client. Output-only: creates a pending
// proposal the operator approves; the send (cold DM) still passes the anti-ban gate.
async function proposeFromChatInterest({ phone, name, context, detection } = {}, deps = {}) {
  const { FirstContactProposal } = deps.FirstContactProposal ? deps : require('../models/FirstContactProposal');
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const key = matchKey(phone);
  if (!key) return { skipped: 'no_phone' };

  // Already proposed (any state) → idempotent.
  if (await FirstContactProposal.exists({ phone_key: key })) return { skipped: 'proposal_exists' };
  // Already a direct conversation with us → not a cold lead, skip.
  if (await WhatsAppMessage.exists({ direction: 'inbound', phone_key: key, conversation_ref: { $not: /@g\.us$/ } })) {
    return { skipped: 'already_in_contact' };
  }

  const cat = detection && detection.category && detection.category !== 'unknown' ? detection.category : 'оформление документов';
  const proposed_text =
    `Здравствуйте! Вы интересовались темой «${cat}». Мы как раз этим занимаемся — Dokumenty.pro ` +
    `(сертификаты, декларации соответствия, отказные письма для маркетплейсов). Подскажу, какой ` +
    `документ нужен для вашего товара и сколько это стоит — пишите.`;

  const doc = {
    source:       'chat_interest',
    context:      context || null,
    to_phone:     normalizeLocal(phone),
    phone_key:    key,
    display_name: name || null,
    proposed_text,
    reason:       `Человек${name ? ` (${name})` : ''} проявил интерес к «${cat}»${context ? ` в «${context}»` : ''}. Можно написать в личку.`,
    evidence: [
      { kind: 'chat_interest', ref: key, detail: (detection && detection.reason) || 'Сообщение про сертификаты/декларации.' },
      { kind: 'no_contact',    ref: key, detail: 'Прямого диалога с нами ещё не было.' },
    ],
    impact: 'Если одобрить — оператор отправит ОДНО сообщение в личку через анти-бан гейт (холодные DM лимитированы). Агент сам не пишет.',
    state:  'pending_approval',
  };
  try {
    const created = await FirstContactProposal.create(doc);
    return { generated: true, proposal: created };
  } catch (err) {
    if (err && (err.code === 11000 || err.code === 'E11000')) return { skipped: 'proposal_exists' };
    throw err;
  }
}

// ─── Read: pending proposals for the operator queue ───────────────────────────
async function listPending(limit = 100, deps = {}) {
  const { FirstContactProposal } = deps.FirstContactProposal ? deps : require('../models/FirstContactProposal');
  const docs = await FirstContactProposal.find({ state: { $in: ['pending_approval', 'approved'] } })
    .sort({ created_at: -1 })
    .limit(limit)
    .lean();
  return docs.map(d => ({
    id:           d._id,
    source:       d.source || 'new_form_application',
    context:      d.context || null,
    application_ref: d.application_ref,
    client_name:  d.client_name || d.display_name || null,
    to_phone:     d.to_phone,
    template_name: d.template_name,
    proposed_text: d.proposed_text || null,
    reason:       d.reason,
    evidence:     (d.evidence || []).map(e => e.detail),
    impact:       d.impact,
    state:        d.state,
    send_result:  d.send_result || null,
  }));
}

// ─── Decide: approve (send) | reject ──────────────────────────────────────────
// approve → for a chat_interest proposal (proposed_text set) send the free-text DM via the
// active channel through the anti-ban gate (outboundWhatsappService); otherwise send the
// Meta template. On success state→'sent'; on failure stays 'approved' with the error.
// reject → state→'rejected'. deps: { FirstContactProposal?, cloud?, outbound? }.
async function decide(id, decision, deps = {}) {
  const { FirstContactProposal } = deps.FirstContactProposal ? deps : require('../models/FirstContactProposal');
  const cloud = deps.cloud || require('./whatsappCloudService');
  const outbound = deps.outbound || require('./outboundWhatsappService');

  const proposal = await FirstContactProposal.findById(id);
  if (!proposal) { const e = new Error('proposal not found'); e.status = 404; throw e; }
  if (proposal.state === 'sent' || proposal.state === 'rejected') {
    return proposal; // terminal — no-op
  }

  proposal.decision   = decision === 'approve' ? 'approve' : 'reject';
  proposal.decided_by = (deps.decidedBy || null);
  proposal.decided_at = new Date();

  if (decision === 'reject') {
    proposal.state = 'rejected';
    await proposal.save();
    return proposal;
  }

  // approve → send (operator-triggered). Chat-interest = free-text DM via the gated channel;
  // new-form applicant = Meta template.
  proposal.state = 'approved';
  const result = proposal.proposed_text
    ? await outbound.send(proposal.to_phone, proposal.proposed_text)
    : await cloud.sendTemplate(proposal.to_phone, proposal.template_name, proposal.template_lang);
  proposal.send_result = result;
  if (result && result.ok) {
    proposal.state = 'sent';
    proposal.sent_at = new Date();
  }
  await proposal.save();
  return proposal;
}

module.exports = { buildProposal, scanUnknownApplicants, proposeFromChatInterest, listPending, decide, templateName, templateLang };
