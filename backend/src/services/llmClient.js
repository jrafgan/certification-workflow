'use strict';

// services/llmClient.js — провайдеро-независимый вызов LLM (OpenAI или Anthropic, raw fetch).
// Переиспользуется любыми операторскими фичами (черновики, анализ). Выбор провайдера — как в
// operatorAssistantService: OPENAI_API_KEY по умолчанию; ANTHROPIC_API_KEY как альтернатива;
// явный ASSISTANT_PROVIDER=openai|anthropic. Без ключей isConfigured()=false.

const OPENAI_ENDPOINT    = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION  = '2023-06-01';

function openaiKey()    { return process.env.OPENAI_API_KEY || null; }
function anthropicKey() { return process.env.ANTHROPIC_API_KEY || null; }

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

// complete({ system, user, maxTokens }, deps) → { ok, text } | { ok:false, reason }
async function complete({ system = '', user = '', maxTokens = 1200 } = {}, deps = {}) {
  const prov = provider();
  if (!prov) return { ok: false, reason: 'no_api_key', hint: 'Задайте OPENAI_API_KEY (или ANTHROPIC_API_KEY) в .env.' };
  const doFetch = deps.fetch || globalThis.fetch;

  try {
    if (prov === 'anthropic') {
      const res = await doFetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey(), 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify({ model: model(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) { let d = ''; try { d = JSON.stringify(await res.json()); } catch (_) {} return { ok: false, reason: 'api_error', status: res.status, detail: d }; }
      const json = await res.json();
      if (json.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
      const text = (Array.isArray(json.content) ? json.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
      return { ok: true, text, provider: 'anthropic', model: model() };
    }

    const res = await doFetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model(), max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) { let d = ''; try { d = JSON.stringify(await res.json()); } catch (_) {} return { ok: false, reason: 'api_error', status: res.status, detail: d }; }
    const json = await res.json();
    const text = String(json.choices?.[0]?.message?.content || '').trim();
    return { ok: true, text, provider: 'openai', model: model() };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

module.exports = { isConfigured, provider, model, complete };
