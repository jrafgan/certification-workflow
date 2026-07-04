'use strict';

// Tests: archiveOutbound stores our own sent WhatsApp as outbound (for full-conversation
// history). No DB — a fake model captures the created doc. Run: node tests/whatsapp-archive.test.js

const assert = require('assert');
const { archiveOutbound } = require('../src/services/whatsappIngestService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

(async () => {
  const lean = (v) => ({ lean: async () => v });   // mimic Mongoose query.lean()
  await test('outbound direct message → stored with direction outbound + client phone_key', async () => {
    let created = null;
    const FakeWA = { findOne: () => lean(null), create: async (d) => { created = d; return { _id: 'x', ...d }; } };
    const raw = { provider: 'gowa', id: 'o1', from_me: true, from: '996507391773@s.whatsapp.net', chat_id: '996700111222@s.whatsapp.net', is_group: false, body: 'ваш документ готов' };
    const r = await archiveOutbound(raw, { WhatsAppMessage: FakeWA });
    assert.ok(r.message);
    assert.strictEqual(created.direction, 'outbound');
    assert.strictEqual(created.from_phone, '996507391773');   // us
    assert.strictEqual(created.to_phone, '996700111222');      // recipient
    assert.strictEqual(created.phone_key, '700111222');        // thread key = client
    assert.strictEqual(created.body, 'ваш документ готов');
  });

  await test('duplicate provider_message_id → skipped', async () => {
    const FakeWA = { findOne: () => lean({ _id: 'e' }), create: async () => { throw new Error('should not create'); } };
    const r = await archiveOutbound({ id: 'o1', from_me: true, from: '996507391773@s.whatsapp.net', chat_id: '996700111222@s.whatsapp.net', body: 'x' }, { WhatsAppMessage: FakeWA });
    assert.strictEqual(r.skipped, 'duplicate');
  });

  console.log(`\nWhatsApp archive: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
