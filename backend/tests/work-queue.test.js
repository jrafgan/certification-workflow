'use strict';

// Tests for the agent work queue (services/workQueueService) + per-row generation
// (mockupGenerationService.generateFromForm). Pure/injected + one real render. No live network.
// Run: node tests/work-queue.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wq = require('../src/services/workQueueService');
const gen = require('../src/services/mockupGenerationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

const { matchKey } = require('../src/utils/phoneUtils');
const TEMPLATE_DIR = path.resolve(__dirname, '../templates');

const HEADER = [
  'А', 'ваш номер ватсап', 'Ваше юр. лицо ?', 'название вашего юр. лица или организации ?',
  'Страна регистрации вашего юр. лица ?', 'Ваш юридический адрес ?', 'Ваш номер телефона ?',
  'Ваш e-mail ?', 'Ваш ОГРН /БИН/ИИН/ИНН', 'Название юр. лица производителя ?',
  'Страна производства товара ?', 'Адрес производства товара ?', 'Название магазина ?',
  'Наименование бренда ?', 'Товар детский или взрослый ?',
  'Обязательно напишите список ваших товаров - состав - ТН ВЭД', 'состав ткани', 'ТНВЭД',
];
// row(name, phone, age, items)
const R = (name, phone, age = 'Взрослая', items = 'Футболка - 100% хлопок, 6109100000') =>
  ['ts', phone, 'ИП', name, 'Кыргызстан', 'Бишкек', phone, 'a@b.kg', '111', '', '', '', '', 'Brand', age, items, '', ''];

const ROWS = [
  R('ИП Алиев', '+996700111111'),     // row 2  (older dup)
  R('ОсОО Бета', '+996700222222'),     // row 3
  R('ИП Алиев', '+996700111111'),     // row 4  (newer dup — kept)
  R('', '+996700444444'),              // row 5  (no name → skipped)
  R('ОсОО Гамма', '+996700333333'),   // row 6  (launched → excluded)
];
const readRows = async () => ({ header: HEADER, rows: ROWS });

(async () => {
  console.log('\n[applicationState — new vs launched]');
  await test('launched phone → launched', () => {
    const idx = new Set([matchKey('+996700333333')]);
    assert.strictEqual(wq.applicationState({ applicant: { phone: '+996700333333' } }, idx), 'launched');
  });
  await test('unknown phone → new', () => {
    assert.strictEqual(wq.applicationState({ applicant: { phone: '+996700999999' } }, new Set()), 'new');
  });

  console.log('\n[newApplications — sheet × launched index, deduped]');
  const apps = await wq.newApplications({ readRows, launchedPhones: new Set([matchKey('+996700333333')]) });
  await test('excludes launched, skips empty, dedupes by phone (newest wins), newest-first', () => {
    assert.strictEqual(apps.length, 2);                        // 222222 + 111111 (333333 excluded, empty skipped, dup collapsed)
    assert.strictEqual(apps[0].phone, '+996700111111');        // newest row (row 4) first
    assert.strictEqual(apps[0].sheet_row, 4);
    assert.strictEqual(apps[1].phone, '+996700222222');
    assert.ok(apps.every(a => a.action === 'create_mockup'));
    assert.ok(!apps.some(a => a.phone === '+996700333333'));
  });

  console.log('\n[buildLaunchedIndex — live «Декларация» J(phone)+N(status)]');
  // Declaration row: J=col 9 (phone), N=col 13 (status); other cols irrelevant.
  const DR = (phone, status) => { const r = new Array(14).fill(''); r[wq.DECL_PHONE_COL] = phone; r[wq.DECL_STATUS_COL] = status; return r; };
  const readDeclaration = async () => [
    DR('+996700333333', 'завершен'),   // launched
    DR('+996700222222', 'отказ'),      // launched
    DR('+996700111111', ''),           // empty status → NOT launched
    DR('+996700999999', 'Запустить'),  // still at launch → NOT launched
  ];
  await test('launched = phone in «Декларация» with real status (≠ empty/«запустить»)', async () => {
    const idx = await wq.buildLaunchedIndex({ readDeclaration });
    assert.ok(idx.has(matchKey('+996700333333')));
    assert.ok(idx.has(matchKey('+996700222222')));
    assert.ok(!idx.has(matchKey('+996700111111')));   // empty status
    assert.ok(!idx.has(matchKey('+996700999999')));   // «Запустить»
  });
  await test('newApplications uses live «Декларация» to exclude launched', async () => {
    // ROWS has 333333 (launched in decl) + 111111/222222 (not). Expect 333333 excluded via decl.
    const decl = async () => [DR('+996700333333', 'завершен')];
    const r = await wq.newApplications({ readRows, readDeclaration: decl });
    assert.ok(!r.some(a => a.phone === '+996700333333'));
    assert.ok(r.some(a => a.phone === '+996700222222'));
  });

  console.log('\n[build — 8 sections]');
  const q = await wq.build({ readRows, launchedPhones: new Set(), models: {} });
  await test('returns exactly the 8 required sections in order', () => {
    assert.deepStrictEqual(q.sections.map(s => s.key),
      ['new_applications', 'waiting_payment', 'waiting_samples', 'waiting_mockup', 'on_approval', 'waiting_original', 'status_conflicts', 'forgotten']);
  });
  await test('new_applications populated from the sheet; order lanes resilient to no DB', () => {
    const na = q.sections.find(s => s.key === 'new_applications');
    assert.strictEqual(na.count, 3);                           // 111111, 222222, 444444? no — 444444 has no name. 111111(dedup)+222222 +333333? 333333 not launched here → included → 3
    assert.strictEqual(typeof q.total, 'number');
  });

  console.log('\n[generateFromForm — specific row (not "latest")]');
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-'));
  await test('generates for the chosen row → ДС, correct sheet_row', () => {
    const r = require('../src/services/mockupGenerationService');
    return Promise.resolve(r.generateFromForm(3, { baseDir, templateDir: TEMPLATE_DIR }, { readRows }))
      .then(res => {
        assert.strictEqual(res.generated, true);
        assert.strictEqual(res.sheet_row, 3);
        assert.strictEqual(res.doc_type, 'ДС');
        assert.strictEqual(res.mockup_file_name, 'макет_ОсОО Бета.docx');
        assert.ok(fs.existsSync(res.document_path));
      });
  });
  await test('row out of range → blocked row_not_found (no throw)', async () => {
    const res = await gen.generateFromForm(999, { baseDir, templateDir: TEMPLATE_DIR }, { readRows });
    assert.strictEqual(res.generated, false);
    assert.strictEqual(res.blocked, 'row_not_found');
  });
  await test('empty row → blocked empty_row', async () => {
    const res = await gen.generateFromForm(5, { baseDir, templateDir: TEMPLATE_DIR }, { readRows });
    assert.strictEqual(res.blocked, 'empty_row');
  });
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
