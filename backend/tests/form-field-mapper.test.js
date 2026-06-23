'use strict';

// tests/form-field-mapper.test.js — Google Form → canonical field mapper (pure, no network).
// Headers below mirror the REAL "Ответы на форму (1)" layout. Run: node tests/form-field-mapper.test.js

const assert = require('assert');
const m = require('../src/services/formFieldMapper');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// Real form header row (A..R), abbreviated to the meaningful header text.
const HEADER = [
  'А',                                                    // A timestamp
  'ваш номер ватсап.  Пример: +996555123654',             // B
  'Ваше юр. лицо ?',                                       // C
  'название вашего юр. лица или организации ?  Пример: Ив',// D
  'Страна регистрации вашего юр. лица ?',                  // E
  'Ваш юридический адрес ?  Пример: Кырг',                 // F
  'Ваш номер телефона ?  Пример: +996777655623',          // G
  'Ваш e-mail ?  Пример: aitolkun@gmail.com',             // H
  'Ваш ОГРН /БИН/ИИН/ИНН',                                 // I
  'Название юр. лица производителя (если знаете)?',        // J
  'Страна производства товара ?  Пример: Кыргызстан',      // K
  'Адрес производства товара ?  Пример: Чуйская обл.',     // L
  'Название магазина, марка продукции ?',                  // M
  'Наименование бренда ?  Пример: Wow dress',              // N
  'Товар детский или взрослый ?',                          // O
  'Обязательно напишите список ваших товаров - состав - ТН ВЭД', // P
  'Если уже писали то не обязательно состав ткани одежды', // Q
  'Если уже писали то не обязательно если знаете ТНВЭД',   // R
];

console.log('\n[detectColumns — real header layout]');
test('maps each canonical field to the correct column', () => {
  const c = m.detectColumns(HEADER);
  const L = (i) => i; // index
  assert.strictEqual(c.APPLICANT_L_E_NAME, 3, 'D');
  assert.strictEqual(c.LEGAL_ENTITY, 2, 'C');
  assert.strictEqual(c.INN, 8, 'I');
  assert.strictEqual(c.L_E_ADRESS, 5, 'F');
  assert.strictEqual(c.PHONE_NUMBER, 6, 'G');
  assert.strictEqual(c.PHONE_WHATSAPP, 1, 'B');
  assert.strictEqual(c.EMAIL, 7, 'H');
  assert.strictEqual(c.MANUFACTURER_L_E_NAME, 9, 'J');
  assert.strictEqual(c.MANUFACTURER_COUNTRY, 10, 'K');
  assert.strictEqual(c.MANUFACTURER_ADRESS, 11, 'L');
  assert.strictEqual(c.BRAND_NAME, 13, 'N');
  assert.strictEqual(c.L_E_COUNTRY, 4, 'E');
  assert.strictEqual(c.AGE, 14, 'O');
  assert.strictEqual(c.ITEMS, 15, 'P (combined list)');
  assert.strictEqual(c.ITEM_COMPOSITION, 16, 'Q (not P)');
  assert.strictEqual(c.TNVED, 17, 'R (not P)');
});

console.log('\n[mapRow — real row]');
const ROW = [
  '10.01.2026 13:09:36', '+996557660002', 'ИП', 'Ысмаылов Нуртилек', 'Кыргызстан',
  'Ошский обл., Кара-Суу', '+996557660002', 'nurseyit1989@mail.ru', '21808200550605',
  'ИП Ысмаылов Нуртилек', 'Кыргызстан', 'Ошская обл.', 'MixStore', 'ROSH', 'Взрослая',
  'экстракт женьшеня на нетканой основе', '', '3005100000',
];

test('extracts the 11 canonical fields from a real row', () => {
  const a = m.mapRow(HEADER, ROW, { docType: 'ДС' });
  assert.strictEqual(a.applicant.name, 'Ысмаылов Нуртилек');
  assert.strictEqual(a.applicant.inn, '21808200550605');
  assert.strictEqual(a.applicant.phone, '+996557660002');
  assert.strictEqual(a.applicant.email, 'nurseyit1989@mail.ru');
  assert.strictEqual(a.manufacturer.name, 'ИП Ысмаылов Нуртилек');
  assert.strictEqual(a.manufacturer.country, 'Кыргызстан');
  assert.strictEqual(a.brand, 'ROSH');
  assert.strictEqual(a.legal_entity, 'ИП');
  assert.strictEqual(a.tnved_text, '3005100000');
  assert.strictEqual(a.items[0].tnved, '3005100000');
  assert.strictEqual(a.age, 'Взрослая', 'AGE (col O) surfaced');
  assert.strictEqual(a.l_e_country, 'Кыргызстан', 'L_E_COUNTRY (col E) surfaced');
});

test('mapper → classifier hand-off: AGE drives DS/SS', () => {
  const classifier = require('../src/services/newFormClassificationService');
  const a = m.mapRow(HEADER, ROW, {});
  const cls = classifier.classify({ age: a.age, items_text: a.items_text });
  assert.strictEqual(cls.doc_type, 'ДС');          // «Взрослая» → ДС
  assert.strictEqual(cls.needs_operator, false);
});

test('flags doc_type missing when not supplied', () => {
  const a = m.mapRow(HEADER, ROW, {});
  assert.ok(a._meta.field_warnings.some(w => w.code === 'doc_type_not_in_form'));
});

test('flags multi-TN-VED structuring need', () => {
  const row2 = [...ROW]; row2[17] = '3005100000, 6206300000'; // two codes in the TN VED column
  const a = m.mapRow(HEADER, row2, { docType: 'ДС' });
  assert.strictEqual(a.items.length, 2);
  assert.ok(a._meta.field_warnings.some(w => w.code === 'product_structuring_needed'));
});

test('missing required fields are reported (empty row)', () => {
  const a = m.mapRow(HEADER, [], { docType: 'ДС' });
  const w = a._meta.field_warnings.find(x => x.code === 'missing_required_fields');
  assert.ok(w && w.fields.includes('APPLICANT_L_E_NAME') && w.fields.includes('INN'));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
