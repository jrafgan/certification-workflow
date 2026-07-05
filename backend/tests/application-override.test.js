'use strict';

// Tests for the operator's manual «не новая» override + the form-date parser.
//   • parseFormDate — Google-Forms «ДД.ММ.ГГГГ ЧЧ:ММ:СС» + ISO + junk rejection.
//   • appKeyFor — phone → match key; no phone but row → `row:<n>`; neither → null.
//   • buildTasks — an application with a not_new override is HIDDEN (operator beats the agent).
//   • markApplication / reopenApplication — DB-backed with STUBBED model (no real DB).
//
// Run: node tests/application-override.test.js

const assert = require('assert');
const svc = require('../src/services/taskInboxService');
const { parseFormDate } = require('../src/integrations/newApplicationsClient');

let pass = 0, fail = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const DAY = 86400000;
const NOW = Date.parse('2026-07-05T12:00:00Z');
const PHONE = '+996700111222';

// ── parseFormDate ──
test('parseFormDate: ДД.ММ.ГГГГ ЧЧ:ММ:СС', () => {
  const d = parseFormDate('10.01.2026 13:09:36');
  assert.ok(d instanceof Date && d.getFullYear() === 2026 && d.getMonth() === 0 && d.getDate() === 10);
});
test('parseFormDate: ДД.ММ.ГГГГ без времени', () => {
  const d = parseFormDate('01.03.2026');
  assert.ok(d && d.getMonth() === 2 && d.getDate() === 1);
});
test('parseFormDate: ISO', () => {
  assert.ok(parseFormDate('2026-01-10T13:09:36Z') instanceof Date);
});
test('parseFormDate: junk (name/phone/empty) → null', () => {
  assert.strictEqual(parseFormDate('Иванов Максим'), null);
  assert.strictEqual(parseFormDate('996555'), null);
  assert.strictEqual(parseFormDate(''), null);
  assert.strictEqual(parseFormDate(null), null);
});

// ── appKeyFor ──
test('appKeyFor: phone → canonical match key', () => {
  const k = svc.appKeyFor({ phone: PHONE });
  assert.ok(k && k.length && !k.startsWith('row:'));
});
test('appKeyFor: no phone but row → row:<n>', () => {
  assert.strictEqual(svc.appKeyFor({ sheet_row: 42 }), 'row:42');
});
test('appKeyFor: neither → null', () => {
  assert.strictEqual(svc.appKeyFor({}), null);
});

// ── buildTasks: override hides the application ──
const baseApp = { sheet_row: 5, applicant: 'ИП Тест', phone: PHONE, submitted_at: new Date(NOW - 3 * DAY).toISOString() };
const signals = new Map([[require('../src/utils/phoneUtils').matchKey(PHONE),
  { lastInboundAt: NOW - 2 * DAY, lastOutboundAt: null, hasOutbound: false, offerSent: false, inboundTexts: ['здравствуйте'] }]]);
const runNA = (overrides) => svc.buildTasks({
  waMessages: [], threadStates: {}, labEmails: [], newApplications: [baseApp],
  declByPhone: {}, waSignalsByKey: signals, applicationOverrides: overrides, now: NOW,
}).tasks.filter(t => t.kind === 'new_application');

test('buildTasks: no override → application shown', () => {
  assert.strictEqual(runNA(new Map()).length, 1);
});
test('buildTasks: not_new override by phone_key → hidden', () => {
  const key = require('../src/utils/phoneUtils').matchKey(PHONE);
  const ov = new Map([[key, { status: 'not_new', reason: 'already_replied' }]]);
  assert.strictEqual(runNA(ov).length, 0);
});
test('buildTasks: not_new override by row key → hidden', () => {
  const ov = new Map([['row:5', { status: 'not_new', reason: 'duplicate' }]]);
  assert.strictEqual(runNA(ov).length, 0);
});
test('buildTasks: override accepts a plain object (not only Map)', () => {
  const key = require('../src/utils/phoneUtils').matchKey(PHONE);
  const tasks = svc.buildTasks({
    waMessages: [], threadStates: {}, labEmails: [], newApplications: [baseApp],
    declByPhone: {}, waSignalsByKey: signals, applicationOverrides: { [key]: { status: 'not_new', reason: 'other' } }, now: NOW,
  }).tasks.filter(t => t.kind === 'new_application');
  assert.strictEqual(tasks.length, 0);
});

// ── markApplication / reopenApplication (stubbed model) ──
function modelStub() {
  const store = new Map();
  return {
    store,
    models: {
      ApplicationOverride: {
        updateOne: async (q, u) => { store.set(q.app_key, u.$set); return { upsertedCount: 1 }; },
        deleteOne: async (q) => { const had = store.delete(q.app_key); return { deletedCount: had ? 1 : 0 }; },
      },
      APPLICATION_OVERRIDE_REASONS: ['already_replied', 'not_relevant', 'duplicate', 'spam_wrong', 'handled_offline', 'already_client', 'other'],
    },
  };
}
test('markApplication: valid reason stored, keyed by phone', async () => {
  const s = modelStub();
  const r = await svc.markApplication({ phone: PHONE, client_name: 'ИП Тест', reason: 'already_replied', note: 'ответили в директ' }, { models: s.models });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'not_new');
  assert.strictEqual(r.reason, 'already_replied');
  assert.ok(s.store.get(r.app_key).client_name === 'ИП Тест');
});
test('markApplication: unknown reason → coerced to other', async () => {
  const s = modelStub();
  const r = await svc.markApplication({ phone: PHONE, reason: 'нечто' }, { models: s.models });
  assert.strictEqual(r.reason, 'other');
});
test('markApplication: no phone & no row → ok:false', async () => {
  const s = modelStub();
  const r = await svc.markApplication({ reason: 'other' }, { models: s.models });
  assert.strictEqual(r.ok, false);
});
test('markApplication: no phone but row → keyed by row', async () => {
  const s = modelStub();
  const r = await svc.markApplication({ sheet_row: 9, reason: 'duplicate' }, { models: s.models });
  assert.strictEqual(r.app_key, 'row:9');
});
test('reopenApplication: removes the override', async () => {
  const s = modelStub();
  await svc.markApplication({ phone: PHONE, reason: 'other' }, { models: s.models });
  const r = await svc.reopenApplication({ phone: PHONE }, { models: s.models });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, 1);
});

(async () => {
  console.log('\n[application-override + form-date]');
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  console.log(`\n${fail ? '✗' : '✓'} application-override: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
