'use strict';

// Tests for the Meta WhatsApp Cloud API transport (services/whatsappCloudService).
// Send (mocked fetch), webhook verify, signature HMAC, payload parse. No real Graph call.
// Run: node tests/whatsapp-cloud.test.js

const assert = require('assert');
const crypto = require('crypto');
const cloud = require('../src/services/whatsappCloudService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

const ENV = { ...process.env };
function restore() { process.env = { ...ENV }; }

(async () => {
  console.log('\n[sendText — gated on credentials]');
  await test('not configured → ok:false', async () => {
    delete process.env.WHATSAPP_CLOUD_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const r = await cloud.sendText('996700', 'hi', { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'not_configured'); restore();
  });
  await test('configured + mocked Graph → ok with message_id', async () => {
    process.env.WHATSAPP_CLOUD_TOKEN = 't'; process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    const fetch = async (url, opts) => {
      assert.ok(url.includes('/123/messages'));
      assert.ok(JSON.parse(opts.body).text.body === 'привет');
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
    };
    const r = await cloud.sendText('+996 700 11 22', 'привет', { fetch });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.message_id, 'wamid.X'); restore();
  });

  console.log('\n[sendTemplate — cold-contact, pre-approved template]');
  await test('not configured → ok:false', async () => {
    delete process.env.WHATSAPP_CLOUD_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const r = await cloud.sendTemplate('996700', 'first_contact_check', 'ru', null, { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'not_configured'); restore();
  });
  await test('configured → posts type:template with name+lang', async () => {
    process.env.WHATSAPP_CLOUD_TOKEN = 't'; process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    const fetch = async (url, opts) => {
      assert.ok(url.includes('/123/messages'));
      const b = JSON.parse(opts.body);
      assert.strictEqual(b.type, 'template');
      assert.strictEqual(b.template.name, 'first_contact_check');
      assert.strictEqual(b.template.language.code, 'ru');
      assert.strictEqual(b.to, '996700112233'); // non-digits stripped
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.T' }] }) };
    };
    const r = await cloud.sendTemplate('+996 700 11 22 33', 'first_contact_check', 'ru', null, { fetch });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.message_id, 'wamid.T'); restore();
  });
  await test('missing template name → ok:false', async () => {
    process.env.WHATSAPP_CLOUD_TOKEN = 't'; process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    const r = await cloud.sendTemplate('996700', '', 'ru', null, { fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'missing_to_or_template'); restore();
  });

  console.log('\n[verifyWebhook — handshake]');
  await test('matching verify token → echo challenge', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'secret123';
    const r = cloud.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'secret123', 'hub.challenge': 'CHX' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.challenge, 'CHX'); restore();
  });
  await test('wrong token → not ok', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'secret123';
    assert.strictEqual(cloud.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope' }).ok, false); restore();
  });

  console.log('\n[verifySignature — HMAC SHA256]');
  await test('valid signature → ok:true', () => {
    process.env.WHATSAPP_APP_SECRET = 'appsec';
    const raw = Buffer.from('{"a":1}');
    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsec').update(raw).digest('hex');
    assert.strictEqual(cloud.verifySignature(raw, sig).ok, true); restore();
  });
  await test('tampered signature → ok:false', () => {
    process.env.WHATSAPP_APP_SECRET = 'appsec';
    assert.strictEqual(cloud.verifySignature(Buffer.from('{"a":1}'), 'sha256=deadbeef').ok, false); restore();
  });
  await test('no app secret → ok:null (skip)', () => {
    delete process.env.WHATSAPP_APP_SECRET;
    assert.strictEqual(cloud.verifySignature(Buffer.from('x'), 'sha256=x').ok, null); restore();
  });

  console.log('\n[parseIncoming — webhook payload]');
  await test('extracts text + voice messages with sender + name', () => {
    const payload = { entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Иван' } }],
      messages: [
        { id: 'm1', from: '996700111222', type: 'text', timestamp: '1', text: { body: 'Здравствуйте' } },
        { id: 'm2', from: '996700111222', type: 'audio', timestamp: '2', audio: { id: 'media-9' } },
      ],
    } }] }] };
    const msgs = cloud.parseIncoming(payload);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].text, 'Здравствуйте');
    assert.strictEqual(msgs[0].name, 'Иван');
    assert.strictEqual(msgs[1].is_voice, true);
    assert.strictEqual(msgs[1].media_id, 'media-9');
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
