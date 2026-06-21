'use strict';

// services/paymentRecognitionService.js — recognize PAYMENT evidence from inbound
// WhatsApp content (text + attachments). READ-ONLY and PURE at the core: it surfaces
// signals for operator review and to feed the New Order Proposal's payment signal — it
// NEVER records a payment, writes the Declaration, or decides anything on its own.
//
// Per Master KB V2: minimum payment is always ≥ 10 000 сом; large orders ≥ 60% of the
// total. Sufficiency is ASSESSED (with reasons) but the operator confirms.

const fileClassifier = require('./fileClassifierService');

const CURRENCY_RE = /(\d[\d\s.,]*\d|\d)\s*(сом(?:ов|а)?|руб(?:лей|\.)?|₽|тенге|тг|usd|\$|доллар[а-яё]*|евро|€)/i;
const PAYMENT_INTENT = [
  /оплат/i, /оплатил/i, /оплачен/i, /перев[её]л/i, /перечислил/i, /предоплат/i,
  /\bчек\b/i, /квитанц/i, /скинул[аи]?\s+деньги/i, /отправил[аи]?\s+(оплату|деньги|чек)/i, /внёс|внес/i,
];
const MIN_PAYMENT = 10000;       // KB V2: floor, always
const LARGE_ORDER_PERCENT = 0.6; // KB V2: large orders ≥ 60%

function parseAmount(raw) {
  const m = CURRENCY_RE.exec(String(raw || ''));
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/[\s.]/g, '').replace(',', '.'));
  return isNaN(amount) ? null : { amount, currency: m[2].toLowerCase(), raw: m[0].trim() };
}

// recognizeFromMessage({ body, attachments }) → PURE payment-evidence summary.
function recognizeFromMessage(msg = {}) {
  const body = String(msg.body || '');
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const evidence = [];

  // 1) Attachment that classifies as a payment receipt.
  const receipts = attachments
    .map(a => ({ a, c: fileClassifier.classifyAttachment(a) }))
    .filter(x => x.c.category === 'payment_receipt');
  for (const { a } of receipts) evidence.push({ kind: 'receipt_file', detail: `Вложение похоже на чек/квитанцию: ${a.file_name || '(без имени)'}`, ref: a.media_ref || a.file_name });

  // 2) Payment-intent phrase in the text.
  const intent = PAYMENT_INTENT.some(p => p.test(body));
  if (intent) evidence.push({ kind: 'text_mention', detail: `Текст указывает на оплату: "${body.slice(0, 120)}"` });

  // 3) Amount mention.
  const amt = parseAmount(body);
  if (amt) evidence.push({ kind: 'amount_mention', detail: `Сумма в сообщении: ${amt.raw}`, amount: amt.amount, currency: amt.currency });

  const has_payment_signal = evidence.length > 0;

  // Confidence: receipt file or (intent + amount) → MEDIUM; intent or amount alone → LOW.
  let confidence = 'LOW';
  if (receipts.length > 0 || (intent && amt)) confidence = 'MEDIUM';
  if (!has_payment_signal) confidence = 'NONE';

  return {
    has_payment_signal,
    amount: amt ? amt.amount : null,
    currency: amt ? amt.currency : null,
    has_receipt_file: receipts.length > 0,
    has_intent: intent,
    evidence,
    confidence,
    needs_operator_confirmation: true,   // never auto-records a payment
  };
}

// assessSufficiency(amount, total?) — apply the KB V2 minimum-payment rule. Returns a
// recommendation with reasons; the operator confirms (does not gate anything here).
function assessSufficiency(amount, total = null) {
  const reasons = [];
  if (amount == null) return { sufficient: null, reasons: ['Сумма не распознана'], needs_operator_confirmation: true };
  const meetsFloor = amount >= MIN_PAYMENT;
  if (!meetsFloor) reasons.push(`Меньше минимального платежа (${MIN_PAYMENT} сом)`);
  let meetsPercent = true;
  if (total != null && total > 0) {
    meetsPercent = amount >= LARGE_ORDER_PERCENT * total;
    if (!meetsPercent) reasons.push(`Меньше 60% от суммы заказа (${Math.round(LARGE_ORDER_PERCENT * total)} сом из ${total})`);
  }
  const sufficient = meetsFloor && meetsPercent;
  if (sufficient) reasons.push('Соответствует минимальным условиям оплаты');
  return { sufficient, floor: MIN_PAYMENT, percent_required: LARGE_ORDER_PERCENT, amount, total, reasons, needs_operator_confirmation: true };
}

// toDraftSignal(recognition) → the `signals.payment` shape consumed by
// draftPackageService.buildCreateDeclarationDraft (New Order Proposal). Null when no signal.
function toDraftSignal(recognition) {
  if (!recognition || !recognition.has_payment_signal) return null;
  const detail = recognition.has_receipt_file ? 'Получен чек/квитанция об оплате'
    : recognition.amount != null ? `Указана оплата ${recognition.amount} ${recognition.currency || ''}`.trim()
    : 'Клиент сообщает об оплате';
  return { detail, amount: recognition.amount, ref: 'whatsapp', confidence: recognition.confidence };
}

// DB wrapper: recognize over a stored WhatsAppMessage (read-only).
async function recognizeFromMessageId(messageId, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const msg = await WhatsAppMessage.findById(messageId).lean();
  if (!msg) return { has_payment_signal: false, reason: 'message_not_found' };
  return { message_id: String(msg._id), ...recognizeFromMessage(msg) };
}

module.exports = {
  MIN_PAYMENT, LARGE_ORDER_PERCENT,
  parseAmount, recognizeFromMessage, assessSufficiency, toDraftSignal, recognizeFromMessageId,
};
