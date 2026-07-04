'use strict';

// Tests for interestDetectionService.detect (pure) + firstContactService.proposeFromChatInterest
// (with injected fakes). No I/O. Run: node tests/interest-detection.test.js

const assert = require('assert');
const interest = require('../src/services/interestDetectionService');
const fc = require('../src/services/firstContactService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

(async () => {
  console.log('\n[detect — certification interest]');
  await test('declaration/certificate questions → interested', () => {
    assert.strictEqual(interest.detect('Кто делает декларацию соответствия?').interested, true);
    assert.strictEqual(interest.detect('сколько стоит сертификат на одежду?').interested, true);
    assert.strictEqual(interest.detect('нужно отказное письмо для вайлдберриз').interested, true);
  });
  await test('unrelated chatter → not interested', () => {
    assert.strictEqual(interest.detect('всем привет, как дела?').interested, false);
    assert.strictEqual(interest.detect('продаю айфон недорого').interested, false);
  });
  await test('returns category + reason', () => {
    const d = interest.detect('сделайте декларацию');
    assert.strictEqual(d.category, 'declaration');
    assert.ok(d.reason);
  });

  console.log('\n[proposeFromChatInterest — gated lead, idempotent, skip active contacts]');
  function fakeFCP(existsKeys = []) { const created = []; return { _created: created, exists: async (q) => existsKeys.includes(q.phone_key), create: async (doc) => { created.push(doc); return doc; } }; }
  function fakeWA(directInboundKeys = []) { return { exists: async (q) => directInboundKeys.includes(q.phone_key) }; }

  await test('new lead from group → proposal created with chat_interest source + proposed_text', async () => {
    const FCP = fakeFCP();
    const r = await fc.proposeFromChatInterest(
      { phone: '996700111222', name: 'Иван', context: 'группа Продавцы WB', detection: interest.detect('кто делает сертификат?') },
      { FirstContactProposal: FCP, WhatsAppMessage: fakeWA([]) },
    );
    assert.strictEqual(r.generated, true);
    assert.strictEqual(FCP._created[0].source, 'chat_interest');
    assert.strictEqual(FCP._created[0].phone_key, '700111222');
    assert.ok(FCP._created[0].proposed_text.includes('Dokumenty.pro'));
    assert.strictEqual(FCP._created[0].context, 'группа Продавцы WB');
  });
  await test('already in direct contact → skipped (no cold-contact of active clients)', async () => {
    const r = await fc.proposeFromChatInterest(
      { phone: '996700111222', detection: interest.detect('сертификат') },
      { FirstContactProposal: fakeFCP(), WhatsAppMessage: fakeWA(['700111222']) },
    );
    assert.strictEqual(r.skipped, 'already_in_contact');
  });
  await test('existing proposal → skipped (idempotent)', async () => {
    const r = await fc.proposeFromChatInterest(
      { phone: '996700111222', detection: interest.detect('сертификат') },
      { FirstContactProposal: fakeFCP(['700111222']), WhatsAppMessage: fakeWA([]) },
    );
    assert.strictEqual(r.skipped, 'proposal_exists');
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
