'use strict';

// services/messageIntentService.js — классификация РЕШЕНИЯ клиента по сообщению:
//   refuse   — отказался делать документ («передумали», «нашли другую», «наверное не будем»)
//   proceed  — согласен запускать / платить («запускаем», «оплачу», «давайте»)
//   postpone — отложил, но не отказ («пока отложим», «подумаю», «после выходных») → ждём решения
//   unclear  — по тексту не понять
//
// ЛОГИКА: сначала быстрые русские/киргизские регулярки (бесплатно, мгновенно). LLM (llmClient,
// по умолчанию OpenAI) вызывается ТОЧЕЧНО — только когда регулярки дали `unclear` И ключ задан.
// Результат кэшируется в памяти по хэшу текста (TTL), чтобы не гонять LLM повторно на одном
// и том же сообщении при каждом рендере инбокса.
//
// OUTPUT-ONLY сигнал: ничего не меняет, не шлёт, не пишет в БД. Порядок проверки регулярок:
// postpone → refuse → proceed (чтобы «пока отложим» не спутать с отказом, а «не будем» с «будем»).

const crypto = require('crypto');
const defaultLlm = require('./llmClient');

// «Пока отложим», «подумаю», «попозже» — НЕ отказ, ждём решения клиента.
const POSTPONE_RE = /пока\s+(отлож|не|подума)|отлож(им|у|ить)|попозж|поздн(ее|ей)|не\s+сейчас|надо\s+подума|подума(ю|ем|ть)|перезвон|на\s+след(ующей)?\s+недел|после\s+(выходн|праздник|обеда)|ещ[её]\s+(думаю|не\s+реш)|дай(те)?\s+подума/i;

// Явный отказ (расширяет taskInboxService.REFUSED_RE смысловыми оборотами).
const REFUSE_RE = /переду?мал|отказ(ыва|ыва[ю]сь|ался|аться|ное(?!\s*письмо))|не\s+буд[уе]м?(\s+(делать|оформл|запуск|сотруднич))?(?![а-яё])|не\s+актуальн|в\s+другом\s+месте|(нашл[иа]|сдела[лн][иа]?|оформил[иа]?|заказал[иа]?)\s+(в\s+)?друг|уже\s+(сделал|оформил|получил|заказал)|(спасибо|благодар)\w*[,\s].{0,15}не\s+(над|нуж)|не\s+интересует|не\s+нужн\w*\s+(больше|уже)|закройте\s+заявк|решили\s+не\s+(делать|оформл|запуск)|не\s+подход|кереги\s+жок|башка\s+жерден/i;

// Согласие двигаться дальше / платить.
const PROCEED_RE = /запуска(й|ем|йте|ть)|оформляйте|давайте(\s+(делать|оформ|запуск))?|соглас(ен|на|ны)|оплач(у|ен|ивать|у\s+сегодня)|оплат(им|ил|или)|перев(ед(у|[её]м)|ож(у|ать))|перечисл(ю|ить)|плач(у|ем)|беру|начина(й|йте|ем)|поехали|хочу\s+оформ|будем\s+(делать|оформл|запуск)|да[,.!\s]+(будем|давайте|запуск|оформ|конечно|плач|оплач)/i;

function norm(text = '') { return String(text || '').toLowerCase().trim(); }

// classifyRegex(text) — PURE. { decision, confidence, method:'regex' }.
function classifyRegex(text = '') {
  const t = norm(text);
  if (!t) return { decision: 'unclear', confidence: 0, method: 'regex' };
  if (POSTPONE_RE.test(t)) return { decision: 'postpone', confidence: 0.8, method: 'regex' };
  if (REFUSE_RE.test(t))   return { decision: 'refuse',   confidence: 0.85, method: 'regex' };
  if (PROCEED_RE.test(t))  return { decision: 'proceed',  confidence: 0.8, method: 'regex' };
  return { decision: 'unclear', confidence: 0, method: 'regex' };
}

const SYSTEM = [
  'Ты классифицируешь РЕШЕНИЕ клиента сертификационной компании по его сообщению.',
  'Клиенту ранее посчитали стоимость оформления документа. Определи, что он решил.',
  'Ответь РОВНО одним словом (без кавычек и пояснений):',
  '  refuse   — отказался / не будет делать / нашёл другую компанию / передумал',
  '  proceed  — согласен, будет запускать / готов платить',
  '  postpone — отложил, ещё думает (это НЕ отказ)',
  '  unclear  — по сообщению решение не понять',
].join('\n');

const _cache = new Map();               // textHash → { v, exp }
const TTL_MS = 6 * 3600 * 1000;

function parseDecision(raw = '') {
  const s = norm(raw);
  if (/\brefuse\b|отказ/.test(s)) return 'refuse';
  if (/\bproceed\b|запуск|соглас|оплат/.test(s)) return 'proceed';
  if (/\bpostpone\b|отлож|подума/.test(s)) return 'postpone';
  return 'unclear';
}

// classifyDecision(text, deps) — regex-first; LLM только на unclear. Async.
// deps: { llm, now, fetch } (llm инъектируется в тестах, LLM не дёргается без ключа).
async function classifyDecision(text = '', deps = {}) {
  const reg = classifyRegex(text);
  if (reg.decision !== 'unclear') return reg;

  const llm = deps.llm || defaultLlm;
  if (!llm.isConfigured || !llm.isConfigured()) return reg;   // нет ключа → остаёмся unclear
  const t = norm(text);
  if (t.length < 3) return reg;

  const key = crypto.createHash('sha1').update(t).digest('hex');
  const now = deps.now || Date.now();
  const hit = _cache.get(key);
  if (hit && hit.exp > now) return hit.v;

  let out = { decision: 'unclear', confidence: 0, method: 'llm' };
  try {
    const r = await llm.complete({ system: SYSTEM, user: `Сообщение клиента: """${t.slice(0, 500)}"""`, maxTokens: 8 }, deps);
    if (r && r.ok && r.text) {
      const decision = parseDecision(r.text);
      out = { decision, confidence: decision === 'unclear' ? 0.4 : 0.8, method: 'llm' };
    }
  } catch (_) { /* сеть/ключ → unclear */ }

  _cache.set(key, { v: out, exp: now + TTL_MS });
  return out;
}

module.exports = { classifyRegex, classifyDecision, POSTPONE_RE, REFUSE_RE, PROCEED_RE };
