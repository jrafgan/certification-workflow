'use strict';

// Tests for services/firstContactService — cold-number first-contact verification (gated).
// Pure buildProposal() + scan/decide with injected fakes. No MongoDB / no network.
// Run: node tests/first-contact.test.js

const assert = require('assert');
const fc = require('../src/services/firstContactService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

const ENV = { ...process.env };
function restore() { process.env = { ...ENV }; }

(async () => {
  console.log('\n[buildProposal — pure]');
  await test('normalizes phone, carries template name/lang from env, has evidence + impact', () => {
    process.env.FIRST_CONTACT_TEMPLATE_NAME = 'first_contact_check';
    process.env.FIRST_CONTACT_TEMPLATE_LANG = 'ru';
    const p = fc.buildProposal({ row: 42, phone: '+996 700 11 22 33', legal_entity: 'ОсОО Тест' }, '700112233');
    assert.strictEqual(p.to_phone, '700112233');
    assert.strictEqual(p.phone_key, '700112233');
    assert.strictEqual(p.template_name, 'first_contact_check');
    assert.strictEqual(p.template_lang, 'ru');
    assert.strictEqual(p.application_ref, 'application_row:42');
    assert.strictEqual(p.state, 'pending_approval');
    assert.ok(p.reason && p.impact);
    assert.strictEqual(p.evidence.length, 2);
    restore();
  });

  console.log('\n[scanUnknownApplicants — only cold numbers, idempotent]');
  function fakeWA(knownKeys = []) { return { exists: async (q) => knownKeys.includes(q.phone_key) }; }
  function fakeFCP(existingKeys = []) {
    const created = [];
    return {
      _created: created,
      exists: async (q) => existingKeys.includes(q.phone_key),
      create: async (doc) => { created.push(doc); return doc; },
    };
  }

  await test('unknown number with no proposal → generated', async () => {
    const reader = { readApplications: async () => ({ applications: [{ row: 2, phone: '700111222', legal_entity: 'A' }] }) };
    const FCP = fakeFCP();
    const r = await fc.scanUnknownApplicants({ applicationsReader: reader, WhatsAppMessage: fakeWA([]), FirstContactProposal: FCP });
    assert.strictEqual(r.generated, 1);
    assert.strictEqual(FCP._created.length, 1);
    assert.strictEqual(FCP._created[0].phone_key, '700111222');
  });

  await test('number that already wrote us (inbound exists) → skipped already_known', async () => {
    const reader = { readApplications: async () => ({ applications: [{ row: 2, phone: '700111222' }] }) };
    const r = await fc.scanUnknownApplicants({ applicationsReader: reader, WhatsAppMessage: fakeWA(['700111222']), FirstContactProposal: fakeFCP() });
    assert.strictEqual(r.generated, 0);
    assert.strictEqual(r.reasons.already_known, 1);
  });

  await test('existing proposal → skipped proposal_exists', async () => {
    const reader = { readApplications: async () => ({ applications: [{ row: 2, phone: '700111222' }] }) };
    const r = await fc.scanUnknownApplicants({ applicationsReader: reader, WhatsAppMessage: fakeWA([]), FirstContactProposal: fakeFCP(['700111222']) });
    assert.strictEqual(r.generated, 0);
    assert.strictEqual(r.reasons.proposal_exists, 1);
  });

  await test('empty/short phone → skipped no_phone (flagged, not assumed)', async () => {
    const reader = { readApplications: async () => ({ applications: [{ row: 2, phone: '' }, { row: 3, phone: '12' }] }) };
    const r = await fc.scanUnknownApplicants({ applicationsReader: reader, WhatsAppMessage: fakeWA([]), FirstContactProposal: fakeFCP() });
    assert.strictEqual(r.generated, 0);
    assert.strictEqual(r.reasons.no_phone, 2);
  });

  await test('same number twice in the form → one generated, one duplicate', async () => {
    const reader = { readApplications: async () => ({ applications: [{ row: 2, phone: '700111222' }, { row: 5, phone: '+996700111222' }] }) };
    const r = await fc.scanUnknownApplicants({ applicationsReader: reader, WhatsAppMessage: fakeWA([]), FirstContactProposal: fakeFCP() });
    assert.strictEqual(r.generated, 1);
    assert.strictEqual(r.reasons.duplicate_in_form, 1);
  });

  console.log('\n[decide — approve sends template, reject closes]');
  function fakeProposal(extra = {}) {
    return Object.assign({
      _id: 'p1', to_phone: '700111222', template_name: 'first_contact_check', template_lang: 'ru',
      state: 'pending_approval', save: async function () { return this; },
    }, extra);
  }

  await test('approve → calls sendTemplate, state becomes sent on ok', async () => {
    let sentArgs = null;
    const proposal = fakeProposal();
    const FCP = { findById: async () => proposal };
    const cloud = { sendTemplate: async (to, name, lang) => { sentArgs = { to, name, lang }; return { ok: true, message_id: 'wamid.Z' }; } };
    const r = await fc.decide('p1', 'approve', { FirstContactProposal: FCP, cloud, decidedBy: 'alia' });
    assert.deepStrictEqual(sentArgs, { to: '700111222', name: 'first_contact_check', lang: 'ru' });
    assert.strictEqual(r.state, 'sent');
    assert.strictEqual(r.decision, 'approve');
    assert.strictEqual(r.decided_by, 'alia');
    assert.ok(r.sent_at);
  });

  await test('approve but send fails → stays approved, captures error (retryable)', async () => {
    const proposal = fakeProposal();
    const FCP = { findById: async () => proposal };
    const cloud = { sendTemplate: async () => ({ ok: false, reason: 'api_error', status: 400 }) };
    const r = await fc.decide('p1', 'approve', { FirstContactProposal: FCP, cloud });
    assert.strictEqual(r.state, 'approved');
    assert.strictEqual(r.send_result.ok, false);
  });

  await test('reject → state rejected, no send', async () => {
    let sendCalled = false;
    const proposal = fakeProposal();
    const FCP = { findById: async () => proposal };
    const cloud = { sendTemplate: async () => { sendCalled = true; return { ok: true }; } };
    const r = await fc.decide('p1', 'reject', { FirstContactProposal: FCP, cloud });
    assert.strictEqual(r.state, 'rejected');
    assert.strictEqual(sendCalled, false);
  });

  await test('already sent → terminal no-op (no re-send)', async () => {
    let sendCalled = false;
    const proposal = fakeProposal({ state: 'sent' });
    const FCP = { findById: async () => proposal };
    const cloud = { sendTemplate: async () => { sendCalled = true; return { ok: true }; } };
    const r = await fc.decide('p1', 'approve', { FirstContactProposal: FCP, cloud });
    assert.strictEqual(r.state, 'sent');
    assert.strictEqual(sendCalled, false);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
