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

test('ДС, 1 состав → base 15000, no additional, 1 sample', () => {
  const r = pi.computePi({ doc_type: 'ДС', compositions: ['хлопок'] });
  assert.strictEqual(r.pi_count, 1);
  assert.strictEqual(r.additional_pi, 0);
  assert.strictEqual(r.total_estimate, 15000);
  assert.strictEqual(r.samples_required, 1);
  assert.strictEqual(r.laboratory, 'Дастан');
  assert.strictEqual(r.is_minimum, true);
  assert.strictEqual(r.needs_operator_confirmation, true);
});

test('ДС, 3 составов → 15000 + 2×7000 = 29000, 3 samples', () => {
  const r = pi.computePi({ doc_type: 'ДС', compositions: ['хлопок', 'полиэстер', 'шерсть'] });
  assert.strictEqual(r.pi_count, 3);
  assert.strictEqual(r.additional_pi, 2);
  assert.strictEqual(r.additional_cost, 14000);
  assert.strictEqual(r.total_estimate, 29000);
  assert.strictEqual(r.samples_required, 3);
});

test('СС, 2 составов → 35000 + 1×9000 = 44000, 4 samples (2/состав)', () => {
  const r = pi.computePi({ doc_type: 'СС', compositions: ['хлопок', 'полиэстер'] });
  assert.strictEqual(r.total_estimate, 44000);
  assert.strictEqual(r.samples_required, 4);
  assert.strictEqual(r.laboratory, 'Бермет');
});

test('explicit pi_count overrides composition counting', () => {
  const r = pi.computePi({ doc_type: 'ДС', pi_count: 4 });
  assert.strictEqual(r.pi_count, 4);
  assert.strictEqual(r.total_estimate, 15000 + 3 * 7000);
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
