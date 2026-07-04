'use strict';

// Pure unit tests for WhatsApp ingestion mapping (Sprint: whatsapp-web.js).
// Tests only the provider-agnostic mapping (no whatsapp-web.js, no Puppeteer,
// no DB). The library integration itself requires a live QR login and is
// verified manually via scripts/whatsapp-listen.js.
//
// Run: node tests/whatsapp-ingest.test.js  (or: npm run test:whatsapp-ingest)

const assert = require('assert');
const { mapIncomingMessage, phoneFromJid, computeAddressing } = require('../src/services/whatsappIngestService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

test('phoneFromJid extracts digits from a WhatsApp JID', () => {
  assert.strictEqual(phoneFromJid('996777240858@c.us'), '996777240858');
  assert.strictEqual(phoneFromJid('996700111222@c.us'), '996700111222');
  assert.strictEqual(phoneFromJid(''), '');
});

test('maps a plain text inbound message', () => {
  const raw = { id: 'true_996777240858@c.us_ABC', from: '996777240858@c.us', body: 'согласен с макетом', timestamp: 1748600000, fromMe: false };
  const m = mapIncomingMessage(raw);
  assert.strictEqual(m.direction, 'inbound');
  assert.strictEqual(m.provider, 'whatsapp_web');
  assert.strictEqual(m.from_phone, '996777240858');
  assert.strictEqual(m.phone_key, '777240858');       // normalized local key (matches shortened sheet form)
  assert.strictEqual(m.body, 'согласен с макетом');
  assert.strictEqual(m.match_status, 'received');
  assert.ok(m.sent_at instanceof Date);
  assert.deepStrictEqual(m.attachments, []);
});

test('maps an inbound message with an attachment (metadata only)', () => {
  const raw = {
    id: 'X1', from: '0777240858@c.us', body: '', timestamp: 1748600001, fromMe: false,
    attachments: [{ file_name: 'maket.pdf', mime_type: 'application/pdf', size: 12345, media_ref: '/tmp/maket.pdf' }],
  };
  const m = mapIncomingMessage(raw);
  assert.strictEqual(m.attachments.length, 1);
  assert.strictEqual(m.attachments[0].file_name, 'maket.pdf');
  assert.strictEqual(m.attachments[0].mime_type, 'application/pdf');
  assert.strictEqual(m.attachments[0].size, 12345);
  // phone normalized from the 0-prefixed JID
  assert.strictEqual(m.phone_key, '777240858');
});

test('tolerates whatsapp-web.js media field aliases (filename/mimetype)', () => {
  const raw = { id: 'X2', from: '996700111222@c.us', timestamp: 1, attachments: [{ filename: 'doc.jpg', mimetype: 'image/jpeg' }] };
  const m = mapIncomingMessage(raw);
  assert.strictEqual(m.attachments[0].file_name, 'doc.jpg');
  assert.strictEqual(m.attachments[0].mime_type, 'image/jpeg');
});

test('missing fields degrade safely', () => {
  const m = mapIncomingMessage({});
  assert.strictEqual(m.from_phone, '');
  assert.strictEqual(m.phone_key, '');
  assert.strictEqual(m.body, '');
  assert.strictEqual(m.sent_at, undefined);
});

// ── Addressing (group vs direct) ──────────────────────────────────────────────
const ME = ['507391773']; // operator match key (996507391773 → last 9)

test('direct message → addressed_me:true, reason direct', () => {
  const a = computeAddressing({ is_group: false, body: 'привет' }, { meKeys: ME });
  assert.strictEqual(a.addressed_me, true);
  assert.strictEqual(a.addressed_reason, 'direct');
});

test('group + @mention of operator → mention', () => {
  const a = computeAddressing({ is_group: true, mentioned_jids: ['996507391773', '996111222333'], body: 'вопрос' }, { meKeys: ME });
  assert.deepStrictEqual([a.addressed_me, a.addressed_reason], [true, 'mention']);
});

test('group + reply to operator → reply', () => {
  const a = computeAddressing({ is_group: true, quoted_author: '996507391773', body: 'да' }, { meKeys: ME });
  assert.deepStrictEqual([a.addressed_me, a.addressed_reason], [true, 'reply']);
});

test('group + certification keyword (interest) → keyword', () => {
  const detect = (t) => ({ interested: /деклараци/i.test(t) });
  const a = computeAddressing({ is_group: true, body: 'сколько стоит декларация?' }, { meKeys: ME, detect });
  assert.deepStrictEqual([a.addressed_me, a.addressed_reason], [true, 'keyword']);
});

test('group chatter not addressed → addressed_me:false', () => {
  const detect = () => ({ interested: false });
  const a = computeAddressing({ is_group: true, mentioned_jids: ['996111222333'], quoted_author: '996444', body: 'всем привет' }, { meKeys: ME, detect });
  assert.deepStrictEqual([a.addressed_me, a.addressed_reason], [false, null]);
});

test('mapIncomingMessage carries group fields + addressing', () => {
  const raw = { provider: 'gowa', id: 'G9', from: '996555444333@s.whatsapp.net', chat_id: '120@g.us', is_group: true, group_subject: 'Поставщики', mentioned_jids: ['996507391773'], body: 'кто по СГР?' };
  const m = mapIncomingMessage(raw, null, computeAddressing(raw, { meKeys: ME }));
  assert.strictEqual(m.is_group, true);
  assert.strictEqual(m.chat_id, '120@g.us');
  assert.strictEqual(m.group_subject, 'Поставщики');
  assert.strictEqual(m.addressed_me, true);
  assert.strictEqual(m.addressed_reason, 'mention');
});

console.log(`\nWhatsApp ingest mapping: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(` - ${f.name}: ${f.err.message}`)); process.exit(1); }
