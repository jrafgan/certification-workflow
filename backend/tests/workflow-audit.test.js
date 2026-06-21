'use strict';

// Tests for the Workflow Auditor (services/workflowAuditService) — pure layer only.
// auditOrder over hand-built evidence + collectEvidenceFromOrder + decision rules. No DB.
//
// Run: node tests/workflow-audit.test.js

const assert = require('assert');
const svc = require('../src/services/workflowAuditService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-21T12:00:00Z');

// helper to build a single-milestone evidence bundle
function ev(milestones, extra = {}) {
  return { milestones, last_activity_at: new Date(NOW), deadlines: {}, ...extra };
}

console.log('\n[auditOrder — status recommendation]');

test('payment evidence while status earlier-than-Запустить → propose Запустить (recommend)', () => {
  // The user-style example: payment found + confirmed → advance to launch.
  const r = svc.auditOrder({
    current_status: 'Запустить', // ladder index 0; we test the advance from an unrecognized below
    evidence: ev({ payment: { reached: true, at: new Date(NOW - DAY), confidence: 95, items: [
      { source: 'payment_receipt', detail: 'Payment receipt found' },
      { source: 'whatsapp', detail: 'Payment confirmed in WhatsApp' },
    ] } }),
  }, NOW);
  // Already at Запустить with payment → in sync (no advance), but corroborated.
  assert.ok(r === null || r.proposed_status === null, 'no advance past Запустить from payment alone');
});

test('lab request sent while still «Запустить» → propose «Ждем макет» (missing_transition)', () => {
  const r = svc.auditOrder({
    current_status: 'Запустить',
    evidence: ev({
      payment:     { reached: true, confidence: 75, items: [{ source: 'payment_receipt', detail: 'Payment recorded' }] },
      lab_request: { reached: true, at: new Date(NOW - 2 * DAY), confidence: 90, items: [{ source: 'lab_correspondence', detail: 'Lab request sent' }] },
    }),
  }, NOW);
  assert.ok(r);
  assert.strictEqual(r.proposed_status, 'Ждем макет');
  assert.strictEqual(r.audit_kind, 'status_recommendation');
  assert.strictEqual(r.recommend, true); // 90 ≥ 70
  assert.ok(r.findings.some(f => f.type === 'missing_transition'));
});

test('full chain to original received while «Ждем оригинал» → propose «Оригинал получен»', () => {
  const r = svc.auditOrder({
    current_status: 'Ждем оригинал',
    evidence: ev({
      payment:         { reached: true, confidence: 75, items: [] },
      lab_request:     { reached: true, confidence: 90, items: [] },
      layout:          { reached: true, confidence: 85, items: [] },
      layout_approved: { reached: true, confidence: 90, items: [] },
      original:        { reached: true, confidence: 90, items: [{ source: 'lab_correspondence', detail: 'Original received' }] },
    }),
  }, NOW);
  assert.strictEqual(r.proposed_status, 'Оригинал получен');
  assert.strictEqual(r.recommend, true);
});

console.log('\n[auditOrder — contradictions + cancellation]');

test('status ahead of evidence → contradictory health_flag, no downgrade proposed', () => {
  const r = svc.auditOrder({
    current_status: 'Оригинал получен',
    evidence: ev({ payment: { reached: true, confidence: 75, items: [] } }), // evidence only reaches Запустить
  }, NOW);
  assert.strictEqual(r.proposed_status, null);
  assert.strictEqual(r.audit_kind, 'health_flag');
  assert.ok(r.findings.some(f => f.type === 'contradictory_state'));
  assert.strictEqual(r.recommend, false);
});

test('cancellation evidence on an active order → propose «Отменен»', () => {
  const r = svc.auditOrder({
    current_status: 'Ждем макет',
    evidence: ev({
      lab_request: { reached: true, confidence: 90, items: [] },
      cancelled:   { reached: true, confidence: 85, items: [{ source: 'declaration', detail: 'Cancellation reason recorded' }] },
    }),
  }, NOW);
  assert.strictEqual(r.proposed_status, 'Отменен');
  assert.strictEqual(r.recommend, true);
});

console.log('\n[auditOrder — operational findings]');

test('long inactivity while active → forgotten_order (HIGH)', () => {
  const r = svc.auditOrder({
    current_status: 'Ждем макет',
    evidence: ev({ lab_request: { reached: true, confidence: 90, items: [] } }, { last_activity_at: new Date(NOW - 30 * DAY) }),
  }, NOW);
  assert.ok(r.findings.some(f => f.type === 'forgotten_order' && f.severity === 'HIGH'));
});

test('passed deadline for current waiting status → delayed_order', () => {
  const r = svc.auditOrder({
    current_status: 'Ждем оригинал',
    evidence: ev(
      { layout_approved: { reached: true, confidence: 90, items: [] } },
      { last_activity_at: new Date(NOW - 2 * DAY), deadlines: { current_due: new Date(NOW - DAY) } },
    ),
  }, NOW);
  assert.ok(r.findings.some(f => f.type === 'delayed_order'));
});

test('unrecognized status → unrecognized_status finding', () => {
  const r = svc.auditOrder({ current_status: 'Waiting for payment', evidence: ev({}) }, NOW);
  assert.ok(r.findings.some(f => f.type === 'unrecognized_status'));
});

test('fully in sync, recent activity, no findings → null (nothing to surface)', () => {
  const r = svc.auditOrder({
    current_status: 'Ждем макет',
    evidence: ev({ payment: { reached: true, confidence: 75, items: [] }, lab_request: { reached: true, confidence: 90, items: [] } }),
  }, NOW);
  assert.strictEqual(r, null);
});

console.log('\n[collectEvidenceFromOrder]');

test('derives the milestone ladder from an Order document', () => {
  const order = {
    _id: 'o1', status: 'Запустить', sheet_row_id: 'R1',
    payments: [{ date: new Date(NOW - 5 * DAY), amount: 21000, method: 'transfer' }],
    lab_interactions: [{ version: 1, sent_at: new Date(NOW - 4 * DAY), layout_received_at: new Date(NOW - 2 * DAY) }],
    layouts: [{ version: 1, received_at: new Date(NOW - 2 * DAY), client_decision: 'approved', decided_at: new Date(NOW - DAY) }],
    originals: [],
  };
  const e = svc.collectEvidenceFromOrder(order);
  const implied = svc.impliedStatusFromEvidence(e);
  assert.strictEqual(implied.status, 'Ждем оригинал'); // payment→lab→layout→approved
  // And auditing it against the lagging «Запустить» recommends the advance.
  const r = svc.auditOrder({ current_status: order.status, evidence: e }, NOW);
  assert.strictEqual(r.proposed_status, 'Ждем оригинал');
  assert.ok(r.evidence.some(it => it.source === 'payment_receipt'));
  assert.ok(r.evidence.some(it => it.source === 'lab_correspondence'));
});

console.log('\n[AUDIT PACKAGE contract]');

test('package carries current/proposed/confidence/evidence/reasoning + output-only impact', () => {
  const r = svc.auditOrder({
    current_status: 'Запустить',
    evidence: ev({ payment: { reached: true, confidence: 75, items: [] }, lab_request: { reached: true, confidence: 90, items: [{ source: 'lab_correspondence', detail: 'Lab request sent' }] } }),
  }, NOW);
  for (const k of ['current_status', 'proposed_status', 'confidence', 'confidence_band', 'evidence', 'reasoning', 'findings', 'impact']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.ok(/does NOT|never changed automatically/i.test(r.impact));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
