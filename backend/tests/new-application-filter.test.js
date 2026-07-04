'use strict';

// Tests for the «Новые заявки» decision table in taskInboxService.buildTasks (per operator
// 2026-07-04). An application is HIDDEN (old) when: in «Декларация» / paid; refused (regex or
// semantic); we sent the calc and the client is silent > SILENCE_AFTER_CALC days; or > ABANDONED
// days since the client's last message AND we never replied. Otherwise SHOWN, with
// needs_calc_reply = we haven't sent the calc yet. Also unit-covers weSentCalc.
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
const key = (p) => String(p).replace(/\D/g, '').slice(-9);
const daysAgoMs = (d) => NOW - d * 86400000;
const PHONE = '996700111222';
const PK = key(PHONE);
const baseApp = { sheet_row: 5, applicant: 'ИП Тест', phone: PHONE, submitted_at: null };

// run({ app, wa, decl, signals }) → buildTasks result
function run({ app = baseApp, wa = [], decl = {}, signals = null } = {}) {
  return svc.buildTasks({
    waMessages: wa, threadStates: {}, labEmails: [], newApplications: [app],
    declByPhone: decl, waSignalsByKey: signals, now: NOW,
  });
}
const newApps = (r) => r.tasks.filter(t => t.kind === 'new_application');
const sig = (o) => new Map([[PK, Object.assign({ lastInboundAt: null, hasOutbound: false, sentCalc: false, inboundTexts: [] }, o)]]);

console.log('\n[decision table — hide vs show]');

test('fresh, no WhatsApp yet, not in Declaration → shown, needs_calc_reply', () => {
  const r = run({});
  assert.strictEqual(newApps(r).length, 1);
  assert.strictEqual(newApps(r)[0].needs_calc_reply, true);
});

test('in «Декларация» → hidden', () => {
  const r = run({ decl: { [PK]: { client: 'ИП Тест', status: 'Запустить', count: 1, paid: 0, debt: 0 } } });
  assert.strictEqual(newApps(r).length, 0);
  assert.strictEqual(r.hidden_new_applications, 1);
});

test('client reported payment in WhatsApp → hidden', () => {
  const r = run({ wa: [{ direction: 'inbound', phone_key: PK, body: 'Оплатила, вот чек', received_at: daysAgoMs(1) }] });
  assert.strictEqual(newApps(r).length, 0);
});

test('client refused in WhatsApp → hidden', () => {
  const r = run({ wa: [{ direction: 'inbound', phone_key: PK, body: 'Спасибо, передумали', received_at: daysAgoMs(1) }] });
  assert.strictEqual(newApps(r).length, 0);
});

test('semantic refusal key (LLM-provided) → hidden', () => {
  const r = svc.buildTasks({ waMessages: [], threadStates: {}, labEmails: [], newApplications: [baseApp], declByPhone: {}, semanticRefusedKeys: new Set([PK]), now: NOW });
  assert.strictEqual(newApps(r).length, 0);
});

test('abandoned: >50 days since client wrote AND we never replied → hidden', () => {
  const r = run({ signals: sig({ lastInboundAt: daysAgoMs(60), hasOutbound: false }) });
  assert.strictEqual(newApps(r).length, 0);
  assert.strictEqual(r.hidden_new_applications, 1);
});

test('>50 days but WE replied (no calc) → shown, needs_calc_reply', () => {
  const r = run({ signals: sig({ lastInboundAt: daysAgoMs(60), hasOutbound: true, sentCalc: false }) });
  assert.strictEqual(newApps(r).length, 1);
  assert.strictEqual(newApps(r)[0].needs_calc_reply, true);
});

test('sent calc + client silent >14 days → hidden', () => {
  const r = run({ signals: sig({ lastInboundAt: daysAgoMs(20), hasOutbound: true, sentCalc: true }) });
  assert.strictEqual(newApps(r).length, 0);
});

test('sent calc + client active recently (<14d) → shown, calc already sent', () => {
  const r = run({ signals: sig({ lastInboundAt: daysAgoMs(5), hasOutbound: true, sentCalc: true }) });
  assert.strictEqual(newApps(r).length, 1);
  assert.strictEqual(newApps(r)[0].needs_calc_reply, false);
});

console.log('\n[weSentCalc]');

test('weSentCalc: detects a quote we sent', () => {
  ['Итого 35 000 сом за 2 протокола', 'стоимость составит 18000 сом', 'по вашему товару 3 протокола, к оплате 45 000'].forEach(t =>
    assert.ok(svc.weSentCalc(t), `should detect calc: ${t}`));
});

test('weSentCalc: plain chat is not a calc', () => {
  ['Здравствуйте!', 'пришлите состав ткани', 'спасибо'].forEach(t =>
    assert.ok(!svc.weSentCalc(t), `should NOT detect calc: ${t}`));
});

console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`\n✗ ${f.name}\n${f.err.stack}`); process.exit(1); }
