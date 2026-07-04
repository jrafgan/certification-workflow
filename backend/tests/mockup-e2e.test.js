'use strict';

// End-to-end test: REAL «Новая форма» row → classification → DS/SS → template selection →
// real DOCX → download resolution. Uses the actual official Макет_ДС.docx. Needs system
// zip/unzip. Run: node tests/mockup-e2e.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const mapper = require('../src/services/formFieldMapper');
const gen = require('../src/services/mockupGenerationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const TEMPLATE_DIR = path.resolve(__dirname, '../templates');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-e2e-'));

// Real form header (A..R) and a REAL row from "Новая форма" (sheet row 570).
const HEADER = [
  'А', 'ваш номер ватсап', 'Ваше юр. лицо ?', 'название вашего юр. лица или организации ?',
  'Страна регистрации вашего юр. лица ?', 'Ваш юридический адрес ?', 'Ваш номер телефона ?',
  'Ваш e-mail ?', 'Ваш ОГРН /БИН/ИИН/ИНН', 'Название юр. лица производителя (если знаете)?',
  'Страна производства товара ?', 'Адрес производства товара ?', 'Название магазина, марка продукции ?',
  'Наименование бренда ?', 'Товар детский или взрослый ?',
  'Обязательно напишите список ваших товаров - состав - ТН ВЭД',
  'Если уже писали то не обязательно состав ткани', 'Если уже писали то не обязательно ТНВЭД',
];
const ROW = [
  '22.06.2026', '+996220011393', 'ИП', 'Кулматбек уулу Эламан', 'Кыргызстан',
  'Кыргызстан, Талаская обл., с.Бакай-Ата, Куштай, д. 2.', '+996220011393', 'kira.siva1288@gmail.com',
  '22310199300186', 'Г.Бишкек ул 7апреля дом 7', 'Кыргызстан', 'Кыргызстан, Талаская обл., с. Бакай-Ата',
  'Klara', 'Klara SA', 'Женская взрослая',
  'Хомут - 60% хлопок, 30% полиэстер, 10% шерсть , 6104310000   Жакет - 60% хлопок, 30% полиэстер, 10% шерсть, 6104310000  Бант - 60% хлопок, 10% эластан, 15% полиамид, 15% вискоза,  6110209900,  Рубашка полоска, 80% хлопок, 10% полиэстер,  10% вискоза, 6106200000, Лен -60% хлопок, 10% эластан, 15% полиамид, 15% вискоза,  6106200000',
  '', '',
];

console.log('\n[END-TO-END: Новая форма row → DOCX → download]');

const application = mapper.mapRow(HEADER, ROW, { docType: null });
const result = gen.generateFromApplication(application, { baseDir: BASE, templateDir: TEMPLATE_DIR });

test('1. classification: adult / knitwear / ДС / 3 comp groups / 3 protocols / 6 samples / lab уточняется', () => {
  assert.strictEqual(result.generated, true);
  const c = result.classification;
  assert.strictEqual(c.age, 'adult');
  assert.strictEqual(c.category, 'knitwear');
  assert.strictEqual(c.doc_type, 'ДС');
  assert.strictEqual(c.composition_groups, 3);
  assert.strictEqual(c.protocol_groups, 3);
  assert.strictEqual(c.samples_required, 6);
  assert.strictEqual(c.laboratory, 'уточняется');
});

test('2. selected template = Макет_ДС.docx', () => {
  assert.ok(result.template_used.endsWith('Макет_ДС.docx'), result.template_used);
});

test('3. generated filename = макет_Кулматбек уулу Эламан.docx + file exists', () => {
  assert.strictEqual(result.mockup_file_name, 'макет_Кулматбек уулу Эламан.docx');
  assert.ok(fs.existsSync(result.document_path));
});

test('4. download URL points at the generation id', () => {
  assert.strictEqual(result.download_url, `/api/mockups/${result.generation_id}/download`);
});

test('5. download resolver returns the real file (path-safe)', () => {
  const dl = gen.resolveDownload(result.generation_id, 'mockup', { baseDir: BASE });
  assert.ok(dl && fs.existsSync(dl.path));
  assert.strictEqual(dl.filename, 'макет_Кулматбек уулу Эламан.docx');
  // traversal / unknown id rejected
  assert.strictEqual(gen.resolveDownload('../../etc', 'mockup', { baseDir: BASE }), null);
});

test('6. rendered DOCX has real values (INN) and no leftover {{ }}', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unz-'));
  cp.execFileSync('unzip', ['-o', result.document_path, 'word/document.xml', '-d', tmp], { stdio: 'ignore' });
  const xml = fs.readFileSync(path.join(tmp, 'word', 'document.xml'), 'utf8');
  assert.ok(xml.includes('22310199300186'), 'INN substituted');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(xml.replace(/<[^>]+>/g, '')), 'no leftover placeholders');
});

// ── Required visible output ──────────────────────────────────────────────────
console.log('\n=== E2E RESULT ===');
console.log('1. Classification :', JSON.stringify(result.classification));
console.log('2. Template       :', result.template_used);
console.log('3. Filename       :', result.mockup_file_name);
console.log('4. Download URL    :', result.download_url, '(attachment:', result.attachment_download_url + ')');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
