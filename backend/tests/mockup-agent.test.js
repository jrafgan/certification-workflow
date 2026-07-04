'use strict';

// tests/mockup-agent.test.js — Mockup Agent core (pure logic + fill engine). No DB / network.
// Run: node tests/mockup-agent.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const m = require('../src/services/mockupAgentService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const baseApp = {
  doc_type: 'декларация',
  applicant: { name: 'ИП Жолубаева Жаннат', inn: '12201197500197', address: 'г. Ош', phone: '+996706439615', email: 'a@b.kg' },
  manufacturer: { name: 'ООО Телида', country: 'Китай', address: 'Гуанчжоу' },
  brand: 'Телида',
  items: [{ name: 'Тюль', composition: '100% полиэстер', tnved: '6303929000' }],
};

console.log('\n[resolveFields / placeholders]');
test('maps §1 fields to placeholders', () => {
  const f = m.resolveFields(baseApp);
  assert.strictEqual(f.APPLICANT_L_E_NAME, 'ИП Жолубаева Жаннат');
  assert.strictEqual(f.INN, '12201197500197');
  assert.strictEqual(f.MANUFACTURER_COUNTRY, 'Китай');
  assert.strictEqual(f.BRAND_NAME, 'Телида');
  assert.strictEqual(f.TNVED, '6303929000');
});
test('absent field → empty string (no undefined)', () => {
  const f = m.resolveFields({ applicant: {} });
  assert.strictEqual(f.EMAIL, '');
  assert.strictEqual(f.ITEMS, '');
});
test('normDocType', () => {
  assert.strictEqual(m.normDocType('декларация'), 'ДС');
  assert.strictEqual(m.normDocType('сертификат'), 'СС');
  assert.strictEqual(m.normDocType('что-то'), null);
});

console.log('\n[§6 four-per-composition warnings]');
test('4 products in one composition → no warning', () => {
  const app = { items: ['a', 'b', 'c', 'd'].map(n => ({ name: n, composition: '100% хлопок', tnved: '6204520000' })) };
  assert.strictEqual(m.compositionWarnings(app).length, 0);
});
test('5 products in one composition → warning', () => {
  const app = { items: ['a', 'b', 'c', 'd', 'e'].map(n => ({ name: n, composition: '100% хлопок', tnved: '6204520000' })) };
  const w = m.compositionWarnings(app);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].code, 'possible_additional_pi');
  assert.strictEqual(w[0].message, 'Possible additional PI required. Operator review needed.');
  assert.strictEqual(w[0].auto_decide, false);
});
test('5 distinct TN VED in one composition → warning', () => {
  const app = { items: ['1', '2', '3', '4', '5'].map((t, i) => ({ name: 'p' + i, composition: 'шёлк', tnved: '620452000' + t })) };
  assert.strictEqual(m.compositionWarnings(app)[0].tnved_count, 5);
});
test('5 products spread across 2 compositions (≤4 each) → no warning', () => {
  const app = { items: [
    ...['a', 'b', 'c'].map(n => ({ name: n, composition: 'хлопок', tnved: '1' })),
    ...['d', 'e'].map(n => ({ name: n, composition: 'шёлк', tnved: '2' })),
  ] };
  assert.strictEqual(m.compositionWarnings(app).length, 0);
});

console.log('\n[§7 multi-TN VED attachment]');
test('single TN VED → no attachment, main cell = the code', () => {
  assert.strictEqual(m.buildAttachment(baseApp), null);
  assert.strictEqual(m.tnvedField(baseApp), '6303929000');
});
test('multiple TN VED → attachment table + main cell references it', () => {
  const app = { items: [
    { name: 'Блузка', composition: 'хлопок', tnved: '6206300000' },
    { name: 'Юбка',   composition: 'хлопок', tnved: '6204520000' },
  ] };
  const att = m.buildAttachment(app);
  assert.deepStrictEqual(att.columns, ['product_name', 'composition', 'tnved']);
  assert.strictEqual(att.rows.length, 2);
  assert.strictEqual(att.main_doc_references_attachment, true);
  assert.strictEqual(m.tnvedField(app), 'см. приложение');
});

console.log('\n[fill engine — real .docx round trip]');
test('fillTemplate replaces placeholders and reports missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-tpl-'));
  // Build a minimal synthetic .docx (zip with word/document.xml) carrying two placeholders.
  fs.mkdirSync(path.join(dir, 'word'));
  fs.writeFileSync(path.join(dir, 'word', 'document.xml'),
    '<?xml version="1.0"?><w:document><w:body>' +
    '<w:t>{{APPLICANT_L_E_NAME}}</w:t><w:t>{{TNVED}}</w:t><w:t>{{INN}}</w:t>' +
    '</w:body></w:document>');
  const tpl = path.join(dir, 'declaration.docx');
  cp.execFileSync('zip', [tpl, 'word/document.xml'], { cwd: dir, stdio: 'ignore' });

  const filled = m.fillTemplate(tpl, { APPLICANT_L_E_NAME: 'ИП Тест', TNVED: '6303929000', INN: '' });
  // Read back the produced document.xml from the output buffer.
  const back = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-out-'));
  fs.writeFileSync(path.join(back, 'out.docx'), filled.buffer);
  cp.execFileSync('unzip', ['-o', path.join(back, 'out.docx'), 'word/document.xml', '-d', back], { stdio: 'ignore' });
  const xml = fs.readFileSync(path.join(back, 'word', 'document.xml'), 'utf8');

  assert.ok(xml.includes('ИП Тест'), 'applicant replaced');
  assert.ok(xml.includes('6303929000'), 'tnved replaced');
  assert.ok(xml.includes('{{INN}}'), 'empty value leaves placeholder');
  assert.deepStrictEqual(filled.missing_placeholders, ['INN']);
});

