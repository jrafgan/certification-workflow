'use strict';

// Deep-matcher: resolve matched «Декларация» sheet rows to the materialized Mongo Order._id so the
// panel's «Открыть заказ» works (email-tasks-empty-orders made Orders exist; whatsapp-match-empty-
// replica-bug matches on the live sheet). Verifies lookupOrdersByPhone + matchMessage fill order_id
// from a stubbed Order model, and degrade gracefully when no Order is materialized. No real DB/network.
//
// Run: node tests/whatsapp-order-link.test.js

const assert = require('assert');
const svc = require('../src/services/whatsappMatchService');

let pass = 0, fail = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// Raw «Декларация» rows (arrays): D=col3 client, J=col9 phone, N=col13 status.
function declRow(client, phone, status) {
  const r = new Array(14).fill('');
  r[3] = client; r[9] = phone; r[13] = status;
  return r;
}
// Sheet has 1 client on a unique phone (row 2) and 2 orders sharing another phone (rows 3–4).
const RAW = [
  declRow('ОсОО BACCI', '+996700111222', 'на согласовании'),   // sheet row 2
  declRow('ИП Парманова', '0777240858', 'завершен'),           // sheet row 3
  declRow('ИП Парманова', '996777240858', 'ждем макет'),       // sheet row 4
];
// Materialized Orders keyed by sheet_row_id (row 2 & 4 materialized; row 3 not → order_id stays null).
const ORDERS = [{ _id: 'ORD_2', sheet_row_id: '2' }, { _id: 'ORD_4', sheet_row_id: '4' }];
const OrderStub = {
  find: (q) => ({ select: () => ({ lean: async () => {
    const wanted = (q.sheet_row_id && q.sheet_row_id.$in) || [];
    return ORDERS.filter(o => wanted.map(String).includes(String(o.sheet_row_id)));
  } }) }),
};
const deps = { readDeclaration: async () => RAW, Order: OrderStub };

test('lookupOrdersByPhone: unique match → order_id resolved from Mongo', async () => {
  const r = await svc.lookupOrdersByPhone('+996700111222', deps);
  assert.strictEqual(r.match_status, 'matched');
  assert.strictEqual(r.results[0].row, '2');
  assert.strictEqual(r.results[0].order_id, 'ORD_2');           // deep-link works
});
test('lookupOrdersByPhone: sheet row without a materialized Order → order_id null (graceful)', async () => {
  const r = await svc.lookupOrdersByPhone('777240858', deps);   // rows 3 & 4
  assert.strictEqual(r.match_status, 'needs_review');
  const row3 = r.results.find(x => x.row === '3');
  const row4 = r.results.find(x => x.row === '4');
  assert.strictEqual(row3.order_id, null);                      // row 3 not materialized
  assert.strictEqual(row4.order_id, 'ORD_4');                   // row 4 materialized
  assert.strictEqual(r.last_declaration_row.order_id, 'ORD_4'); // newest row also deep-linked
});

test('matchMessage: unique match writes matched_order_id from Mongo', async () => {
  let saved = null;
  const msg = { from_phone: '+996700111222', phone_key: null, save: async function () { saved = this; } };
  const MsgStub = { WhatsAppMessage: { findById: async () => msg } };
  const r = await svc.matchMessage('mid', { ...deps, ...MsgStub });
  assert.strictEqual(r.match_status, 'matched');
  assert.strictEqual(saved.matched_sheet_row, '2');
  assert.strictEqual(saved.matched_order_id, 'ORD_2');
});
test('matchMessage: no Order model → matched on sheet row, matched_order_id null', async () => {
  let saved = null;
  const msg = { from_phone: '+996700111222', save: async function () { saved = this; } };
  const MsgStub = { WhatsAppMessage: { findById: async () => msg } };
  const r = await svc.matchMessage('mid', { readDeclaration: async () => RAW, Order: null, ...MsgStub });
  assert.strictEqual(r.match_status, 'matched');
  assert.strictEqual(saved.matched_sheet_row, '2');
  assert.strictEqual(saved.matched_order_id, null);             // degrades gracefully
});

(async () => {
  console.log('\n[whatsapp-order-link]');
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  console.log(`\n${fail ? '✗' : '✓'} whatsapp-order-link: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
