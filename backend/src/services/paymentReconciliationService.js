'use strict';

// services/paymentReconciliationService.js — agreed-total vs paid → DEBT, as a gated proposal.
//
// The agent reads the conversation, figures out the AGREED total (what the operator quoted),
// how much the client actually paid (text + receipt), computes the unpaid DEBT arithmetically,
// and PROPOSES the numbers to the operator to confirm and record into «Декларация».
// NEVER writes the sheet, never decides — recommend-only (auto_write:false).
//
// reconcile()/analyzeConversation() are PURE; buildProposal() assembles the gated record.
// Audio (voice messages) is just another text source once transcribed — see analyzeConversation
// `messages[].body`; transcription itself is a separate capability (not yet wired).

const recognizer = require('./paymentRecognitionService');

// ─── Pure: arithmetic of debt ──────────────────────────────────────────────────
function reconcile({ agreed_total = null, total_paid = 0 } = {}) {
  const agreed = agreed_total != null ? Number(agreed_total) : null;
  const paid = Number(total_paid) || 0;
  const debt = agreed != null ? Math.max(0, agreed - paid) : null;
  const overpaid = agreed != null && paid > agreed ? paid - agreed : 0;

  let status;
  if (agreed == null) status = 'неизвестна сумма договорённости';
  else if (paid === 0) status = 'не оплачено';
  else if (paid >= agreed) status = overpaid > 0 ? 'переплата' : 'полностью оплачено';
  else status = 'частично оплачено';

  return {
    agreed_total: agreed, total_paid: paid, debt, overpaid,
    fully_paid: agreed != null && paid >= agreed,
    partially_paid: agreed != null && paid > 0 && paid < agreed,
    status,
  };
}

// ─── Pure: read the conversation → candidate agreed total + paid ────────────────
// messages: [{ direction:'in'|'out', body, attachments }]. Outbound (operator) amounts are
// candidate quotes; inbound (client) amounts/receipts are candidate payments. ADVISORY — the
// operator confirms which numbers are correct.
function analyzeConversation(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const quotes = [];          // operator-quoted amounts (out)
  const payments = [];        // client payments (in)
  let receipts = 0;

  for (const m of list) {
    const out = m.direction === 'out';
    const rec = recognizer.recognizeFromMessage(m);
    if (rec.amount != null) (out ? quotes : payments).push({ amount: rec.amount, currency: rec.currency, body: String(m.body || '').slice(0, 100) });
    if (!out && rec.has_receipt_file) receipts++;
  }

  // Agreed total = the LAST operator-quoted amount (most recent negotiation), advisory.
  const agreed_total = quotes.length ? quotes[quotes.length - 1].amount : null;
  const total_paid = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const r = reconcile({ agreed_total, total_paid });

  // Confidence: need at least one quote and one payment/receipt to be MEDIUM.
  const confidence = (quotes.length && (payments.length || receipts)) ? 'MEDIUM' : 'LOW';

  return {
    ...r,
    candidate_quotes: quotes,
    candidate_payments: payments,
    receipts,
    sufficiency: agreed_total != null ? recognizer.assessSufficiency(total_paid, agreed_total) : null,
    confidence,
    needs_operator_confirmation: true,
  };
}

// ─── Async: transcribe voice messages, then analyze (text + audio) ──────────────
// For each message with a voice note, transcribe it (OpenAI) and merge the text into body so
// agreed-total / payment amounts spoken in голосовые are also recognized. Falls back to text
// when transcription is unavailable (no key / not wired). deps.readAudio reads the media buffer.
async function analyzeConversationWithAudio(messages = [], deps = {}) {
  const transcriber = deps.transcriber || require('./audioTranscriptionService');
  const enriched = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    let body = m.body || '';
    try {
      const t = await transcriber.transcribeVoiceMessage(m, deps);
      if (t) body = `${body} ${t}`.trim();
    } catch (_) { /* transcription is best-effort */ }
    enriched.push({ ...m, body });
  }
  return analyzeConversation(enriched);
}

// ─── Gated proposal for the operator to confirm + record into «Декларация» ──────
function buildProposal({ phone, legal_entity, analysis } = {}) {
  const a = analysis || {};
  return {
    action: 'record_payment_and_debt',
    phone: phone || null,
    legal_entity: legal_entity || null,
    agreed_total: a.agreed_total ?? null,
    total_paid: a.total_paid ?? 0,
    debt: a.debt ?? null,
    payment_status: a.status,
    declaration_update: {
      amount: a.total_paid ?? 0,                 // → «Декларация» сумма оплаты (col G, write-confirm pending)
      debt_note: a.debt != null && a.debt > 0 ? `Долг: ${a.debt} сом` : 'Долг: нет',
    },
    evidence: { quotes: a.candidate_quotes || [], payments: a.candidate_payments || [], receipts: a.receipts || 0 },
    confidence: a.confidence || 'LOW',
    auto_write: false,                            // NEVER writes the sheet
    operator_approval_required: true,
  };
}

module.exports = { reconcile, analyzeConversation, analyzeConversationWithAudio, buildProposal };
