'use strict';

// Tests for New Application Proposal — PURE buildProposal (classify + computePi + draft).
// No DB. Run: node tests/new-application-proposal.test.js

const assert = require('assert');
const svc = require('../src/services/newApplicationProposalService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

console.log('\n[buildProposal]');

test('adult knit → ДС, ПИ counted, total + calc draft', () => {
  const p = svc.buildProposal({
    applicant_name: 'ОсОО Ромашка', applicant_phone: '996555123456',
    age: 'Женская взрослая',
    items_text: 'Домашний костюм трикотаж - 95% полиэстер, 5% эластан, 6104320000',
  });
  assert.strictEqual(p.doc_type, 'ДС');
  assert.strictEqual(p.protocol_count, 1);
  assert.ok(p.total_estimate > 0, 'total computed');
  assert.strictEqual(p.currency, 'сом');
  assert.ok(/Предварительный расчёт/.test(p.draft_reply), 'calc reply');
  assert.ok(p.needs.includes('confirm_workshop_docs'), 'ДС asks about цех');
  assert.strictEqual(p.phone_key, '555123456');
});

test('child → СС', () => {
  const p = svc.buildProposal({
    applicant_name: 'ИП Иванов', applicant_phone: '0700111222',
    age: 'Детская', items_text: 'Боди детское - 100% хлопок, 6111200000',
  });
  assert.strictEqual(p.doc_type, 'СС');
  assert.ok(p.total_estimate > 0);
  assert.strictEqual(p.laboratory, 'Бермет');
});

test('missing age → needs operator to determine doc type, asks client for info', () => {
  const p = svc.buildProposal({ applicant_name: 'X', items_text: 'футболка' });
  assert.strictEqual(p.doc_type, null);
  assert.ok(p.needs.includes('determine_doc_type'));
  assert.strictEqual(p.total_estimate, null);
  assert.ok(/уточните/i.test(p.draft_reply), 'asks for missing info');
});

test('dedupeKey stable + content-based', () => {
  const a = { applicant_name: 'A', applicant_phone: '996555000111', items_text: 'x', tnved_text: '6104' };
  const b = { applicant_name: 'A', applicant_phone: '996555000111', items_text: 'x', tnved_text: '6104' };
  assert.strictEqual(svc.dedupeKey(a), svc.dedupeKey(b));
  assert.notStrictEqual(svc.dedupeKey(a), svc.dedupeKey({ ...a, tnved_text: '6203' }));
  assert.ok(svc.dedupeKey(a).startsWith('newapp:'));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
