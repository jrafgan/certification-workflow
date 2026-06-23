'use strict';

// Tests for payment reconciliation (services/paymentReconciliationService) — pure debt math +
// conversation analysis + gated proposal. No DB. Run: node tests/payment-reconciliation.test.js

const assert = require('assert');
const pr = require('../src/services/paymentReconciliationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

console.log('\n[reconcile — debt arithmetic]');
test('partial payment → debt = agreed − paid', () => {
  const r = pr.reconcile({ agreed_total: 30000, total_paid: 15000 });
  assert.strictEqual(r.debt, 15000);
  assert.strictEqual(r.partially_paid, true);
  assert.strictEqual(r.status, 'частично оплачено');
});
test('full payment → debt 0, fully_paid', () => {
  const r = pr.reconcile({ agreed_total: 30000, total_paid: 30000 });
  assert.strictEqual(r.debt, 0);
  assert.strictEqual(r.fully_paid, true);
  assert.strictEqual(r.status, 'полностью оплачено');
});
test('nothing paid → debt = agreed', () => {
  const r = pr.reconcile({ agreed_total: 30000, total_paid: 0 });
  assert.strictEqual(r.debt, 30000);
  assert.strictEqual(r.status, 'не оплачено');
});
test('overpaid → status переплата', () => {
  const r = pr.reconcile({ agreed_total: 30000, total_paid: 35000 });
  assert.strictEqual(r.debt, 0);
  assert.strictEqual(r.overpaid, 5000);
  assert.strictEqual(r.status, 'переплата');
});
test('unknown agreed → debt null', () => {
  const r = pr.reconcile({ agreed_total: null, total_paid: 15000 });
  assert.strictEqual(r.debt, null);
});

console.log('\n[analyzeConversation — quotes (out) vs payments (in)]');
test('extracts agreed total from operator, paid from client, computes debt', () => {
  const messages = [
    { direction: 'out', body: 'Здравствуйте! Стоимость оформления — 30000 сом.' },
    { direction: 'in',  body: 'Хорошо, пока переведу 15000 сом, остальное позже.' },
    { direction: 'in',  body: 'оплатил, чек', attachments: [{ file_name: 'check.jpg', mime_type: 'image/jpeg' }] },
  ];
  const a = pr.analyzeConversation(messages);
  assert.strictEqual(a.agreed_total, 30000);
  assert.strictEqual(a.total_paid, 15000);
  assert.strictEqual(a.debt, 15000);
  assert.strictEqual(a.status, 'частично оплачено');
  assert.ok(a.confidence === 'MEDIUM');           // has quote + payment/receipt
  assert.strictEqual(a.needs_operator_confirmation, true);
});
test('empty conversation → low confidence, unknown', () => {
  const a = pr.analyzeConversation([]);
  assert.strictEqual(a.agreed_total, null);
  assert.strictEqual(a.confidence, 'LOW');
});

console.log('\n[buildProposal — gated record for «Декларация»]');
test('proposes amount + debt note, never auto-writes', () => {
  const a = pr.analyzeConversation([
    { direction: 'out', body: 'Итого 30000 сом' },
    { direction: 'in',  body: 'перевёл 15000 сом' },
  ]);
  const p = pr.buildProposal({ phone: '+996700111222', legal_entity: 'ОсОО Мегуми', analysis: a });
  assert.strictEqual(p.action, 'record_payment_and_debt');
  assert.strictEqual(p.debt, 15000);
  assert.strictEqual(p.declaration_update.amount, 15000);
  assert.ok(/Долг: 15000/.test(p.declaration_update.debt_note));
  assert.strictEqual(p.auto_write, false);
  assert.strictEqual(p.operator_approval_required, true);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
