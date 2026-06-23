'use strict';

// Tests for the New Form Classification Engine (services/newFormClassificationService).
// Pure logic: product parsing, grouping, age/category detection, DS/SS determination,
// protocol groups. No DB. Run: node tests/new-form-classification.test.js

const assert = require('assert');
const c = require('../src/services/newFormClassificationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// The real "latest application" (sheet row 570): merged blob, empty dedicated TNVED column.
const ROW570 = 'Хомут - 60% хлопок, 30% полиэстер, 10% шерсть , 6104310000   Жакет - 60% хлопок, 30% полиэстер, 10% шерсть, 6104310000  Бант - 60% хлопок, 10% эластан, 15% полиамид, 15% вискоза,  6110209900,  Рубашка полоска, 80% хлопок, 10% полиэстер,  10% вискоза, 6106200000, Лен -60% хлопок, 10% эластан, 15% полиамид, 15% вискоза,  6106200000';

console.log('\n[parsing + grouping]');

test('parseProducts splits the merged blob into 5 products with codes', () => {
  const p = c.parseProducts(ROW570);
  assert.strictEqual(p.length, 5);
  assert.deepStrictEqual(p.map(x => x.tnved), ['6104310000', '6104310000', '6110209900', '6106200000', '6106200000']);
  assert.strictEqual(p[0].name, 'Хомут');
});

test('product names are free of leading separators', () => {
  const p = c.parseProducts(ROW570);
  assert.ok(p.every(x => !/^[,\-\s]/.test(x.name)), 'no leading comma/dash');
  assert.strictEqual(p[3].name, 'Рубашка полоска');
});

test('composition grouping → 3 distinct составы', () => {
  const g = c.compositionGroups(c.parseProducts(ROW570));
  assert.strictEqual(g.length, 3);
});

test('tnved grouping → raw 5 / grouped 3', () => {
  const t = c.tnvedGroups(c.parseProducts(ROW570));
  assert.strictEqual(t.raw_count, 5);
  assert.strictEqual(t.grouped_count, 3);
});

test('protocol groups = unique (category × composition) → 3 (all knit)', () => {
  const pg = c.protocolGroups(c.parseProducts(ROW570));
  assert.strictEqual(pg.length, 3);
  assert.ok(pg.every(g => g.category === 'knitwear'));
});

console.log('\n[age + category + DS/SS]');

test('detectAge: «Женская взрослая» → adult', () => {
  assert.strictEqual(c.detectAge('Женская взрослая').value, 'adult');
});

test('detectAge: «Детская одежда» → child', () => {
  assert.strictEqual(c.detectAge('Детская одежда').value, 'child');
});

test('detectAge: empty → unknown', () => {
  assert.strictEqual(c.detectAge('').value, 'unknown');
});

test('AGE drives DS/SS; knit/sew disagreement does NOT lower confidence', () => {
  const r = c.classify({ age: 'Женская взрослая', items_text: ROW570 });
  assert.strictEqual(r.doc_type, 'ДС');
  assert.strictEqual(r.determination.confidence, 92);
  assert.strictEqual(r.needs_operator, false);
  // signals disagree (Рубашка→sewing name vs 61→knit) but confidence stays HIGH
  assert.strictEqual(r.fabric.signals_agree, false);
});

test('row 570 full classify: knit, 3 comp groups, 3 protocols, 3 samples, Дастан', () => {
  const r = c.classify({ age: 'Женская взрослая', items_text: ROW570 });
  assert.strictEqual(r.category, 'knitwear');
  assert.strictEqual(r.composition_group_count, 3);
  assert.strictEqual(r.estimated_protocol_count, 3);
  assert.strictEqual(r.samples_required, 3);     // ДС: 3 составы × 1
  assert.strictEqual(r.laboratory, 'Дастан');
});

test('child application → СС / Бермет / 2 samples per composition', () => {
  const r = c.classify({ age: 'Детская', items_text: 'Боди детское - 100% хлопок, 6111200000' });
  assert.strictEqual(r.doc_type, 'СС');
  assert.strictEqual(r.laboratory, 'Бермет');
  assert.strictEqual(r.samples_required, 2);     // СС: 1 состав × 2
});

test('KB worked example reproduces: adult knit, 1 comp, ДС, 1 sample, HIGH', () => {
  const r = c.classify({ age: 'Женская взрослая', items_text: 'Домашний костюм трикотаж - 95% полиэстер, 5% эластан, 6104320000' });
  assert.strictEqual(r.doc_type, 'ДС');
  assert.strictEqual(r.composition_group_count, 1);
  assert.strictEqual(r.estimated_protocol_count, 1);
  assert.strictEqual(r.samples_required, 1);
  assert.strictEqual(r.determination.confidence_band, 'HIGH');
});

test('unknown AGE → needs_operator (stop & ask), no doc_type', () => {
  const r = c.classify({ age: '', items_text: ROW570 });
  assert.strictEqual(r.needs_operator, true);
  assert.strictEqual(r.doc_type, null);
  assert.ok(r.warnings.some(w => w.code === 'age_missing'));
});

test('multi-TNVED triggers attachment warning', () => {
  const r = c.classify({ age: 'Женская взрослая', items_text: ROW570 });
  assert.ok(r.warnings.some(w => w.code === 'multi_tnved_attachment'));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
