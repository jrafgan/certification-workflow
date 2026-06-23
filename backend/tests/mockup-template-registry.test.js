'use strict';

// Tests for the Mockup template registry + gated generation (services/mockupTemplateRegistry).
// Registry resolution (pure) + a real DOCX render against the official Макет_ДС.docx +
// the classification→generation wiring. Needs system zip/unzip + the template assets.
//
// Run: node tests/mockup-template-registry.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reg = require('../src/services/mockupTemplateRegistry');
const classifier = require('../src/services/newFormClassificationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const TEMPLATE_DIR = path.resolve(__dirname, '../templates');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-test-'));

// A minimal mapped application (mockupAgentService field shape).
const APP = {
  doc_type: 'ДС',
  applicant: { name: 'ОсОО Мегуми', inn: '12345678901234', address: 'Бишкек, ул. Ленина 1', phone: '+996700111222', email: 'a@b.kg' },
  manufacturer: { name: 'ОсОО Мегуми', country: 'Кыргызстан', address: 'Бишкек' },
  brand: 'Megumi',
  items_text: 'Футболка - 100% хлопок, 6109100000',
  items: [{ name: 'Футболка', composition: '100% хлопок', tnved: '6109100000' }],
};

console.log('\n[registry resolution]');

test('resolveTemplate ДС → Макет_ДС.docx (exists)', () => {
  const r = reg.resolveTemplate('ДС', { templateDir: TEMPLATE_DIR });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.file, 'Макет_ДС.docx');
});

test('resolveTemplate СС → Макет_СС.docx (exists)', () => {
  const r = reg.resolveTemplate('СС', { templateDir: TEMPLATE_DIR });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.file, 'Макет_СС.docx');
});

test('resolveTemplate unknown doc type → unknown_doc_type', () => {
  const r = reg.resolveTemplate('XX', { templateDir: TEMPLATE_DIR });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown_doc_type');
});

test('resolveTemplate with bad dir → template_not_found', () => {
  const r = reg.resolveTemplate('ДС', { templateDir: '/no/such/dir' });
  assert.strictEqual(r.reason, 'template_not_found');
});

test('listTemplates reports both official templates present', () => {
  const list = reg.listTemplates({ templateDir: TEMPLATE_DIR });
  assert.strictEqual(list.length, 2);
  assert.ok(list.every(t => t.ok));
});

console.log('\n[gated DOCX generation]');

test('generate renders against Макет_ДС.docx, 0 missing placeholders, file on disk', () => {
  const r = reg.generate(APP, { docType: 'ДС', templateDir: TEMPLATE_DIR, outDir });
  assert.strictEqual(r.rendered, true);
  assert.ok(r.template_used.endsWith('Макет_ДС.docx'));
  assert.deepStrictEqual(r.missing_placeholders, []);
  assert.ok(fs.existsSync(r.document_path));
  assert.strictEqual(r.mockup_file_name, 'макет_ОсОО Мегуми.docx');
  assert.strictEqual(r.auto_send, false);
});

test('rendered DOCX actually contains substituted values (INN), no leftover {{ }}', () => {
  const r = reg.generate(APP, { docType: 'ДС', templateDir: TEMPLATE_DIR, outDir });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unz-'));
  require('child_process').execFileSync('unzip', ['-o', r.document_path, 'word/document.xml', '-d', tmp], { stdio: 'ignore' });
  const xml = fs.readFileSync(path.join(tmp, 'word', 'document.xml'), 'utf8');
  assert.ok(xml.includes('12345678901234'), 'INN present');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(xml.replace(/<[^>]+>/g, '')), 'no leftover placeholders');
});

test('unknown doc type blocks render (output-only, no throw)', () => {
  const r = reg.generate(APP, { docType: null, templateDir: TEMPLATE_DIR, outDir });
  assert.strictEqual(r.rendered, false);
  assert.strictEqual(r.render_blocked, 'unknown_doc_type');
});

console.log('\n[classification → generation wiring]');

test('classify (adult) → generateFromClassification renders ДС', () => {
  const cls = classifier.classify({ age: 'Женская взрослая', items_text: 'Футболка - 100% хлопок, 6109100000' });
  assert.strictEqual(cls.doc_type, 'ДС');
  const r = reg.generateFromClassification(APP, cls, { templateDir: TEMPLATE_DIR, outDir });
  assert.strictEqual(r.rendered, true);
  assert.ok(r.template_used.endsWith('Макет_ДС.docx'));
});

test('classify with unknown AGE → generation blocked pending operator', () => {
  const cls = classifier.classify({ age: '', items_text: 'Футболка - 100% хлопок, 6109100000' });
  assert.strictEqual(cls.needs_operator, true);
  const r = reg.generateFromClassification(APP, cls, { templateDir: TEMPLATE_DIR, outDir });
  assert.strictEqual(r.rendered, false);
  assert.strictEqual(r.render_blocked, 'classification_needs_operator');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
