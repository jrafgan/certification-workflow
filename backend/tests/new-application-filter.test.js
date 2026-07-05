'use strict';

// Tests for classifyApplication (taskInboxService) — «новая заявка или нет» per the operator's
// 2026-07-04 rules, in priority order: (1) in «Декларация» → оформляется; (2) paid; (3) refused;
// (4) not responding (>30d after OUR last message, no reply since); (7) never replied → SHOW +
// send-offer (NOT hidden); (5) offer already sent, client engaging → stays new; else → send offer.
// Plus a couple of buildTasks integration checks + weSentCalc.
//
// Run: node tests/new-application-filter.test.js

const assert = require('assert');
const svc = require('../src/services/taskInboxService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DAY = 86400000;
const NOW = Date.parse('2026-07-04T12:00:00Z');
const daysAgo = (d) => NOW - d * DAY;
const cls = (sig, decl = null) => svc.classifyApplication(sig, decl, { now: NOW });

console.log('\n[classifyApplication — priority rules]');

test('1) in «Декларация» → not new (оформляется)', () => {
  const r = cls({ inboundTexts: ['передумали'] }, { status: 'Запустить', paid: 0 });   // beats refuse
  assert.strictEqual(r.isNew, false);
  assert.ok(/оформляется/i.test(r.reason));
});

test('2) client said paid → not new', () => {
  const r = cls({ inboundTexts: ['оплатила, вот чек'] }, null);
  assert.strictEqual(r.isNew, false);
  assert.ok(/оплатил/i.test(r.reason));
});

test('3) refused (regex or semantic) → not new', () => {
  assert.strictEqual(cls({ inboundTexts: ['спасибо, передумали'] }, null).isNew, false);
  assert.strictEqual(cls({ semanticRefused: true, inboundTexts: ['ну не знаю…'] }, null).isNew, false);
});

test('4) not responding: we wrote, >30d since our last, no reply since → not new', () => {
  const r = cls({ hasOutbound: true, lastOutboundAt: daysAgo(40), lastInboundAt: daysAgo(45) }, null);
  assert.strictEqual(r.isNew, false);
  assert.ok(/не отвечает/i.test(r.reason));
});

test('4-neg) client replied AFTER our message → still new (not "not responding")', () => {
  const r = cls({ hasOutbound: true, lastOutboundAt: daysAgo(40), lastInboundAt: daysAgo(35), offerSent: true }, null);
  assert.strictEqual(r.isNew, true);
});

test('7) we NEVER replied, creation date UNKNOWN → new, send offer, NOT hidden', () => {
  const r = cls({ hasOutbound: false, lastInboundAt: daysAgo(60) }, null);   // no ageDays → age rule N/A
  assert.strictEqual(r.isNew, true);
  assert.strictEqual(r.needs_calc_reply, true);
  assert.ok(/ни разу не ответил/i.test(r.reason));
  assert.ok(r.recommended_action);
});

test('5) offer already sent, client recently active → new, calc already sent', () => {
  const r = cls({ hasOutbound: true, lastOutboundAt: daysAgo(5), lastInboundAt: daysAgo(3), offerSent: true }, null);
  assert.strictEqual(r.isNew, true);
  assert.strictEqual(r.needs_calc_reply, false);
});

test('default) we wrote but no offer, still in dialog → new, propose sending the offer', () => {
  const r = cls({ hasOutbound: true, lastOutboundAt: daysAgo(5), lastInboundAt: daysAgo(6), offerSent: false }, null);
  assert.strictEqual(r.isNew, true);
  assert.strictEqual(r.needs_calc_reply, true);
  assert.ok(/не отправляли стоимость/i.test(r.reason));
});

test('fresh, no WhatsApp at all → new, send offer', () => {
  const r = cls({}, null);
  assert.strictEqual(r.isNew, true);
  assert.strictEqual(r.needs_calc_reply, true);
});

// Rule №6 (priority): age >50 days is a BACKSTOP — applies only after the behavioural checks and
// only when the creation date is known (opts.ageDays). It never decides alone.
const clsAge = (sig, ageDays, decl = null) => svc.classifyApplication(sig, decl, { now: NOW, ageDays });

test('6) engaged, no offer, created >50d ago, client silent → old (backstop hides it)', () => {
  const r = clsAge({ hasOutbound: true, lastOutboundAt: daysAgo(10), lastInboundAt: daysAgo(40), offerSent: false }, 55);
  assert.strictEqual(r.isNew, false);
  assert.ok(/старше 50 дней/i.test(r.reason));
});

test('6-active) old (>50d) EVEN IF client wrote recently → HIDDEN (hard cutoff; guard removed 2026-07-05 вечер)', () => {
  // The active client is NOT lost — they still surface as a WhatsApp thread; we just drop the
  // duplicate stale «new application» card. Operator asked for a hard age cutoff.
  const r = clsAge({ hasOutbound: true, lastOutboundAt: daysAgo(10), lastInboundAt: daysAgo(3), offerSent: false }, 55);
  assert.strictEqual(r.isNew, false);
  assert.ok(/старше 50 дней/i.test(r.reason));
});

test('6-neg) engaged, no offer, created ≤50d ago → still new (propose the offer)', () => {
  const r = clsAge({ hasOutbound: true, lastOutboundAt: daysAgo(3), lastInboundAt: daysAgo(2), offerSent: false }, 40);
  assert.strictEqual(r.isNew, true);
  assert.ok(/не отправляли стоимость/i.test(r.reason));
});

test('6-guard) never replied + created >50d ago → HIDDEN (operator 2026-07-05: age beats rule 7)', () => {
  const r = clsAge({ hasOutbound: false, lastInboundAt: daysAgo(70) }, 70);
  assert.strictEqual(r.isNew, false);
  assert.ok(/старше 50 дней/i.test(r.reason));
});

test('6-guard-active) never replied + old (>50d) even if client wrote within 14d → HIDDEN (hard cutoff)', () => {
  const r = clsAge({ hasOutbound: false, lastInboundAt: daysAgo(5) }, 70);
  assert.strictEqual(r.isNew, false);
  assert.ok(/старше 50 дней/i.test(r.reason));
});

test('6-noDate) engaged, no offer, creation date UNKNOWN → age not applied, stays new', () => {
  const r = clsAge({ hasOutbound: true, lastOutboundAt: daysAgo(10), lastInboundAt: daysAgo(9), offerSent: false }, null);
  assert.strictEqual(r.isNew, true);
});

test('6-offer) age backstop wins over «offer already sent» → old app HIDDEN (hard cutoff)', () => {
  // Age is checked before the offer rule: >50d is hidden even if we already sent a quote.
  const r = clsAge({ hasOutbound: true, lastOutboundAt: daysAgo(10), lastInboundAt: daysAgo(9), offerSent: true }, 60);
  assert.strictEqual(r.isNew, false);
  assert.ok(/старше 50 дней/i.test(r.reason));
});

console.log('\n[buildTasks integration]');
const PHONE = '996700111222';
const PK = PHONE.slice(-9);
const app = { sheet_row: 5, applicant: 'ИП Тест', phone: PHONE };
const sig = (o) => new Map([[PK, Object.assign({ lastInboundAt: null, lastOutboundAt: null, hasOutbound: false, offerSent: false, inboundTexts: [] }, o)]]);
const runNA = (signals, decl = {}) => svc.buildTasks({ waMessages: [], threadStates: {}, labEmails: [], newApplications: [app], declByPhone: decl, waSignalsByKey: signals, now: NOW }).tasks.filter(t => t.kind === 'new_application');

test('not-responding application → hidden from list', () => {
  assert.strictEqual(runNA(sig({ hasOutbound: true, lastOutboundAt: daysAgo(40), lastInboundAt: daysAgo(45) })).length, 0);
});

test('never-replied application → shown with needs_calc_reply', () => {
  const na = runNA(sig({ hasOutbound: false, lastInboundAt: daysAgo(60) }));
  assert.strictEqual(na.length, 1);
  assert.strictEqual(na[0].needs_calc_reply, true);
  assert.ok(na[0].recommended_action);
});

test('old application (submitted >50d ago) we engaged but never quoted → hidden by age backstop', () => {
  const oldApp = { sheet_row: 6, applicant: 'ИП Старый', phone: PHONE, submitted_at: new Date(daysAgo(55)).toISOString() };
  const signals = sig({ hasOutbound: true, lastOutboundAt: daysAgo(20), lastInboundAt: daysAgo(21), offerSent: false });
  const na = svc.buildTasks({ waMessages: [], threadStates: {}, labEmails: [], newApplications: [oldApp], declByPhone: {}, waSignalsByKey: signals, now: NOW }).tasks.filter(t => t.kind === 'new_application');
  assert.strictEqual(na.length, 0);
});

console.log('\n[weSentCalc]');

test('weSentCalc: detects a quote / offer we sent', () => {
  ['Итого 35 000 сом за 2 протокола', 'стоимость составит 18000 сом', 'выставил счёт на оплату', 'высылаю коммерческое предложение'].forEach(t =>
    assert.ok(svc.weSentCalc(t), `should detect offer: ${t}`));
});

test('weSentCalc: plain chat is not an offer', () => {
  ['Здравствуйте!', 'пришлите состав ткани', 'спасибо'].forEach(t =>
    assert.ok(!svc.weSentCalc(t), `should NOT detect: ${t}`));
});

console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.error(`\n✗ ${f.name}\n${f.err.stack}`); process.exit(1); }
