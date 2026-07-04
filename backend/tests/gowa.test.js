'use strict';

// Tests for integrations/gowaClient — GOWA gateway transport (send, webhook verify, map).
// Mocked fetch, no real GOWA. Run: node tests/gowa.test.js

const assert = require('assert');
const crypto = require('crypto');
const gowa = require('../src/integrations/gowaClient');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}
const ENV = { ...process.env };
function restore() { process.env = { ...ENV }; }

(async () => {
  console.log('\n[sendText — REST POST /send/message]');
  await test('not configured → ok:false', async () => {
    delete process.env.GOWA_URL;
    const r = await gowa.sendText('996700', 'hi', { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'not_configured'); restore();
  });
  await test('configured → posts phone(digits)+message with basic auth', async () => {
    process.env.GOWA_URL = 'http://gowa:3000';
    process.env.GOWA_BASIC_AUTH = 'admin:secret';
    const fetch = async (url, opts) => {
      assert.ok(url.endsWith('/send/message'));
      assert.strictEqual(opts.headers.Authorization, 'Basic ' + Buffer.from('admin:secret').toString('base64'));
      const b = JSON.parse(opts.body);
      assert.strictEqual(b.phone, '996700112233');           // '+' and spaces stripped
      assert.strictEqual(b.message, 'привет');
      return { ok: true, json: async () => ({ results: { message_id: 'GW1' } }) };
    };
    const r = await gowa.sendText('+996 700 11 22 33', 'привет', { fetch });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.message_id, 'GW1'); restore();
  });

  console.log('\n[verifySignature — HMAC X-Hub-Signature-256]');
  await test('valid signature → ok:true', () => {
    process.env.GOWA_WEBHOOK_SECRET = 'sek';
    const raw = Buffer.from('{"event":"message"}');
    const sig = 'sha256=' + crypto.createHmac('sha256', 'sek').update(raw).digest('hex');
    assert.strictEqual(gowa.verifySignature(raw, sig).ok, true); restore();
  });
  await test('bad signature → ok:false; no secret → ok:null', () => {
    process.env.GOWA_WEBHOOK_SECRET = 'sek';
    assert.strictEqual(gowa.verifySignature(Buffer.from('x'), 'sha256=bad').ok, false);
    delete process.env.GOWA_WEBHOOK_SECRET;
    assert.strictEqual(gowa.verifySignature(Buffer.from('x'), 'sha256=bad').ok, null); restore();
  });

  console.log('\n[toIngestRaw — map GOWA webhook → ingest shape]');
  await test('incoming message → {from, body, timestamp(sec), provider:gowa}', () => {
    const ev = { event: 'message', payload: { id: 'M1', chat_id: '996700111222@s.whatsapp.net', from: '996700111222@s.whatsapp.net', from_name: 'Иван', timestamp: '2026-06-30T10:30:00Z', is_from_me: false, body: 'Здравствуйте' } };
    const r = gowa.toIngestRaw(ev);
    assert.strictEqual(r.provider, 'gowa');
    assert.strictEqual(r.from, '996700111222@s.whatsapp.net');
    assert.strictEqual(r.body, 'Здравствуйте');
    assert.strictEqual(r.timestamp, Math.floor(Date.parse('2026-06-30T10:30:00Z') / 1000));
  });
  await test('own outgoing (is_from_me) → from_me:true (archived, not dropped); non-message → null', () => {
    const own = gowa.toIngestRaw({ event: 'message', payload: { id: 'O1', chat_id: '996700111222@s.whatsapp.net', is_from_me: true, body: 'x' } });
    assert.ok(own && own.from_me === true);           // archived as outbound, no longer null
    assert.strictEqual(gowa.toIngestRaw({ event: 'qr' }), null);
  });
  await test('media message → attachment with url', () => {
    const ev = { event: 'message', payload: { id: 'M2', from: '996700111222@s.whatsapp.net', is_from_me: false, body: '', image: { url: 'https://x/y.jpg', mime_type: 'image/jpeg' } } };
    const r = gowa.toIngestRaw(ev);
    assert.strictEqual(r.attachments.length, 1);
    assert.strictEqual(r.attachments[0].media_ref, 'https://x/y.jpg');
    assert.strictEqual(r.attachments[0].mime_type, 'image/jpeg');
  });

  console.log('\n[toIngestRaw — group / mention / reply context]');
  await test('direct message → is_group:false, no group context', () => {
    const ev = { event: 'message', payload: { id: 'D1', chat_id: '996700111222@s.whatsapp.net', from: '996700111222@s.whatsapp.net', body: 'привет' } };
    const r = gowa.toIngestRaw(ev);
    assert.strictEqual(r.is_group, false);
    assert.strictEqual(r.group_subject, null);
    assert.deepStrictEqual(r.mentioned_jids, []);
    assert.strictEqual(r.quoted_author, null);
  });
  await test('group message → is_group:true, chat_id + subject + participant sender', () => {
    const ev = { event: 'message', payload: { id: 'G1', chat_id: '120363000000000000@g.us', chat_name: 'Поставщики', from: '996555444333@s.whatsapp.net', body: 'кто по декларации?' } };
    const r = gowa.toIngestRaw(ev);
    assert.strictEqual(r.is_group, true);
    assert.strictEqual(r.chat_id, '120363000000000000@g.us');
    assert.strictEqual(r.group_subject, 'Поставщики');
    assert.strictEqual(r.from, '996555444333@s.whatsapp.net');   // participant = real sender
  });
  await test('extractMentions — top-level and nested under context', () => {
    assert.deepStrictEqual(gowa.extractMentions({ mentioned_jid: ['996507391773@s.whatsapp.net'] }), ['996507391773']);
    assert.deepStrictEqual(gowa.extractMentions({ context: { mentioned_jids: ['996507391773@s.whatsapp.net', '996111@s.whatsapp.net'] } }), ['996507391773', '996111']);
    assert.deepStrictEqual(gowa.extractMentions({}), []);
  });
  await test('extractQuotedAuthor — reply carries the quoted author JID', () => {
    assert.strictEqual(gowa.extractQuotedAuthor({ context: { participant: '996507391773@s.whatsapp.net' } }), '996507391773');
    assert.strictEqual(gowa.extractQuotedAuthor({ quoted_message: { from: '996507391773@s.whatsapp.net' } }), '996507391773');
    assert.strictEqual(gowa.extractQuotedAuthor({}), null);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
