'use strict';

// Pure tests for the PI Calculation Engine (operator Master KB V2 rules). No I/O.
// Run: node tests/pi-calculation.test.js

const assert = require('assert');
const pi = require('../src/services/piCalculationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

test('normalizeDocType accepts RU/EN/abbrev', () => {
  assert.strictEqual(pi.normalizeDocType('ДС'), 'ДС');
  assert.strictEqual(pi.normalizeDocType('декларация'), 'ДС');
  assert.strictEqual(pi.normalizeDocType('declaration'), 'ДС');
  assert.strictEqual(pi.normalizeDocType('СС'), 'СС');
  assert.strictEqual(pi.normalizeDocType('сертификат'), 'СС');
  assert.strictEqual(pi.normalizeDocType('xyz'), null);
});

test('countCompositions dedupes and floors at 1', () => {
  assert.strictEqual(pi.countCompositions(['хлопок', 'Хлопок', ' хлопок ']), 1);
  assert.strictEqual(pi.countCompositions(['хлопок', 'полиэстер']), 2);
  assert.strictEqual(pi.countCompositions(0), 1);
  assert.strictEqual(pi.countCompositions(5), 5);
  assert.strictEqual(pi.countCompositions(undefined), 1);
});

test('ДС без флага цех → default no_workshop: base 18000, 3 года, needs clarification', () => {
  const r = pi.computePi({ doc_type: 'ДС', compositions: ['хлопок'] });
  assert.strictEqual(r.pi_count, 1);
  assert.strictEqual(r.additional_pi, 0);
  assert.strictEqual(r.total_estimate, 18000);
  assert.strictEqual(r.validity, '3 года');
  assert.strictEqual(r.declaration_variant, 'no_workshop');
  assert.strictEqual(r.needs_workshop_clarification, true);
  assert.strictEqual(r.samples_required, 2);              // всегда 2/состав
  assert.strictEqual(r.laboratory, 'уточняется');
  assert.strictEqual(r.needs_operator_confirmation, true);
});

test('ДС есть документы на цех → base 17000, 1 год, 2 образца/состав', () => {
  const r = pi.computePi({ doc_type: 'ДС', compositions: ['хлопок'], has_workshop_docs: true });
  assert.strictEqual(r.total_estimate, 17000);
  assert.strictEqual(r.validity, '1 год');
  assert.strictEqual(r.declaration_variant, 'with_workshop');
  assert.strictEqual(r.needs_workshop_clarification, false);
  assert.strictEqual(r.samples_required, 2);              // with_workshop = 2/состав
  assert.strictEqual(r.samples_per_composition, 2);
});

test('ДС нет документов на цех, 3 состава → 18000 + 2×9000 = 36000, 6 samples (2/состав)', () => {
  const r = pi.computePi({ doc_type: 'ДС', compositions: ['хлопок', 'полиэстер', 'шерсть'], has_workshop_docs: false });
  assert.strictEqual(r.pi_count, 3);
  assert.strictEqual(r.additional_pi, 2);
  assert.strictEqual(r.additional_cost, 18000);           // no_workshop доп-ПИ = 9000
  assert.strictEqual(r.total_estimate, 36000);
  assert.strictEqual(r.samples_required, 6);              // всегда 2/состав × 3
});

test('СС местные, 2 составов → 35000 + 1×10000 = 45000, 4 samples (2/состав)', () => {
  const r = pi.computePi({ doc_type: 'СС', compositions: ['хлопок', 'полиэстер'] });
  assert.strictEqual(r.total_estimate, 45000);
  assert.strictEqual(r.samples_required, 4);
  assert.strictEqual(r.laboratory, 'Бермет');
  assert.strictEqual(r.foreign_entity, false);
});

test('СС зарубежное юрлицо, 2 составов → 50000 + 1×13000 = 63000', () => {
  const r = pi.computePi({ doc_type: 'СС', compositions: ['хлопок', 'полиэстер'], foreign_entity: true });
  assert.strictEqual(r.total_estimate, 63000);
  assert.strictEqual(r.additional_pi_unit, 13000);
  assert.strictEqual(r.foreign_entity, true);
});

test('explicit pi_count overrides composition counting', () => {
  const r = pi.computePi({ doc_type: 'ДС', pi_count: 4, has_workshop_docs: false });
  assert.strictEqual(r.pi_count, 4);
  assert.strictEqual(r.total_estimate, 18000 + 3 * 9000);  // no_workshop доп-ПИ = 9000
  assert.strictEqual(r.confidence, 'MEDIUM');
});

test('base_price override marks estimate as non-minimum', () => {
  const r = pi.computePi({ doc_type: 'СС', pi_count: 1, base_price: 40000 });
  assert.strictEqual(r.total_estimate, 40000);
  assert.strictEqual(r.is_minimum, false);
});

test('basis lines are present and human-readable', () => {
  const r = pi.computePi({ doc_type: 'ДС', compositions: ['хлопок', 'полиэстер'] });
  assert.ok(Array.isArray(r.basis) && r.basis.length >= 4);
  assert.ok(r.basis.some(l => /Количество ПИ/.test(l)));
});

test('unknown doc_type throws', () => {
  assert.throws(() => pi.computePi({ doc_type: 'СГР', pi_count: 1 }));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
