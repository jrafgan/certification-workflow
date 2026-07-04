'use strict';

// Pure tests for Payment Recognition. No I/O.
// Run: node tests/payment-recognition.test.js

const assert = require('assert');
const pr = require('../src/services/paymentRecognitionService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

test('parseAmount reads сом / рублей', () => {
  assert.strictEqual(pr.parseAmount('оплатил 15000 сом').amount, 15000);
  assert.strictEqual(pr.parseAmount('перевёл 8 000 рублей').amount, 8000);
  assert.strictEqual(pr.parseAmount('нет суммы'), null);
});

test('receipt attachment → MEDIUM, has_receipt_file', () => {
  const r = pr.recognizeFromMessage({ body: '', attachments: [{ file_name: 'чек_оплаты.pdf', mime_type: 'application/pdf' }] });
  assert.strictEqual(r.has_payment_signal, true);
  assert.strictEqual(r.has_receipt_file, true);
  assert.strictEqual(r.confidence, 'MEDIUM');
  assert.strictEqual(r.needs_operator_confirmation, true);
});

test('intent + amount → MEDIUM with amount', () => {
  const r = pr.recognizeFromMessage({ body: 'Здравствуйте, я оплатил 15000 сом за декларацию' });
  assert.strictEqual(r.has_intent, true);
  assert.strictEqual(r.amount, 15000);
  assert.strictEqual(r.confidence, 'MEDIUM');
});

test('intent only → LOW', () => {
  const r = pr.recognizeFromMessage({ body: 'оплату отправил, проверьте пожалуйста' });
  assert.strictEqual(r.has_intent, true);
  assert.strictEqual(r.confidence, 'LOW');
});

test('no payment content → no signal', () => {
  const r = pr.recognizeFromMessage({ body: 'сколько стоит сертификат?' });
  assert.strictEqual(r.has_payment_signal, false);
  assert.strictEqual(r.confidence, 'NONE');
});

test('assessSufficiency applies KB floor (10000) and 60% rule', () => {
  assert.strictEqual(pr.assessSufficiency(5000).sufficient, false);          // below floor
  assert.strictEqual(pr.assessSufficiency(15000).sufficient, true);          // floor ok, no total
  assert.strictEqual(pr.assessSufficiency(15000, 35000).sufficient, false);  // 15000 < 60% of 35000 (21000)
  assert.strictEqual(pr.assessSufficiency(21000, 35000).sufficient, true);   // 60% ok and ≥ floor
  assert.strictEqual(pr.assessSufficiency(null).sufficient, null);           // unknown amount
});

test('toDraftSignal maps to the New Order Proposal payment signal shape', () => {
  const recv = pr.recognizeFromMessage({ body: 'оплатил 15000 сом' });
  const sig = pr.toDraftSignal(recv);
  assert.ok(sig.detail && sig.amount === 15000);
  assert.strictEqual(pr.toDraftSignal(pr.recognizeFromMessage({ body: 'привет' })), null);
});

test('toDraftSignal feeds draftPackageService and raises confidence (integration)', () => {
  const draft = require('../src/services/draftPackageService');
  const application = { row: 7, legal_entity: 'ОсОО Ромашка', phone: '+996700112233', submitted_at: new Date() };
  const sig = pr.toDraftSignal(pr.recognizeFromMessage({ body: 'оплатил 15000 сом', attachments: [{ file_name: 'чек.pdf', mime_type: 'application/pdf' }] }));
  const pkg = draft.buildCreateDeclarationDraft(application, { payment: sig });
  assert.strictEqual(pkg.generated, true);
  assert.ok(pkg.confidence >= 80, `payment signal should raise confidence, got ${pkg.confidence}`);
  assert.ok(pkg.evidence.some(e => e.kind === 'payment'));
});

test('full chain: matched application + payment + PI → New Order Proposal', () => {
  const draft = require('../src/services/draftPackageService');
  const piSvc = require('../src/services/piCalculationService');
  // application identified by Application Matching
  const application = { row: 12, legal_entity: 'ОсОО Ромашка', phone: '+996700112233', submitted_at: new Date() };
  // payment recognized from WhatsApp
  const payment = pr.toDraftSignal(pr.recognizeFromMessage({ body: 'оплатил 21000 сом', attachments: [{ file_name: 'чек.pdf', mime_type: 'application/pdf' }] }));
  // PI computed by the engine (ДС, 2 составов)
  const pi = piSvc.computePi({ doc_type: 'ДС', compositions: ['хлопок', 'полиэстер'] });
  const pkg = draft.buildCreateDeclarationDraft(application, { payment, pi, document_type: 'ДС' });
  assert.strictEqual(pkg.generated, true);
  assert.strictEqual(pkg.proposed_data.pi_count, 2);
  assert.strictEqual(pkg.proposed_data.estimated_cost, 27000); // ДС default no_workshop: 18000 + 1×9000
  assert.strictEqual(pkg.proposed_data.laboratory, 'уточняется');
  assert.ok(pkg.evidence.some(e => e.kind === 'pi'));
  assert.ok(pkg.evidence.some(e => e.kind === 'payment'));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
