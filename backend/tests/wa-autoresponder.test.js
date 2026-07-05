'use strict';

// Tests for whatsappAutoResponderService — the KB-policy executor.
//   • classifyTopic: inbound text → { kind, topic, faqKeys }
//   • composeAnswer: approved KB → grounded answer, or null (→ gated)
//   • handleInbound: guard/skip logic + mode matrix (off/shadow/auto) with STUBBED deps
//     (no DB, no real sends).
//
// Run: node tests/wa-autoresponder.test.js

const assert = require('assert');
const svc = require('../src/services/whatsappAutoResponderService');

let pass = 0, fail = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// Approved-KB fixture (subset of operatorMasterKbV2 client_faq entries).
const KB = [
  { text: 'Декларация (ДС): стоимость от 17000 сом ... около 2 недель ...', value: { kind: 'client_faq', q: 'стоимость и сроки ДС' } },
  { text: 'Сертификат (СС): для местных ИП/ОсОО от 35000 сом ...', value: { kind: 'client_faq', q: 'стоимость и сроки СС' } },
  { text: 'Отказное письмо — отдельный документ, стоимость 5 000 сом.', value: { kind: 'client_faq', q: 'отказное письмо' } },
  { text: 'ТН ВЭД — код товара. Трикотаж — 61, швейка — 62 ...', value: { kind: 'client_faq', q: 'что такое ТН ВЭД' } },
  { text: 'Для заявки нужны: название товара, состав, заявитель, производитель, ТН ВЭД, свидетельство ИП/ОсОО.', value: { kind: 'client_faq', q: 'какие документы нужны' } },
];

const kindOf = (t) => svc.classifyTopic(t);

// ── classifyTopic ──
test('classify: price ДС → pricing_from_kb / price_ds', () => {
  const r = kindOf('сколько стоит декларация?');
  assert.strictEqual(r.kind, 'pricing_from_kb');
  assert.strictEqual(r.topic, 'price_ds');
});
test('classify: price СС → price_ss', () => {
  assert.strictEqual(kindOf('а сертификат почём?').topic, 'price_ss');
});
test('classify: timeline → timelines_from_kb', () => {
  assert.strictEqual(kindOf('сколько времени делается документ?').kind, 'timelines_from_kb');
});
test('classify: ТН ВЭД → service_info / tnved', () => {
  assert.strictEqual(kindOf('что такое тнвэд?').topic, 'tnved');
});
test('classify: application link → application_link', () => {
  const r = kindOf('как оставить заявку, дайте ссылку');
  assert.strictEqual(r.kind, 'application_link');
  assert.strictEqual(r.topic, 'application');
});
test('classify: complaint → other (gated)', () => {
  assert.strictEqual(kindOf('вы опять всё перепутали, безобразие').kind, 'other');
});
test('classify: my-order status → other (gated)', () => {
  assert.strictEqual(kindOf('где мой документ по заказу, когда отдадите?').kind, 'other');
});
test('classify: empty text → other', () => {
  assert.strictEqual(kindOf('   ').kind, 'other');
});

// ── composeAnswer ──
test('compose: price_ds pulls the approved ДС faq', () => {
  const r = svc.composeAnswer({ topic: 'price_ds', faqKeys: ['стоимость и сроки ДС'] }, KB, null);
  assert.ok(r && /от 17000/.test(r.answer));
  assert.ok(/client_faq/.test(r.matchedRef));
});
test('compose: price_general joins ДС + СС', () => {
  const r = svc.composeAnswer({ topic: 'price_general', faqKeys: ['стоимость и сроки ДС', 'стоимость и сроки СС'] }, KB, null);
  assert.ok(/17000/.test(r.answer) && /35000/.test(r.answer));
});
test('compose: application WITH url → includes link + docs', () => {
  const r = svc.composeAnswer({ topic: 'application', faqKeys: ['какие документы нужны'] }, KB, 'https://forms.gle/x');
  assert.ok(/forms\.gle\/x/.test(r.answer) && /свидетельство/.test(r.answer));
});
test('compose: application WITHOUT url → null (gate it)', () => {
  assert.strictEqual(svc.composeAnswer({ topic: 'application', faqKeys: ['какие документы нужны'] }, KB, null), null);
});
test('compose: faq key not in KB → null', () => {
  assert.strictEqual(svc.composeAnswer({ topic: 'foreign', faqKeys: ['зарубежная компания'] }, KB, null), null);
});

