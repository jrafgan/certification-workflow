'use strict';

// services/operatorAssistantService.js — «Чат с агентом»: живой ИИ-помощник ОПЕРАТОРА.
//
// Read-only помощь оператору по РАБОТЕ (как оформить, что значит статус, что делать с
// задачей), grounded в одобренной Базе знаний + контексте выбранной задачи.
//
// ПРОВАЙДЕРО-НЕЗАВИСИМ (raw fetch — как visionOcrService/audioTranscriptionService):
//   • OpenAI    — если задан OPENAI_API_KEY (по умолчанию; ключ уже есть на VPS);
//   • Anthropic — если задан ANTHROPIC_API_KEY.
// Явный выбор: ASSISTANT_PROVIDER=openai|anthropic. Без ключей isConfigured()=false и
// вызывающий откатывается на canned-ответ.
//
// ЖЁСТКОЕ ПРАВИЛО (память panel-operator-assistant): это помощник ОПЕРАТОРА, а не агент.
// Он НИКОГДА ничего не меняет, не отправляет, не трогает код/поведение агента.

const OPENAI_ENDPOINT    = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION  = '2023-06-01';

function openaiKey()    { return process.env.OPENAI_API_KEY || null; }
function anthropicKey() { return process.env.ANTHROPIC_API_KEY || null; }

// Какой провайдер использовать. Явный ASSISTANT_PROVIDER > наличие OpenAI > наличие Anthropic.
function provider() {
  const p = String(process.env.ASSISTANT_PROVIDER || '').toLowerCase();
  if (p === 'openai' && openaiKey()) return 'openai';
  if (p === 'anthropic' && anthropicKey()) return 'anthropic';
  if (openaiKey()) return 'openai';
  if (anthropicKey()) return 'anthropic';
  return null;
}
function isConfigured() { return provider() !== null; }
function model() {
  return provider() === 'anthropic'
    ? (process.env.ANTHROPIC_MODEL || 'claude-opus-4-8')
    : (process.env.OPENAI_ASSISTANT_MODEL || 'gpt-4o');
}

const SYSTEM = [
  'Ты — ИИ-помощник ОПЕРАТОРА системы сертификации dokumenty.pro (панель управления).',
  'Твоя роль: помогать оператору РАЗОБРАТЬСЯ в работе — объяснять статусы, процессы,',
  'расчёты, что значит задача и что с ней делать. Отвечай по-русски, кратко и по делу.',
  '',
  'СТРОГИЕ ГРАНИЦЫ (нарушать нельзя):',
  '— Ты только ОБЪЯСНЯЕШЬ и ПОДСКАЗЫВАЕШЬ. Ты НЕ выполняешь действий: не меняешь Декларацию,',
  '  не отправляешь сообщения/письма, не меняешь статусы, не запускаешь документы.',
  '— Ты НЕ управляешь агентом и не меняешь его поведение/код. Ты помощник человека-оператора.',
  '— Отвечай, опираясь на приведённую Базу знаний и контекст задачи. Если данных нет или',
  '  не уверен — так и скажи и предложи уточнить у старшего оператора. Не выдумывай цены/сроки.',
  '— Почты и имена лабораторий/органов — ВНУТРЕННЕЕ; не советуй сообщать их клиенту.',
].join('\n');

function kbBlock(entries = []) {
  if (!entries.length) return '(База знаний пуста или недоступна.)';
  return entries.map(e => `- [${e.category}] ${String(e.text || '').replace(/\s+/g, ' ').trim()}`).join('\n');
}
function itemBlock(contextItem) {
  if (!contextItem) return '(Задача не выбрана — это общий вопрос по работе.)';
  const lines = [`Задача: ${contextItem.title || '(без названия)'}`];
  if (contextItem.reason) lines.push(`Обоснование: ${contextItem.reason}`);
  const ev = Array.isArray(contextItem.evidence) ? contextItem.evidence : [];
  if (ev.length) lines.push('Доказательства:\n' + ev.map(x => `  • ${x}`).join('\n'));
  return lines.join('\n');
}
function buildUserContent(question, contextItem, kbEntries) {
  return [
    '=== БАЗА ЗНАНИЙ (одобренная, источник истины) ===',
    kbBlock(kbEntries),
    '',
    '=== КОНТЕКСТ ЗАДАЧИ ===',
    itemBlock(contextItem),
    '',
    '=== ВОПРОС ОПЕРАТОРА ===',
    question,
  ].join('\n');
}

async function callOpenAI(userContent, doFetch) {
  const res = await doFetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model(),
      max_tokens: 1500,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) { let d = ''; try { d = JSON.stringify(await res.json()); } catch (_) {} return { ok: false, reason: 'api_error', status: res.status, detail: d }; }
  const json = await res.json();
  const text = String(json.choices?.[0]?.message?.content || '').trim();
  return { ok: true, answer: text || '(пустой ответ)', model: model(), provider: 'openai' };
}

async function callAnthropic(userContent, doFetch) {
  const res = await doFetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey(), 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model(),
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) { let d = ''; try { d = JSON.stringify(await res.json()); } catch (_) {} return { ok: false, reason: 'api_error', status: res.status, detail: d }; }
  const json = await res.json();
  if (json.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
  const text = (Array.isArray(json.content) ? json.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
  return { ok: true, answer: text || '(пустой ответ)', model: model(), provider: 'anthropic' };
}

// ask({ question, contextItem?, kbEntries? }, deps) → { ok, answer } | { ok:false, reason }
async function ask(input = {}, deps = {}) {
  const prov = provider();
  if (!prov) return { ok: false, reason: 'no_api_key', hint: 'Задайте OPENAI_API_KEY (или ANTHROPIC_API_KEY) в .env.' };

  const question = String(input.question || '').trim();
  if (!question) return { ok: false, reason: 'empty_question' };

  let kbEntries = input.kbEntries;
  if (!kbEntries) {
    const getKb = deps.getApprovedKnowledge || require('./knowledgeBaseService').getApprovedKnowledge;
    try { kbEntries = await getKb(); } catch (_) { kbEntries = []; }
  }

  const userContent = buildUserContent(question, input.contextItem, kbEntries);
  const doFetch = deps.fetch || globalThis.fetch;
  try {
    return prov === 'anthropic' ? await callAnthropic(userContent, doFetch) : await callOpenAI(userContent, doFetch);
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

module.exports = { isConfigured, provider, model, ask };
