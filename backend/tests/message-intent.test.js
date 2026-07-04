'use strict';

// Tests for messageIntentService — client-decision classification (refuse/proceed/postpone/
// unclear). Regex layer is PURE and covers the common phrasings + precedence («пока отложим»
// is postpone, not refuse; «не будем» is refuse, not proceed). LLM fallback is exercised with
// an injected mock (no network, no key needed).
//
// Run: node tests/message-intent.test.js

const assert = require('assert');
const svc = require('../src/services/messageIntentService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}
const dec = (t) => svc.classifyRegex(t).decision;

(async () => {
  console.log('\n[classifyRegex — decision]');

  await test('refuse phrases', () => {
    ['передумали', 'мы нашли другую компанию', 'наверное оформлять уже не будем',
     'не будем делать', 'закройте заявку', 'нам это не подходит', 'решили не оформлять'].forEach(t =>
      assert.strictEqual(dec(t), 'refuse', `should be refuse: ${t}`));
  });

  await test('postpone phrases (NOT refuse)', () => {
    ['пока отложим', 'надо подумать', 'давайте после выходных', 'перезвоните позже', 'не сейчас'].forEach(t =>
      assert.strictEqual(dec(t), 'postpone', `should be postpone: ${t}`));
  });

  await test('proceed phrases (NOT refuse)', () => {
    ['запускаем', 'оплачу сегодня', 'давайте оформлять', 'да, будем', 'перевожу оплату'].forEach(t =>
      assert.strictEqual(dec(t), 'proceed', `should be proceed: ${t}`));
  });

  await test('unclear for neutral text', () => {
    ['здравствуйте', 'сколько стоит сертификат?', ''].forEach(t =>
      assert.strictEqual(dec(t), 'unclear', `should be unclear: ${t}`));
  });

  console.log('\n[classifyDecision — LLM fallback]');

  const fakeLlm = (text, ok = true) => ({ isConfigured: () => true, complete: async () => ({ ok, text }) });

  await test('unclear regex → LLM verdict used', async () => {
    const r = await svc.classifyDecision('думаю, это нам сейчас ни к чему совсем', { llm: fakeLlm('refuse'), now: 1 });
    assert.strictEqual(r.decision, 'refuse');
    assert.strictEqual(r.method, 'llm');
  });

  await test('no API key → stays unclear (no LLM)', async () => {
    const noKey = { isConfigured: () => false, complete: async () => { throw new Error('should not call'); } };
    const r = await svc.classifyDecision('какое-то невнятное сообщение без сигнала', { llm: noKey, now: 2 });
    assert.strictEqual(r.decision, 'unclear');
    assert.strictEqual(r.method, 'regex');
  });

  await test('regex-confident text does NOT call LLM', async () => {
    const boom = { isConfigured: () => true, complete: async () => { throw new Error('LLM must not be called'); } };
    const r = await svc.classifyDecision('передумали, спасибо', { llm: boom, now: 3 });
    assert.strictEqual(r.decision, 'refuse');
    assert.strictEqual(r.method, 'regex');
  });

  console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of failures) console.error(`\n✗ ${f.name}\n${f.err.stack}`); process.exit(1); }
})();
