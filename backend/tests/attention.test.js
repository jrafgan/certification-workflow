'use strict';

// Tests for the Attention/Critical-Issues + Order-Timeline pure logic
// (controlCenterService.orderDangers / orderTimelineSteps). No DB.
// Run: node tests/attention.test.js

const assert = require('assert');
const cc = require('../src/services/controlCenterService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-21T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY);

console.log('\n[orderDangers — critical issues]');

test('paid but not launched → HIGH', () => {
  const r = cc.orderDangers({ _id: 'o1', status: 'Запустить', client: { name: 'Иван' }, payments: [{ amount: 15000 }], lab_interactions: [], updated_at: ago(3) }, NOW);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'paid_not_launched');
  assert.strictEqual(r[0].severity, 'HIGH');
});

test('lab overdue (layout past SLA) → HIGH', () => {
  const r = cc.orderDangers({ _id: 'o2', status: 'Ждем макет', client: {}, laboratory: { expectedLayoutDays: 5 }, lab_interactions: [{ sent_at: ago(9) }] }, NOW);
  assert.strictEqual(r[0].type, 'lab_overdue');
});

test('original overdue (past explicit deadline) → HIGH', () => {
  const r = cc.orderDangers({ _id: 'o3', status: 'Ждем оригинал', client: {}, deadlines: { original_expected: ago(2) }, lab_interactions: [] }, NOW);
  assert.strictEqual(r[0].type, 'original_overdue');
});

test('approval overdue (client not responding) → MEDIUM', () => {
  const r = cc.orderDangers({ _id: 'o4', status: 'На согласовании', client: {}, layouts: [{ sent_to_client_at: ago(6) }] }, NOW);
  assert.strictEqual(r[0].type, 'approval_overdue');
});

test('client approved → no approval danger', () => {
  const r = cc.orderDangers({ _id: 'o5', status: 'На согласовании', client: {}, layouts: [{ sent_to_client_at: ago(10), client_decision: 'approved' }] }, NOW);
  assert.ok(!r.some(x => x.type === 'approval_overdue'));
});

test('healthy recent order → no danger', () => {
  const r = cc.orderDangers({ _id: 'o6', status: 'Ждем макет', client: {}, laboratory: { expectedLayoutDays: 5 }, lab_interactions: [{ sent_at: ago(2) }] }, NOW);
  assert.strictEqual(r.length, 0);
});

test('long-idle active order with no specific danger → generic flag', () => {
  const r = cc.orderDangers({ _id: 'o7', status: 'Оригинал получен', client: {}, updated_at: ago(20) }, NOW);
  assert.strictEqual(r[0].type, 'client_waiting_long');
});

test('Завершен with outstanding debt → completed_with_debt (HIGH)', () => {
  const r = cc.orderDangers({ _id: 'o8', status: 'Завершен', client: { name: 'Иван' }, balance_due: 6000, originals: [{ sent_to_client_at: ago(1) }] }, NOW);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'completed_with_debt');
  assert.strictEqual(r[0].severity, 'HIGH');
});

test('Завершен with no recorded delivery → completed_not_delivered (HIGH)', () => {
  const r = cc.orderDangers({ _id: 'o9', status: 'Завершен', client: {}, balance_due: 0, originals: [{ received_at: ago(2) }] }, NOW);
  assert.strictEqual(r[0].type, 'completed_not_delivered');
  assert.strictEqual(r[0].severity, 'HIGH');
});

test('Завершен, no debt, delivered → no danger', () => {
  const r = cc.orderDangers({ _id: 'o10', status: 'Завершен', client: {}, balance_due: 0, originals: [{ sent_to_client_at: ago(1) }] }, NOW);
  assert.strictEqual(r.length, 0);
});

console.log('\n[orderTimelineSteps]');

test('6 steps in order with correct labels', () => {
  const s = cc.orderTimelineSteps({ status: 'Запустить', payments: [{ amount: 1 }] });
  assert.deepStrictEqual(s.map(x => x.key), ['application', 'payment', 'lab', 'approval', 'original', 'complete']);
  assert.strictEqual(s[0].label, 'Заявка');
  assert.strictEqual(s[5].label, 'Завершено');
});

test('Ждем оригинал → application/payment/lab/approval done, original current', () => {
  const s = cc.orderTimelineSteps({ status: 'Ждем оригинал', payments: [{ amount: 1 }], lab_interactions: [{ sent_at: new Date() }] });
  const by = Object.fromEntries(s.map(x => [x.key, x.state]));
  assert.strictEqual(by.application, 'done');
  assert.strictEqual(by.payment, 'done');
  assert.strictEqual(by.lab, 'done');
  assert.strictEqual(by.approval, 'done');
  assert.strictEqual(by.original, 'current');
  assert.strictEqual(by.complete, 'pending');
});

test('Завершен → all done', () => {
  const s = cc.orderTimelineSteps({ status: 'Завершен', payments: [{ amount: 1 }] });
  assert.ok(s.every(x => x.state === 'done'));
});

test('Запустить → application+payment done, lab current', () => {
  const s = cc.orderTimelineSteps({ status: 'Запустить', payments: [{ amount: 1 }] });
  const by = Object.fromEntries(s.map(x => [x.key, x.state]));
  assert.strictEqual(by.payment, 'done');
  assert.strictEqual(by.lab, 'current');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
