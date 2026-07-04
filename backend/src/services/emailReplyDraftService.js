'use strict';

// services/emailReplyDraftService.js — ЧЕРНОВИК ответа на письмо (обычно лаборатории).
//
// По требованию (кнопка «Подготовить ответ» у неотвеченного письма): читает всю цепочку
// Gmail + одобренную Базу знаний и пишет черновик ответа на ПОСЛЕДНЕЕ письмо от лица
// оператора. OUTPUT-ONLY: ничего не отправляет — это заготовка, оператор правит и шлёт сам
// (email — канал только между нами и лабораторией; см. client-comms-channels).

const llm = require('./llmClient');

const MAX_MSGS = 10;   // сколько последних сообщений цепочки подавать модели
const MAX_BODY = 1200; // обрезка тела одного сообщения

const SYSTEM = [
  'Ты помогаешь ОПЕРАТОРУ сертификационной компании dokumenty.pro готовить ЧЕРНОВИК ответа',
  'на письмо (чаще всего — от лаборатории/органа по сертификации). Пиши по-русски, вежливо,',
  'деловым тоном, по существу — как оператор отвечает лаборатории.',
  '',
  'ПРАВИЛА:',
  '— Опирайся ТОЛЬКО на приведённую переписку и Базу знаний. Не выдумывай цены, сроки, номера.',
  '— Если для корректного ответа не хватает данных (какой документ, сколько ПИ, оплата и т.п.) —',
  '  напиши это как вопрос-уточнение в черновике или пометкой [нужно уточнить: …], а не выдумывай.',
  '— Это ЧЕРНОВИК для оператора. НЕ подписывайся вымышленным именем; заверши нейтрально.',
  '— Верни ТОЛЬКО текст письма-ответа, без пояснений и без темы.',
].join('\n');

function transcript(messages, gmail) {
  return messages.slice(-MAX_MSGS).map(m => {
    const h = (m.payload && m.payload.headers) || [];
    const from = gmail.extractHeader(h, 'From') || '';
    const body = String(gmail.getMessageBody(m) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY);
    return `[${from}]: ${body}`;
  }).join('\n\n');
}

// draftReply({ threadId }, deps) → { ok, subject, to, draft } | { ok:false, reason }
async function draftReply(input = {}, deps = {}) {
  if (!llm.isConfigured()) return { ok: false, reason: 'no_api_key', hint: 'Задайте OPENAI_API_KEY в .env.' };
  const gmail = deps.gmailClient || require('../integrations/gmailClient');
  const threadId = input.threadId;
  if (!threadId) return { ok: false, reason: 'no_thread_id' };

  let full;
  try { full = await gmail.getThread(threadId, 'full'); }
  catch (e) { return { ok: false, reason: 'thread_not_found', detail: e.message }; }

  const msgs = (Array.isArray(full.messages) ? full.messages.slice() : [])
    .sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
  if (!msgs.length) return { ok: false, reason: 'empty_thread' };

  const last = msgs[msgs.length - 1];
  const lastHeaders = (last.payload && last.payload.headers) || [];
  const subject = gmail.extractHeader(lastHeaders, 'Subject') || '(без темы)';
  const to = gmail.extractHeader(lastHeaders, 'From') || '';

  let kb = [];
  try { kb = await (deps.getApprovedKnowledge || require('./knowledgeBaseService').getApprovedKnowledge)(); }
  catch (_) { kb = []; }
  const kbBlock = kb.length
    ? kb.map(e => `- [${e.category}] ${String(e.text || '').replace(/\s+/g, ' ').trim()}`).join('\n')
    : '(База знаний недоступна.)';

  const user = [
    '=== БАЗА ЗНАНИЙ (одобренная, факты по ценам/срокам/правилам) ===',
    kbBlock,
    '',
    '=== ПЕРЕПИСКА (по возрастанию времени; последнее — то, на что отвечаем) ===',
    transcript(msgs, gmail),
    '',
    'Составь черновик ответа на ПОСЛЕДНЕЕ письмо. Только текст письма.',
  ].join('\n');

  const r = await llm.complete({ system: SYSTEM, user, maxTokens: 1000 }, deps);
  if (!r.ok) return r;

  return {
    ok: true,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    to,
    draft: r.text,
    provider: r.provider,
    model: r.model,
  };
}

module.exports = { draftReply };
