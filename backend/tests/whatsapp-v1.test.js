'use strict';

// Pure unit tests for WhatsApp Agent V1 (Sprint 1).
// Covers: phone normalization/matching, phone→order ranking (one phone → many
// orders), draft-package contract, and the operator-decision state machine.
// No DB / no network — all logic under test is pure.
//
// Run: node tests/whatsapp-v1.test.js   (or: npm run test:whatsapp)

const assert = require('assert');

const phone = require('../src/utils/phoneUtils');
const { rankByPhone } = require('../src/services/whatsappMatchService');
const { applyDecisionTransition, buildDraftPackage } = require('../src/services/whatsappDraftService');

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// ─── Phone normalization & matching ──────────────────────────────────────────

test('normalizeLocal strips +996 / 996 / leading 0', () => {
  assert.strictEqual(phone.normalizeLocal('+996777240858'), '777240858');
  assert.strictEqual(phone.normalizeLocal('996777240858'), '777240858');
  assert.strictEqual(phone.normalizeLocal('0777240858'), '777240858');
  assert.strictEqual(phone.normalizeLocal('777240858'), '777240858');
  assert.strictEqual(phone.normalizeLocal('+996 777 240 858'), '777240858');
});

test('shortened and full forms match (BAC-2)', () => {
  assert.strictEqual(phone.phonesMatch('777240858', '+996777240858'), true);
  assert.strictEqual(phone.phonesMatch('705973505', '996705973505'), true);
  assert.strictEqual(phone.phonesMatch('0705973505', '+996705973505'), true);
});

test('different numbers do not match', () => {
  assert.strictEqual(phone.phonesMatch('777240858', '777240859'), false);
  assert.strictEqual(phone.phonesMatch('700000001', '700000002'), false);
});

test('too-short / empty numbers never match (min-digits guard, TAC-2)', () => {
  assert.strictEqual(phone.matchKey('12345'), '');      // < 7 digits
  assert.strictEqual(phone.phonesMatch('123', '123'), false);
  assert.strictEqual(phone.phonesMatch('', ''), false);
  assert.strictEqual(phone.phonesMatch('777240858', ''), false);
});

// ─── Phone → order ranking (one phone → many orders) ─────────────────────────

const DECLS = [
  { _id: 'd1', order_id: 'o1', sheet_row_id: '150', client_name: 'ИП Парманова Кенжегул', phone: '0777240858', status: 'завершен' },
  { _id: 'd2', order_id: 'o2', sheet_row_id: '320', client_name: 'ИП Парманова Кенжегул', phone: '+996777240858', status: 'ждем макет' },
  { _id: 'd3', order_id: 'o3', sheet_row_id: '500', client_name: 'ОсОО BACCI',           phone: '700111222',     status: 'на согласовании' },
];

test('unique phone match → matched / HIGH (TAC-3)', () => {
  const r = rankByPhone('+996700111222', DECLS);
  assert.strictEqual(r.match_status, 'matched');
  assert.strictEqual(r.match_confidence, 'HIGH');
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].sheet_row_id, '500');
});

test('phone shared by many orders → needs_review, full candidate set (BAC-3)', () => {
  const r = rankByPhone('777240858', DECLS); // matches d1 and d2 (same client, 2 orders)
  assert.strictEqual(r.match_status, 'needs_review');
  assert.strictEqual(r.candidates.length, 2);
  // never auto-assigns a single order
  assert.ok(/2_orders/.test(r.reason));
});

test('no candidate → unmatched', () => {
  const r = rankByPhone('700999999', DECLS);
  assert.strictEqual(r.match_status, 'unmatched');
  assert.strictEqual(r.candidates.length, 0);
});

test('too-short inbound phone → unmatched (never broad-matches)', () => {
  const r = rankByPhone('123', DECLS);
  assert.strictEqual(r.match_status, 'unmatched');
});

// ─── Draft package contract ──────────────────────────────────────────────────

const MATCH = { order_id: 'o2', declaration_id: 'd2', sheet_row_id: '320', client_name: 'ИП Парманова Кенжегул', to_phone: '+996777240858', match_confidence: 'HIGH' };

test('buildDraftPackage enforces reason/evidence/impact + binding', () => {
  const pkg = buildDraftPackage({
    match: MATCH, draft_type: 'missing_info', proposed_text: 'Здравствуйте! Пришлите, пожалуйста, свидетельство ИП.',
    reason: 'Application is missing the IP registration certificate.',
    evidence: [{ kind: 'missing_field', ref: 'ip_registration', detail: 'not attached' }],
    impact: 'A WhatsApp message will be sent to the client after your approval. No status change.',
  });
  assert.strictEqual(pkg.state, 'pending_approval');
  assert.strictEqual(pkg.order_id, 'o2');
  assert.strictEqual(pkg.draft_type, 'missing_info');
  assert.ok(pkg.reason && pkg.impact && pkg.evidence.length === 1);
  assert.strictEqual(pkg.match_confidence, 'HIGH');
});

test('buildDraftPackage rejects unbound / incomplete packages', () => {
  assert.throws(() => buildDraftPackage({ match: {}, draft_type: 'answer', proposed_text: 'x', reason: 'r', impact: 'i' }));
  assert.throws(() => buildDraftPackage({ match: MATCH, draft_type: 'answer', proposed_text: 'x', reason: 'r' /* no impact */ }));
  assert.throws(() => buildDraftPackage({ match: MATCH, draft_type: 'answer', reason: 'r', impact: 'i' /* no text */ }));
});

// ─── Operator decision state machine ─────────────────────────────────────────

test('approve does NOT send — moves to approved only (BAC-5/TAC-4)', () => {
  assert.strictEqual(applyDecisionTransition('pending_approval', 'approve'), 'approved');
});

test('reject → rejected; request_changes → changes_requested', () => {
  assert.strictEqual(applyDecisionTransition('pending_approval', 'reject'), 'rejected');
  assert.strictEqual(applyDecisionTransition('pending_approval', 'request_changes'), 'changes_requested');
  // a changes_requested draft can be decided again after revision
  assert.strictEqual(applyDecisionTransition('changes_requested', 'approve'), 'approved');
});

test('cannot decide an already-approved/rejected/sent draft', () => {
  assert.throws(() => applyDecisionTransition('approved', 'approve'));
  assert.throws(() => applyDecisionTransition('rejected', 'approve'));
  assert.throws(() => applyDecisionTransition('sent', 'reject'));
});

test('unknown decision is rejected', () => {
  assert.throws(() => applyDecisionTransition('pending_approval', 'send'));
  assert.throws(() => applyDecisionTransition('pending_approval', 'auto_approve'));
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nWhatsApp V1 (Sprint 1): ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(` - ${f.name}: ${f.err.message}`)); process.exit(1); }
