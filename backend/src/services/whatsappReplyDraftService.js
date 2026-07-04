'use strict';

// services/whatsappReplyDraftService.js — ЧЕРНОВИК ответа КЛИЕНТУ в WhatsApp.
//
// Агент знает таблицу «Декларация» (статус/этап заказа, оплата/долг — через
// clientEntityService) И историю переписки WhatsApp, и предлагает ОПЕРАТОРУ готовый черновик
// ответа клиенту. OUTPUT-ONLY: не отправляет — оператор правит и шлёт (recommendation mode).
//
// Контекст берётся из taskInboxService.thread(phone): { messages (история WA), entity,
// payment{debt}, origin, next_step{status,actor_ru} }. Плюс одобренная База знаний.

const llm = require('./llmClient');

const SYSTEM = [
  'Ты помогаешь ОПЕРАТОРУ сертификационной компании dokumenty.pro подготовить ЧЕРНОВИК ответа',
  'КЛИЕНТУ в WhatsApp. Пиши по-русски, дружелюбно и по делу, коротко.',
  '',
  'УЧИТЫВАЙ:',
  '— Статус/этап заказа из «Декларации» и историю переписки (они даны ниже). Отвечай в контексте',
  '  того, на каком шаге клиент и что от него нужно дальше.',
  '',
  'ПРАВИЛА (нарушать нельзя):',
  '— НЕ называй клиенту точную итоговую цену без подтверждения оператора — только «от …» из БЗ;',
  '  окончательную сумму подтверждает специалист.',
  '— НЕ сообщай клиенту внутренние почты/имена лабораторий и органов — это внутреннее.',
  '— Если есть долг — вежливо напомни про доплату остатка.',
  '— Не выдумывай факты (цены, сроки, статусы) — бери из БЗ и контекста. Если данных не хватает —',
  '  задай клиенту уточняющий вопрос.',
  '— Верни ТОЛЬКО текст сообщения клиенту, без пояснений.',
].join('\n');

function transcript(messages = []) {
  return messages.map(m => {
    const who = m.direction === 'outbound' ? 'Мы' : 'Клиент';
    const t = m.at ? new Date(m.at).toLocaleDateString('ru-RU') : '';
    return `${who}${t ? ' (' + t + ')' : ''}: ${m.body || ''}`;
  }).join('\n');
}

function clientName(ent) {
  if (!ent) return '';
  return ent.legal_entity || (Array.isArray(ent.orders) && ent.orders[0] && ent.orders[0].client) || '';
}

// draftReply({ phone }, deps) → { ok, draft, context } | { ok:false, reason }
async function draftReply(input = {}, deps = {}) {
  if (!llm.isConfigured()) return { ok: false, reason: 'no_api_key', hint: 'Задайте OPENAI_API_KEY в .env.' };
  const phone = input.phone;
  if (!phone) return { ok: false, reason: 'no_phone' };

  const taskInbox = deps.taskInboxService || require('./taskInboxService');
  let ctx;
  try { ctx = await taskInbox.thread(phone); }
  catch (e) { return { ok: false, reason: 'context_failed', detail: e.message }; }
  if (!ctx || (!ctx.messages || !ctx.messages.length)) return { ok: false, reason: 'no_history' };

  const ent = ctx.entity || null;
  const status = ctx.next_step && ctx.next_step.status;
  const actor = ctx.next_step && ctx.next_step.actor_ru;
  const debt = ctx.payment && ctx.payment.debt;
  const name = clientName(ent);

  let kb = [];
  try { kb = await (deps.getApprovedKnowledge || require('./knowledgeBaseService').getApprovedKnowledge)(); }
  catch (_) { kb = []; }
  const kbBlock = kb.length
    ? kb.map(e => `- [${e.category}] ${String(e.text || '').replace(/\s+/g, ' ').trim()}`).join('\n')
    : '(База знаний недоступна.)';

  const orderCtx = [
    `Клиент: ${name || '(имя неизвестно)'}`,
    `Источник/этап: ${ctx.origin || '—'}`,
    status ? `Статус заказа (Декларация): ${status}${actor ? ' · дальше действует: ' + actor : ''}` : 'Статус заказа: не определён',
    (debt && debt > 0) ? `Долг по оплате: ${debt} сом` : 'Долг: нет / неизвестно',
  ].join('\n');

  const user = [
    '=== БАЗА ЗНАНИЙ (факты по ценам/срокам/правилам) ===',
    kbBlock,
    '',
    '=== КОНТЕКСТ ЗАКАЗА (из таблицы «Декларация») ===',
    orderCtx,
    '',
    '=== ИСТОРИЯ ПЕРЕПИСКИ WhatsApp (по возрастанию времени) ===',
    transcript(ctx.messages),
    '',
    'Составь черновик ответа КЛИЕНТУ на последнее сообщение, с учётом статуса заказа и истории. Только текст сообщения.',
  ].join('\n');

  const r = await llm.complete({ system: SYSTEM, user, maxTokens: 900 }, deps);
  if (!r.ok) return r;

  return {
    ok: true,
    draft: r.text,
    context: { client: name, status: status || null, debt: (debt && debt > 0) ? debt : 0, origin: ctx.origin || null },
    provider: r.provider,
    model: r.model,
  };
}

module.exports = { draftReply };
