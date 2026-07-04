'use strict';

// Pure unit tests for the Operator Task Inbox composition (buildTasks). No DB.
// Run: node tests/task-inbox.test.js

const assert = require('assert');
const { buildTasks, threadKey, declIndexFromRows, proposeReply } = require('../src/services/taskInboxService');
const { parsePayment } = require('../src/services/clientEntityService');
const { parseFormDate } = require('../src/services/formFieldMapper');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const NOW = Date.parse('2026-07-01T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000);

test('groups WhatsApp messages by phone into one thread each', () => {
  const waMessages = [
    { phone_key: '111', from_phone: '996700000111', body: 'второе', received_at: ago(5), candidates: [{ client_name: 'ООО А' }] },
    { phone_key: '111', from_phone: '996700000111', body: 'первое', received_at: ago(30) },
    { phone_key: '222', from_phone: '996700000222', body: 'привет', received_at: ago(10) },
  ];
  const { tasks } = buildTasks({ waMessages, now: NOW });
  const wa = tasks.filter(t => t.kind === 'whatsapp_reply');
  assert.strictEqual(wa.length, 2);
  const a = wa.find(t => t.phone_key === '111');
  assert.strictEqual(a.title, 'ООО А');            // name from latest message candidate
  assert.strictEqual(a.last_message, 'второе');    // latest, not oldest
});

test('unread counts messages newer than last_seen_at; done/snooze hide the thread', () => {
  const waMessages = [
    { phone_key: '111', from_phone: '996700000111', body: 'new', received_at: ago(5) },
    { phone_key: '111', from_phone: '996700000111', body: 'old', received_at: ago(60) },
    { phone_key: '333', from_phone: '996700000333', body: 'x', received_at: ago(1) },
    { phone_key: '444', from_phone: '996700000444', body: 'y', received_at: ago(1) },
  ];
  const threadStates = {
    '111': { last_seen_at: ago(30) },       // one msg newer → unread 1
    '333': { done: true },                  // hidden
    '444': { snoozed_until: new Date(NOW + 3600000) }, // hidden
  };
  const { tasks } = buildTasks({ waMessages, threadStates, now: NOW });
  const keys = tasks.filter(t => t.kind === 'whatsapp_reply').map(t => t.phone_key);
  assert.deepStrictEqual(keys, ['111']);
  assert.strictEqual(tasks[0].unread, 1);
});

test('group task shows the addressing reason in the subtitle', () => {
  const waMessages = [{ phone_key: '555', from_phone: '996700000555', body: 'прайс?', received_at: ago(2), is_group: true, group_subject: 'Поставщики', addressed_reason: 'mention' }];
  const { tasks } = buildTasks({ waMessages, now: NOW });
  assert.strictEqual(tasks[0].is_group, true);
  assert.ok(/Поставщики/.test(tasks[0].subtitle));
  assert.ok(/упомянули/.test(tasks[0].subtitle));
});

test('fuses lab emails and new applications into the same list', () => {
  const labEmails = [{ id: 'e1', subject: 'Запрос', to: 'lab@x', client_name: 'Иванов', created_at: ago(120) }];
  const newApplications = [{ sheet_row: 42, applicant: 'ИП Петров' }];
  const { tasks, total } = buildTasks({ labEmails, newApplications, now: NOW });
  assert.strictEqual(total, 2);
  assert.ok(tasks.find(t => t.kind === 'lab_email' && t.draft_id === 'e1'));
  assert.ok(tasks.find(t => t.kind === 'new_application' && t.sheet_row === 42));
});

test('priority: unread WhatsApp above lab email above new application', () => {
  const waMessages = [{ phone_key: '999', from_phone: '996700000999', body: 'hi', received_at: ago(1) }];
  const labEmails = [{ id: 'e1', subject: 's', created_at: ago(1) }];
  const newApplications = [{ sheet_row: 1, applicant: 'X' }];
  const { tasks } = buildTasks({ waMessages, labEmails, newApplications, now: NOW });
  assert.deepStrictEqual(tasks.map(t => t.kind), ['whatsapp_reply', 'lab_email', 'new_application']);
});

test('enriches WhatsApp thread from live Declaration sheet (order status, not "без заказа")', () => {
  // Raw «Декларация» rows: D=client(3), J=phone(9), N=status(13).
  const row = (client, phone, status) => { const r = []; r[3] = client; r[9] = phone; r[13] = status; return r; };
  const declByPhone = declIndexFromRows([
    row('ООО Ромашка', '+996 700 000 111', 'Ждем макет'),
    row('ООО Ромашка', '0700000111', 'На согласовании'), // same phone, 2nd order
  ]);
  const waMessages = [{ phone_key: '700000111', from_phone: '996700000111', body: 'когда готово?', received_at: ago(3) }];
  const { tasks } = buildTasks({ waMessages, declByPhone, now: NOW });
  const t = tasks[0];
  assert.strictEqual(t.has_order, true);
  assert.strictEqual(t.title, 'ООО Ромашка');            // name from the sheet, not the raw number
  assert.strictEqual(t.order_status, 'На согласовании');  // last non-empty status
  assert.ok(/в работе/.test(t.subtitle));
  assert.ok(/\+1/.test(t.subtitle));                      // (+1) — a second order on this phone
});

test('shows "без заказа" ONLY when the phone is truly absent from the sheet', () => {
  const waMessages = [{ phone_key: '999888777', from_phone: '996999888777', body: 'привет', received_at: ago(3) }];
  const { tasks } = buildTasks({ waMessages, declByPhone: {}, now: NOW });
  assert.strictEqual(tasks[0].has_order, false);
  assert.strictEqual(tasks[0].subtitle, 'без заказа');
});

test('parsePayment reads col G: paid amount + parenthesized remaining debt', () => {
  assert.deepStrictEqual(parsePayment('15000'), { paid: 15000, debt: 0, raw: '15000' });
  assert.deepStrictEqual(parsePayment('15 000 (5 000)'), { paid: 15000, debt: 5000, raw: '15 000 (5 000)' });
  assert.deepStrictEqual(parsePayment('15000 (долг 5000)'), { paid: 15000, debt: 5000, raw: '15000 (долг 5000)' });
  assert.deepStrictEqual(parsePayment(''), { paid: 0, debt: 0, raw: null });
});

test('paid client → row shows payment marker + debt', () => {
  const row = (client, phone, sum, status) => { const r = []; r[3] = client; r[6] = sum; r[9] = phone; r[13] = status; return r; };
  const declByPhone = declIndexFromRows([row('ИП Петров', '996700000111', '15000 (5000)', 'Ждем макет')]);
  const waMessages = [{ phone_key: '700000111', from_phone: '996700000111', body: 'чек', received_at: ago(2) }];
  const { tasks } = buildTasks({ waMessages, declByPhone, now: NOW });
  assert.strictEqual(tasks[0].is_paid, true);
  assert.strictEqual(tasks[0].paid, 15000);
  assert.strictEqual(tasks[0].debt, 5000);
  assert.ok(/оплачено 15 000/.test(tasks[0].subtitle));
  assert.ok(/долг 5 000/.test(tasks[0].subtitle));
});

test('proposeReply: debt → remind; active stage → status update; new → application link', () => {
  const debt = proposeReply({ debt_total: 5000, orders: [] });
  assert.strictEqual(debt.kind, 'payment_debt'); assert.ok(/5 000/.test(debt.text));
  const active = proposeReply({ debt_total: 0, orders: [{ stage: 'awaiting_layout', status: 'Ждем макет' }] });
  assert.strictEqual(active.kind, 'status_update'); assert.ok(active.text.length > 10);
  const neu = proposeReply({ debt_total: 0, orders: [], is_new_application: true });
  assert.strictEqual(neu.kind, 'application_link');
  const none = proposeReply(null);
  assert.strictEqual(none.kind, 'greeting');
});

test('parseFormDate parses Google Forms DD.MM.YYYY HH:mm:ss', () => {
  const d = parseFormDate('10.01.2026 13:09:36');
  assert.ok(d instanceof Date && !isNaN(d));
  assert.strictEqual(d.getFullYear(), 2026); assert.strictEqual(d.getMonth(), 0); assert.strictEqual(d.getDate(), 10);
  assert.strictEqual(parseFormDate(''), null);
  assert.strictEqual(parseFormDate('не дата'), null);
});

// Per the 2026-07-04 rule, submission-date age ALONE no longer hides an application — hiding is
// driven by WhatsApp signals (see new-application-filter.test.js). A date-only app stays shown
// and carries needs_calc_reply (we haven't sent the calc).
test('new application with only a submission date → shown, age_days set, needs_calc_reply', () => {
  const submitted = new Date(NOW - 40 * 86400000).toISOString();  // even 40 days: shown (no WhatsApp signal)
  const { tasks } = buildTasks({ newApplications: [{ sheet_row: 10, applicant: 'ИП Свежий', submitted_at: submitted }], now: NOW });
  const t = tasks.find(x => x.sheet_row === 10);
  assert.ok(t, 'date-only application is still shown');
  assert.strictEqual(t.age_days, 40);
  assert.strictEqual(t.needs_calc_reply, true);
});

test('threadKey falls back through phone_key → lid_key → normalized phone', () => {
  assert.strictEqual(threadKey({ phone_key: 'abc' }), 'abc');
  assert.strictEqual(threadKey({ lid_key: 'lid1' }), 'lid1');
  assert.strictEqual(threadKey({ from_phone: '996700000111' }), '700000111');
});

console.log(`\nTask Inbox: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(` - ${f.name}: ${f.err.message}`)); process.exit(1); }
