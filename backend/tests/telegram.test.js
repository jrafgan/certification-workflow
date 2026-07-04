'use strict';

// Tests for the Telegram transport (integrations/telegramClient) + RealAdapter dispatch.
// Mocked fetch, no real Telegram call. Run: node tests/telegram.test.js

const assert = require('assert');
const tg = require('../src/integrations/telegramClient');
const { RealAdapter, StubAdapter } = require('../src/integrations/platformAdapter');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

const ENV = { ...process.env };
function restore() { process.env = { ...ENV }; }

(async () => {
  console.log('\n[sendMessage — gated on token]');
  await test('not configured → ok:false', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = await tg.sendMessage('123', 'hi', { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'not_configured'); restore();
  });
  await test('configured → posts chat_id + text, returns message_id', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999:ABC';
    const fetch = async (url, opts) => {
      assert.ok(url.includes('/bot999:ABC/sendMessage'));
      const b = JSON.parse(opts.body);
      assert.strictEqual(b.chat_id, '12345');
      assert.strictEqual(b.text, 'привет');
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }) };
    };
    const r = await tg.sendMessage(12345, 'привет', { fetch });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.message_id, 77); restore();
  });
  await test('telegram api ok:false → ok:false', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999:ABC';
    const r = await tg.sendMessage('1', 'x', { fetch: async () => ({ ok: true, json: async () => ({ ok: false, description: 'blocked' }) }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'api_error'); restore();
  });

  console.log('\n[verifySecret — header token]');
  await test('matching secret → ok:true', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t';
    assert.strictEqual(tg.verifySecret('s3cr3t').ok, true); restore();
  });
  await test('wrong secret → ok:false', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t';
    assert.strictEqual(tg.verifySecret('nope').ok, false); restore();
  });
  await test('no secret configured → ok:null (skip)', () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    assert.strictEqual(tg.verifySecret('anything').ok, null); restore();
  });

  console.log('\n[parseUpdate — normalize Update]');
  await test('message → platform/handle/text/display_name', () => {
    const p = tg.parseUpdate({ message: { chat: { id: 555 }, from: { first_name: 'Иван', last_name: 'П', username: 'ivan' }, text: 'Здравствуйте', date: 1700000000 } });
    assert.strictEqual(p.platform, 'telegram');
    assert.strictEqual(p.handle, '555');           // chat id as string
    assert.strictEqual(p.display_name, 'Иван П');
    assert.strictEqual(p.username, '@ivan');
    assert.strictEqual(p.text, 'Здравствуйте');
  });
  await test('edited_message + caption supported', () => {
    const p = tg.parseUpdate({ edited_message: { chat: { id: 7 }, from: { username: 'u' }, caption: 'подпись' } });
    assert.strictEqual(p.handle, '7'); assert.strictEqual(p.text, 'подпись'); assert.strictEqual(p.display_name, 'u');
  });
  await test('non-message update → null', () => {
    assert.strictEqual(tg.parseUpdate({ poll: {} }), null);
    assert.strictEqual(tg.parseUpdate({}), null);
  });

  console.log('\n[RealAdapter.deliver — dispatch by platform]');
  await test('telegram + configured → sends via telegram client', async () => {
    let sent = null;
    const telegram = { isConfigured: () => true, sendMessage: async (chat, text) => { sent = { chat, text }; return { ok: true, message_id: 9 }; } };
    const r = await RealAdapter.deliver({ platform: 'telegram', to_handle: '42', proposed_text: 'ответ' }, { telegram });
    assert.deepStrictEqual(sent, { chat: '42', text: 'ответ' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.delivered, true); assert.strictEqual(r.ref, 'telegram:9');
  });
  await test('telegram not configured → falls back to stub (not transmitted)', async () => {
    const telegram = { isConfigured: () => false, sendMessage: async () => ({ ok: true }) };
    const r = await RealAdapter.deliver({ platform: 'telegram', to_handle: '42', proposed_text: 'x', _id: 'd1' }, { telegram });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.delivered, false);
  });
  await test('non-telegram platform → stub (no live client yet)', async () => {
    const r = await RealAdapter.deliver({ platform: 'instagram', to_handle: 'u', proposed_text: 'x', _id: 'd2' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.delivered, false);
    assert.ok(r.ref.startsWith('stub:instagram'));
  });
  await test('telegram send failure → ok:false with detail', async () => {
    const telegram = { isConfigured: () => true, sendMessage: async () => ({ ok: false, reason: 'api_error' }) };
    const r = await RealAdapter.deliver({ platform: 'telegram', to_handle: '42', proposed_text: 'x' }, { telegram });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.delivered, false);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