console.log('\n[proposeMockup — output-only, gated]');
test('proposal is draft, never sends, requires both approvals', () => {
  const p = m.proposeMockup(baseApp, {});
  assert.strictEqual(p.status, 'draft');
  assert.strictEqual(p.auto_send, false);
  assert.strictEqual(p.requires.operator_approval, true);
  assert.strictEqual(p.requires.client_approval, true);
  assert.strictEqual(p.doc_type, 'ДС');
  assert.strictEqual(p.rendered, false);
  assert.strictEqual(p.render_blocked, 'no_template_dir'); // no template provided → blocked, not invented
});

console.log('\n[§9 lab package — assembled, never auto-sends]');
test('buildLabPackage assembles contents, auto_send false', () => {
  const p = m.proposeMockup(baseApp, {});
  const pkg = m.buildLabPackage(p, { clientCertPath: '/tmp/cert.jpg', standardEmailText: 'Здравствуйте, ...' });
  assert.strictEqual(pkg.auto_send, false);
  assert.strictEqual(pkg.operator_approval_required, true);
  assert.strictEqual(pkg.contents.client_registration_certificate, '/tmp/cert.jpg');
});

console.log('\n[§7 file naming]');
test('мокап/приложение file names use exact APPLICANT name', () => {
  assert.strictEqual(m.mockupFileName('ОсОО Мегуми'), 'макет_ОсОО Мегуми.docx');
  assert.strictEqual(m.mockupFileName('ИП Айбашева Карина Айбашевна'), 'макет_ИП Айбашева Карина Айбашевна.docx');
  assert.strictEqual(m.attachmentFileName('ОсОО Мегуми'), 'приложение_ОсОО Мегуми.docx');
});
test('file name strips only filesystem-illegal chars', () => {
  assert.strictEqual(m.mockupFileName('ООО "Тест"/X'), 'макет_ООО Тест X.docx');
});

console.log('\n[fill engine — placeholders SPLIT across Word runs]');
test('fillTemplate rejoins <FIELD> split across runs and fills it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-'));
  fs.mkdirSync(path.join(dir, 'word'));
  // <APPLICANT_L_E_NAME> escaped + split across three <w:t> runs (as real Word does).
  fs.writeFileSync(path.join(dir, 'word', 'document.xml'),
    '<?xml version="1.0"?><w:document><w:body><w:p>' +
    '<w:r><w:t>&lt;APPLICANT_</w:t></w:r><w:r><w:t>L_E_</w:t></w:r><w:r><w:t>NAME&gt;</w:t></w:r>' +
    '</w:p></w:body></w:document>');
  const tpl = path.join(dir, 'declaration.docx');
  cp.execFileSync('zip', [tpl, 'word/document.xml'], { cwd: dir, stdio: 'ignore' });

  const filled = m.fillTemplate(tpl, { APPLICANT_L_E_NAME: 'ОсОО Мегуми' });
  const back = fs.mkdtempSync(path.join(os.tmpdir(), 'split-out-'));
  fs.writeFileSync(path.join(back, 'o.docx'), filled.buffer);
  cp.execFileSync('unzip', ['-o', path.join(back, 'o.docx'), 'word/document.xml', '-d', back], { stdio: 'ignore' });
  const xml = fs.readFileSync(path.join(back, 'word', 'document.xml'), 'utf8');
  assert.ok(xml.includes('ОсОО Мегуми'), 'split placeholder filled');
  assert.deepStrictEqual(filled.missing_placeholders, []);
});

console.log('\n[§7 attachment docx generation]');
test('renderAttachmentDocx produces a valid docx with the table rows', () => {
  const att = m.buildAttachment({ items: [
    { name: 'Блузка', composition: 'хлопок', tnved: '6206300000' },
    { name: 'Юбка',   composition: 'хлопок', tnved: '6204520000' },
  ] });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'att-')), 'приложение_X.docx');
  m.renderAttachmentDocx(att, out);
  cp.execFileSync('unzip', ['-t', out], { stdio: 'ignore' }); // valid zip or throws
  const txt = cp.execFileSync('unzip', ['-p', out, 'word/document.xml']).toString().replace(/<[^>]+>/g, '');
  assert.ok(txt.includes('Блузка') && txt.includes('6204520000') && txt.includes('ТН ВЭД'));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
