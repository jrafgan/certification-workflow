'use strict';

// Tests for the Draft Email Engine (services/draftEmailService) — pure layer only.
// chooseTrigger / buildLabEmailDraft / renderEmail / decision transitions. No DB.
//
// Run: node tests/draft-email.test.js

const assert = require('assert');
const svc = require('../src/services/draftEmailService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-21T12:00:00Z');

const baseLab = { laboratoryName: 'СтандартПро', laboratoryEmail: 'lab@standartpro98.gmail.com', expectedLayoutDays: 5, expectedOriginalDays: 10 };

console.log('\n[chooseTrigger]');

test('Запустить + no lab request sent → lab_request', () => {
  const order = { _id: 'o1', status: 'Запустить', laboratory: baseLab, client: { companyName: 'ОсОО Ромашка' }, lab_interactions: [] };
  const t = svc.chooseTrigger(order, NOW);
  assert.ok(t, 'trigger expected');
  assert.strictEqual(t.draft_type, 'lab_request');
});

test('Ждем макет within SLA → no trigger', () => {
  const order = { _id: 'o2', status: 'Ждем макет', laboratory: baseLab, client: {}, lab_interactions: [{ version: 1, sent_at: new Date(NOW - 2 * DAY) }] };
  assert.strictEqual(svc.chooseTrigger(order, NOW), null);
});

test('Ждем макет past SLA → lab_reminder_layout (HIGH)', () => {
  const order = { _id: 'o3', status: 'Ждем макет', laboratory: baseLab, client: { name: 'Иван' }, lab_interactions: [{ version: 2, sent_at: new Date(NOW - 9 * DAY) }] };
  const t = svc.chooseTrigger(order, NOW);
  assert.strictEqual(t.draft_type, 'lab_reminder_layout');
  assert.strictEqual(t.confidence_band, 'HIGH');
  assert.strictEqual(t.overdue_days, 9);
});

test('Ждем оригинал past explicit deadline → lab_reminder_original', () => {
  const order = { _id: 'o4', status: 'Ждем оригинал', laboratory: baseLab, client: {}, deadlines: { original_expected: new Date(NOW - 1 * DAY) }, lab_interactions: [] };
  const t = svc.chooseTrigger(order, NOW);
  assert.strictEqual(t.draft_type, 'lab_reminder_original');
});

test('no lab email → null (cannot address an email)', () => {
  const order = { _id: 'o5', status: 'Запустить', laboratory: { laboratoryName: 'X' }, client: {}, lab_interactions: [] };
  assert.strictEqual(svc.chooseTrigger(order, NOW), null);
});

test('Завершен / Отменен → null', () => {
  assert.strictEqual(svc.chooseTrigger({ _id: 'o6', status: 'Завершен', laboratory: baseLab, client: {} }, NOW), null);
  assert.strictEqual(svc.chooseTrigger({ _id: 'o7', status: 'Отменен', laboratory: baseLab, client: {} }, NOW), null);
});

console.log('\n[buildLabEmailDraft]');

test('builds a complete, addressable lab draft with the output-only contract', () => {
  const order = { _id: 'o8', status: 'Ждем макет', sheet_row_id: 'R12', laboratory: baseLab, client: { companyName: 'ОсОО Ромашка' }, lab_interactions: [{ version: 1, sent_at: new Date(NOW - 9 * DAY) }] };
  const d = svc.buildLabEmailDraft(order, svc.chooseTrigger(order, NOW));
  assert.strictEqual(d.generated, true);
  assert.strictEqual(d.to_email, baseLab.laboratoryEmail);
  assert.ok(d.subject.includes('Ромашка'));
  assert.ok(/Напоминаем/.test(d.body));
  assert.ok(/Нич(его)? не отправляется|lab-only|operator sends/i.test(d.impact));
  assert.strictEqual(d.draft_type, 'lab_reminder_layout');
});

test('no trigger → generated:false', () => {
  assert.strictEqual(svc.buildLabEmailDraft({ _id: 'o9', status: 'Завершен', laboratory: baseLab, client: {} }).generated, false);
});

console.log('\n[decision transitions]');

test('approve does NOT send (→ approved)', () => {
  assert.strictEqual(svc.applyDecisionTransition('pending_approval', 'approve'), 'approved');
});
test('request_changes → changes_requested; reject → rejected', () => {
  assert.strictEqual(svc.applyDecisionTransition('pending_approval', 'request_changes'), 'changes_requested');
  assert.strictEqual(svc.applyDecisionTransition('changes_requested', 'reject'), 'rejected');
});
test('cannot decide an already-approved draft', () => {
  assert.throws(() => svc.applyDecisionTransition('approved', 'approve'));
});

console.log('\n[dedupeKey]');
test('one open draft per order + type', () => {
  assert.strictEqual(svc.dedupeKey({ _id: 'o8' }, 'lab_reminder_layout'), 'LAB_EMAIL|o8|lab_reminder_layout');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
