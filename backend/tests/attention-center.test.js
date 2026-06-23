'use strict';

// Tests for the Attention Center (services/attentionCenterService.categorize — pure).
// No DB. Run: node tests/attention-center.test.js

const assert = require('assert');
const ac = require('../src/services/attentionCenterService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const cat = (res, key) => res.categories.find(c => c.key === key);

const ORDERS = [
  { _id: 'o1', status: 'Ждем макет', client: { companyName: 'ОсОО А' } },
  { _id: 'o2', status: 'На согласовании', client: { name: 'Иван' } },
  { _id: 'o3', status: 'Ждем оригинал', client: { companyName: 'ОсОО В' } },
  { _id: 'o4', status: 'Запустить', client: {} },
];

console.log('\n[categorize — 7 lanes]');

test('returns exactly the 7 expected categories', () => {
  const r = ac.categorize({ orders: ORDERS });
  assert.deepStrictEqual(
    r.categories.map(c => c.key),
    ['new_clients', 'waiting_payment', 'waiting_mockup', 'waiting_approval', 'waiting_original', 'status_conflicts', 'forgotten']
  );
});

test('waiting lanes map to the right order statuses', () => {
  const r = ac.categorize({ orders: ORDERS });
  assert.strictEqual(cat(r, 'waiting_mockup').count, 1);
  assert.strictEqual(cat(r, 'waiting_approval').count, 1);
  assert.strictEqual(cat(r, 'waiting_original').count, 1);
  assert.strictEqual(cat(r, 'waiting_mockup').items[0].client, 'ОсОО А');
});

test('new clients + waiting payment come from leads', () => {
  const r = ac.categorize({
    orders: ORDERS,
    newClients: [{ _id: 'l1', display_name: 'Айбек', platform: 'instagram' }],
    waitingPayment: [{ _id: 'l2', handle: '@shop', platform: 'telegram' }, { _id: 'l3', whatsapp_phone: '+996700' }],
  });
  assert.strictEqual(cat(r, 'new_clients').count, 1);
  assert.strictEqual(cat(r, 'new_clients').items[0].label, 'Айбек');
  assert.strictEqual(cat(r, 'waiting_payment').count, 2);
});

test('status_conflicts include audits with a proposed status or conflict findings', () => {
  const r = ac.categorize({
    orders: ORDERS,
    audits: [
      { order_id: 'o1', current_status: 'Ждем макет', proposed_status: 'На согласовании', confidence_band: 'HIGH' },        // proposal → conflict
      { order_id: 'o9', current_status: 'Завершен', findings: [{ type: 'completed_with_debt', detail: 'долг' }] },          // finding → conflict
      { order_id: 'o2', current_status: 'На согласовании', findings: [{ type: 'stale_status', detail: 'idle' }] },          // not a conflict
    ],
  });
  assert.strictEqual(cat(r, 'status_conflicts').count, 2);
});

test('forgotten = overdue/idle dangers only (not status-conflict dangers)', () => {
  const r = ac.categorize({
    orders: ORDERS,
    dangers: [
      { order_id: 'o1', type: 'lab_overdue', severity: 'HIGH', label: 'Лаборатория задерживает' },
      { order_id: 'o4', type: 'paid_not_launched', severity: 'HIGH' },
      { order_id: 'o9', type: 'completed_with_debt', severity: 'HIGH' },   // a conflict, NOT forgotten
    ],
  });
  assert.strictEqual(cat(r, 'forgotten').count, 2);
  assert.ok(cat(r, 'forgotten').items.every(i => i.type !== 'completed_with_debt'));
});

test('isConflict: proposal or conflict finding true; benign finding false', () => {
  assert.strictEqual(ac.isConflict({ proposed_status: 'X' }), true);
  assert.strictEqual(ac.isConflict({ findings: [{ type: 'missing_transition' }] }), true);
  assert.strictEqual(ac.isConflict({ findings: [{ type: 'stale_status' }] }), false);
  assert.strictEqual(ac.isConflict(null), false);
});

test('total counts across all lanes; recommend_only flagged', () => {
  const r = ac.categorize({ orders: ORDERS, newClients: [{ _id: 'l1' }] });
  assert.strictEqual(r.recommend_only, true);
  // 3 waiting orders + 1 new client = 4
  assert.strictEqual(r.total, 4);
});

test('empty input → 7 empty categories, total 0', () => {
  const r = ac.categorize({});
  assert.strictEqual(r.categories.length, 7);
  assert.strictEqual(r.total, 0);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
