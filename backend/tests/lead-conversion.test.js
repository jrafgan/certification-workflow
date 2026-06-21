'use strict';

// Tests for leadConversionService pure core — state machine, follow-up + recovery timing,
// and nextAction (the "no lead disappears silently" spine). No DB.
// Run: node tests/lead-conversion.test.js

const assert = require('assert');
const svc = require('../src/services/leadConversionService');
const templates = require('../src/services/leadReplyTemplates');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.parse('2026-06-21T12:00:00Z');

console.log('\n[state machine]');
test('new --inquiry--> educating', () => assert.strictEqual(svc.nextState('new', 'inquiry'), 'educating'));
test('educating --app_link_sent--> waiting_application', () => assert.strictEqual(svc.nextState('educating', 'app_link_sent'), 'waiting_application'));
test('waiting_application --application_detected--> waiting_calculation', () => assert.strictEqual(svc.nextState('waiting_application', 'application_detected'), 'waiting_calculation'));
test('waiting_calculation --calculation_approved--> waiting_payment', () => assert.strictEqual(svc.nextState('waiting_calculation', 'calculation_approved'), 'waiting_payment'));
test('waiting_payment --payment_detected--> transferred_whatsapp', () => assert.strictEqual(svc.nextState('waiting_payment', 'payment_detected'), 'transferred_whatsapp'));
test('waiting_application --reminders_exhausted--> dormant', () => assert.strictEqual(svc.nextState('waiting_application', 'reminders_exhausted'), 'dormant'));
test('dormant --recovery_reply--> recovered', () => assert.strictEqual(svc.nextState('dormant', 'recovery_reply'), 'recovered'));
test('illegal trigger leaves state unchanged', () => assert.strictEqual(svc.nextState('new', 'payment_detected'), 'new'));

console.log('\n[follow-up schedule — Stage 5]');
const wa = (count, hoursAgo) => ({ state: 'waiting_application', application_link_at: new Date(NOW - hoursAgo * HOUR), follow_up_count: count });
test('before 24h → not due', () => assert.deepStrictEqual(svc.followUpDue(wa(0, 10), NOW), { due: false }));
test('after 24h, 0 sent → reminder #1', () => assert.deepStrictEqual(svc.followUpDue(wa(0, 25), NOW), { due: true, reminder_no: 1 }));
test('after 72h, 1 sent → reminder #2', () => assert.deepStrictEqual(svc.followUpDue(wa(1, 80), NOW), { due: true, reminder_no: 2 }));
test('after 7d, 2 sent → reminder #3', () => assert.deepStrictEqual(svc.followUpDue(wa(2, 24 * 8), NOW), { due: true, reminder_no: 3 }));
test('all 3 sent + past 7d → exhausted (dormant)', () => assert.deepStrictEqual(svc.followUpDue(wa(3, 24 * 8), NOW), { exhausted: true }));

console.log('\n[recovery schedule — Stage 11]');
const dm = (count, daysAgo) => ({ state: 'dormant', dormant_at: new Date(NOW - daysAgo * DAY), recovery_count: count });
test('before 30d → not due', () => assert.deepStrictEqual(svc.recoveryDue(dm(0, 10), NOW), { due: false }));
test('30d, 0 done → wave 1', () => assert.deepStrictEqual(svc.recoveryDue(dm(0, 31), NOW), { due: true, wave: 1, day_marker: 30 }));
test('60d, 1 done → wave 2', () => assert.deepStrictEqual(svc.recoveryDue(dm(1, 61), NOW), { due: true, wave: 2, day_marker: 60 }));
test('90d, 2 done → wave 3', () => assert.deepStrictEqual(svc.recoveryDue(dm(2, 91), NOW), { due: true, wave: 3, day_marker: 90 }));
test('all 3 waves done → not due', () => assert.deepStrictEqual(svc.recoveryDue(dm(3, 200), NOW), { due: false }));

console.log('\n[nextAction]');
test('new → greeting (auto_allowed)', () => { const a = svc.nextAction({ state: 'new' }, NOW); assert.strictEqual(a.kind, 'greeting'); assert.strictEqual(a.auto_allowed, true); });
test('educating → application_link', () => assert.strictEqual(svc.nextAction({ state: 'educating' }, NOW).kind, 'application_link'));
test('waiting_application due → reminder', () => { const a = svc.nextAction(wa(0, 25), NOW); assert.strictEqual(a.kind, 'reminder'); assert.strictEqual(a.reminder_no, 1); });
test('waiting_application exhausted → transition dormant', () => assert.strictEqual(svc.nextAction(wa(3, 24 * 8), NOW).transition, 'reminders_exhausted'));
test('waiting_payment → payment_instructions (GATED)', () => { const a = svc.nextAction({ state: 'waiting_payment' }, NOW); assert.strictEqual(a.kind, 'payment_instructions'); assert.strictEqual(a.gated, true); });
test('dormant 30d → recovery (GATED)', () => { const a = svc.nextAction(dm(0, 31), NOW); assert.strictEqual(a.kind, 'recovery'); assert.strictEqual(a.gated, true); });
test('transferred_whatsapp → no action (done)', () => assert.strictEqual(svc.nextAction({ state: 'transferred_whatsapp' }, NOW), null));

console.log('\n[auto-allowed vs gated boundary]');
test('greeting/education/reminder/app_link/whatsapp auto-allowed', () => {
  for (const k of ['greeting', 'education', 'application_link', 'reminder', 'whatsapp_request']) assert.strictEqual(templates.isAutoAllowed(k), true, k);
});
test('calculation/payment/recovery are GATED', () => {
  for (const k of ['calculation_offer', 'payment_instructions', 'recovery']) assert.strictEqual(templates.isAutoAllowed(k), false, k);
});

console.log('\n[templates grounded in KB]');
test('education declaration mentions 15 000 / 2 недели', () => {
  const t = templates.render('education', { service_category: 'declaration', language: 'ru' });
  assert.ok(/15 000/.test(t) && /2 недел/.test(t));
});
test('education never quotes an exact final price (только "от")', () => {
  const t = templates.render('education', { service_category: 'certificate', language: 'ru' });
  assert.ok(/от 35 000/.test(t) && /подтвердит/.test(t));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
