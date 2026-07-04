'use strict';

// Tests for the Lead Recovery Engine (services/leadRecoveryService) — pure layer only.
// leadFromOrder / assessLead / buildRecoveryProposal / decision transitions. No DB.
//
// Run: node tests/lead-recovery.test.js

const assert = require('assert');
const svc = require('../src/services/leadRecoveryService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-21T12:00:00Z');
const PHONE = '0700123456';

console.log('\n[leadFromOrder + assessLead]');

test('На согласовании, layout sent 10d ago, no decision → recoverable (MEDIUM)', () => {
  const order = {
    _id: 'o1', status: 'На согласовании', client: { name: 'Иван', phone: PHONE },
    layouts: [{ version: 1, sent_to_client_at: new Date(NOW - 10 * DAY) }],
  };
  const lead = svc.leadFromOrder(order);
  assert.strictEqual(lead.stage, 'awaiting_client_approval');
  const a = svc.assessLead(lead, NOW);
  assert.ok(a, 'assessment expected');
  assert.strictEqual(a.days_idle, 10);
  assert.strictEqual(a.severity, 'MEDIUM');
});

test('client already approved the layout → not recoverable', () => {
  const order = {
    _id: 'o2', status: 'На согласовании', client: { name: 'Иван', phone: PHONE },
    layouts: [{ version: 1, sent_to_client_at: new Date(NOW - 10 * DAY), client_decision: 'approved' }],
  };
  assert.strictEqual(svc.assessLead(svc.leadFromOrder(order), NOW), null);
});

test('idle below threshold and no missed deadline → not recoverable', () => {
  const order = {
    _id: 'o3', status: 'На согласовании', client: { phone: PHONE },
    layouts: [{ version: 1, sent_to_client_at: new Date(NOW - 1 * DAY) }],
  };
  assert.strictEqual(svc.assessLead(svc.leadFromOrder(order), NOW), null);
});

test('missed client_response_due bumps a fresh lead to recoverable (MEDIUM)', () => {
  const order = {
    _id: 'o4', status: 'Запустить', client: { phone: PHONE },
    created_at: new Date(NOW - 1 * DAY),
    deadlines: { client_response_due: new Date(NOW - 2 * DAY) },
  };
  const a = svc.assessLead(svc.leadFromOrder(order), NOW);
  assert.ok(a);
  assert.strictEqual(a.deadline_passed, true);
  assert.strictEqual(a.severity, 'MEDIUM');
});

test('no phone → cannot recover (WhatsApp channel required)', () => {
  const order = { _id: 'o5', status: 'Запустить', client: {}, created_at: new Date(NOW - 30 * DAY) };
  assert.strictEqual(svc.assessLead(svc.leadFromOrder(order), NOW), null);
});

test('order status with no client-side stage → leadFromOrder null', () => {
  assert.strictEqual(svc.leadFromOrder({ _id: 'o6', status: 'Ждем макет', client: { phone: PHONE } }), null);
});

test('15d idle → HIGH severity', () => {
  const order = { _id: 'o7', status: 'Запустить', client: { phone: PHONE }, created_at: new Date(NOW - 15 * DAY) };
  assert.strictEqual(svc.assessLead(svc.leadFromOrder(order), NOW).severity, 'HIGH');
});

console.log('\n[buildRecoveryProposal]');

test('builds a WhatsApp follow-up with the output-only contract', () => {
  const order = {
    _id: 'o8', status: 'На согласовании', sheet_row_id: 'R9', client: { companyName: 'ОсОО Ромашка', phone: PHONE },
    layouts: [{ version: 1, sent_to_client_at: new Date(NOW - 12 * DAY) }],
  };
  const p = svc.buildRecoveryProposal(svc.leadFromOrder(order), svc.assessLead(svc.leadFromOrder(order), NOW));
  assert.strictEqual(p.generated, true);
  assert.strictEqual(p.channel, 'whatsapp');
  assert.ok(/Ромашка/.test(p.proposed_text));
  assert.ok(/макет/.test(p.proposed_text));
  assert.ok(/WhatsApp is the only client channel/.test(p.impact));
});

test('stale application → re-engagement proposal', () => {
  const lead = svc.leadFromApplication({ row: 42, legal_entity: 'ИП Иванов', phone: PHONE, submitted_at: new Date(NOW - 20 * DAY) });
  const p = svc.buildRecoveryProposal(lead, svc.assessLead(lead, NOW));
  assert.strictEqual(p.generated, true);
  assert.strictEqual(p.lead_stage, 'stale_application');
  assert.strictEqual(p.application_ref, 'application_row:42');
});

test('not stalled → generated:false', () => {
  const order = { _id: 'o9', status: 'Запустить', client: { phone: PHONE }, created_at: new Date(NOW - 1 * DAY) };
  assert.strictEqual(svc.buildRecoveryProposal(svc.leadFromOrder(order), svc.assessLead(svc.leadFromOrder(order), NOW)).generated, false);
});

// New Form applications often have NO submission date → without an anchor they never look
// stalled. scan() injects the last WhatsApp-activity date as anchor_at (клиент написал/посчитали
// → тишина N дней). This covers exactly that mechanism.
test('application without date → not stalled; with WhatsApp-activity anchor → stalled', () => {
  const noDate = svc.leadFromApplication({ row: 7, legal_entity: 'ИП Тест', phone: PHONE, submitted_at: null });
  assert.strictEqual(noDate.anchor_at, null);
  assert.strictEqual(svc.assessLead(noDate, NOW), null);                                 // без якоря — не завис
  const anchored = { ...noDate, anchor_at: new Date(NOW - 10 * DAY).toISOString() };      // как проставит scan из WhatsApp
  const a = svc.assessLead(anchored, NOW);
  assert.ok(a, 'с якорем должен стать recoverable');
  assert.strictEqual(a.days_idle, 10);
});

console.log('\n[decision transitions + dedupe]');

test('approve does NOT send (→ approved); illegal transition throws', () => {
  assert.strictEqual(svc.applyDecisionTransition('pending', 'approve'), 'approved');
  assert.throws(() => svc.applyDecisionTransition('approved', 'approve'));
});

test('dedupeKey is one open recovery per lead + stage', () => {
  assert.strictEqual(svc.dedupeKey({ ref: 'order:o8' }, 'awaiting_client_approval'), 'RECOVER_LEAD|order:o8|awaiting_client_approval');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
