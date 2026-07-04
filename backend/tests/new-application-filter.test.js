'use strict';

// Tests for hiding «Новые заявки» in the task inbox (taskInboxService.buildTasks):
// applications older than 30 days, already paid (Декларация col G OR WhatsApp), or refused in
// WhatsApp are stitched together from the form row + WA thread + «Декларация» and hidden.
// Also unit-covers isRefused / clientSaidPaid (must not flag legit leads).
//
// Run: node tests/new-application-filter.test.js

const assert = require('assert');
const svc = require('../src/services/taskInboxService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const NOW = Date.parse('2026-07-04T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const key = (p) => String(p).replace(/\D/g, '').slice(-9);

// Build a minimal buildTasks input with one new application + optional WA/Declaration signals.
function run({ app, wa = [], decl = {} } = {}) {
  return svc.buildTasks({ waMessages: wa, threadStates: {}, labEmails: [], newApplications: [app], declByPhone: decl, now: NOW });
}
function newApps(r) { return r.tasks.filter(t => t.kind === 'new_application'); }

const PHONE = '996700111222';
const baseApp = { sheet_row: 5, applicant: 'ИП Тест', legal_entity: null, phone: PHONE, submitted_at: daysAgo(3) };

console.log('\n[buildTasks — hide new applications]');

test('fresh application, no signals → shown', () => {
  const r = run({ app: baseApp });
  assert.strictEqual(newApps(r).length, 1);
  assert.strictEqual(r.hidden_new_applications, 0);
});

test('older than 30 days → hidden', () => {
  const r = run({ app: { ...baseApp, submitted_at: daysAgo(31) } });
  assert.strictEqual(newApps(r).length, 0);
  assert.strictEqual(r.hidden_new_applications, 1);
});

test('exactly 30 days → still shown (strict > cutoff)', () => {
  const r = run({ app: { ...baseApp, submitted_at: daysAgo(30) } });
  assert.strictEqual(newApps(r).length, 1);
});

test('paid in «Декларация» (col G) → hidden', () => {
  const r = run({ app: baseApp, decl: { [key(PHONE)]: { client: 'ИП Тест', status: 'Запустить', count: 1, paid: 15000, debt: 0 } } });
  assert.strictEqual(newApps(r).length, 0);
  assert.strictEqual(r.hidden_new_applications, 1);
});

test('client reported payment in WhatsApp → hidden', () => {
  const r = run({ app: baseApp, wa: [{ direction: 'inbound', phone_key: key(PHONE), body: 'Оплатила, вот чек', received_at: daysAgo(1) }] });
  assert.strictEqual(newApps(r).length, 0);
});

test('client refused in WhatsApp → hidden', () => {
  const r = run({ app: baseApp, wa: [{ direction: 'inbound', phone_key: key(PHONE), body: 'Спасибо, передумал, сделаю в другом месте', received_at: daysAgo(1) }] });
  assert.strictEqual(newApps(r).length, 0);
});

test('outbound-only refusal-looking text does NOT hide (only client messages count)', () => {
  const r = run({ app: baseApp, wa: [{ direction: 'outbound', phone_key: key(PHONE), body: 'вы передумали?', received_at: daysAgo(1) }] });
  assert.strictEqual(newApps(r).length, 1);
});

test('semantic refusal key (LLM-provided) → hidden even without a regex match', () => {
  const r = svc.buildTasks({ waMessages: [], threadStates: {}, labEmails: [], newApplications: [baseApp], declByPhone: {}, semanticRefusedKeys: new Set([key(PHONE)]), now: NOW });
  assert.strictEqual(newApps(r).length, 0);
  assert.strictEqual(r.hidden_new_applications, 1);
});

console.log('\n[isRefused / clientSaidPaid]');

test('isRefused: clear declines', () => {
  ['передумал', 'я отказываюсь', 'нашли дешевле, сделали в другом месте', 'уже оформили', 'спасибо, не надо', 'не актуально', 'кереги жок'].forEach(t =>
    assert.ok(svc.isRefused(t), `should flag: ${t}`));
});

test('isRefused: does NOT flag legit leads / questions', () => {
  ['Здравствуйте, сколько стоит сертификат?', 'какие документы нужны?', 'хочу оформить декларацию', 'отказное письмо надо'].forEach(t =>
    assert.ok(!svc.isRefused(t), `should NOT flag: ${t}`));
});

test('clientSaidPaid: payment phrases', () => {
  ['оплатил', 'перевела деньги', 'вот чек', 'квитанция во вложении'].forEach(t =>
    assert.ok(svc.clientSaidPaid(t), `should flag paid: ${t}`));
  assert.ok(!svc.clientSaidPaid('сколько стоит оплата?'.replace('оплата', 'цена')), 'question not paid');
});

console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`\n✗ ${f.name}\n${f.err.stack}`); process.exit(1); }