// ── handleInbound: guards + mode matrix (stubbed deps) ──
function stubs({ recentHuman = false, existing = false } = {}) {
  const created = [], sent = [];
  return {
    created, sent,
    deps: {
      WaAutoReply: { exists: async () => existing, create: async (d) => { created.push(d); return d; } },
      WhatsAppMessage: { exists: async () => recentHuman },
      knowledgeBaseService: { getApprovedKnowledge: async () => KB, getBusinessSetting: async () => ({ value: 'https://forms.gle/x' }) },
      outbound: { send: async (to, body) => { sent.push({ to, body }); return { ok: true, id: 'm1' }; } },
    },
  };
}
const IN = (over = {}) => ({ id: 'wamid.1', from: '996700111222@s.whatsapp.net', body: 'сколько стоит декларация?', is_group: false, from_me: false, ...over });

test('guard: group → skipped', async () => {
  process.env.WA_AUTORESPONDER_MODE = 'auto';
  const s = stubs(); const r = await svc.handleInbound(IN({ is_group: true }), s.deps);
  assert.strictEqual(r.skipped, 'group'); assert.strictEqual(s.created.length, 0);
});
test('guard: from_me → skipped', async () => {
  const s = stubs(); assert.strictEqual((await svc.handleInbound(IN({ from_me: true }), s.deps)).skipped, 'from_me');
});
test('guard: no text → skipped', async () => {
  const s = stubs(); assert.strictEqual((await svc.handleInbound(IN({ body: '' }), s.deps)).skipped, 'no_text');
});
test('guard: duplicate → skipped', async () => {
  const s = stubs({ existing: true }); assert.strictEqual((await svc.handleInbound(IN(), s.deps)).skipped, 'duplicate');
});
test('mode=off → nothing, no record', async () => {
  process.env.WA_AUTORESPONDER_MODE = 'off';
  const s = stubs(); const r = await svc.handleInbound(IN(), s.deps);
  assert.strictEqual(r.skipped, 'mode_off'); assert.strictEqual(s.created.length, 0);
});
test('shadow: composes but does NOT send', async () => {
  process.env.WA_AUTORESPONDER_MODE = 'shadow';
  const s = stubs(); const r = await svc.handleInbound(IN(), s.deps);
  assert.strictEqual(r.decision, 'shadow');
  assert.strictEqual(s.sent.length, 0);
  assert.strictEqual(s.created[0].decision, 'shadow');
  assert.ok(/17000/.test(s.created[0].answer_text));
});
test('auto: auto-eligible → SENT via GOWA', async () => {
  process.env.WA_AUTORESPONDER_MODE = 'auto';
  const s = stubs(); const r = await svc.handleInbound(IN(), s.deps);
  assert.strictEqual(r.decision, 'auto_sent');
  assert.strictEqual(s.sent.length, 1);
  assert.ok(/17000/.test(s.sent[0].body));
});
test('auto: complaint → gated, not sent', async () => {
  process.env.WA_AUTORESPONDER_MODE = 'auto';
  const s = stubs(); const r = await svc.handleInbound(IN({ body: 'вы опять всё перепутали' }), s.deps);
  assert.strictEqual(r.decision, 'gated'); assert.strictEqual(s.sent.length, 0);
});
test('auto: recent HUMAN outbound → gated (don\'t step on operator)', async () => {
  process.env.WA_AUTORESPONDER_MODE = 'auto';
  const s = stubs({ recentHuman: true }); const r = await svc.handleInbound(IN(), s.deps);
  assert.strictEqual(r.decision, 'gated'); assert.strictEqual(r.skip_reason, 'human_active'); assert.strictEqual(s.sent.length, 0);
});

(async () => {
  console.log('\n[wa-autoresponder]');
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  console.log(`\n${fail ? '✗' : '✓'} wa-autoresponder: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
