'use strict';

// Tests for the Document Extraction Review Package (services/extractionReviewService).
// Pure layer only — buildReviewPackage with an injected OCR/pdf engine, scoring, and
// the doc-type-relevant field selection. No DB required.
//
// Run: node tests/extraction-review.test.js

const assert = require('assert');
const svc = require('../src/services/extractionReviewService');

let pass = 0, fail = 0; const failures = []; const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  })();
  pending.push(p);
  return p;
}

const RECEIPT = [
  'Квитанция об оплате',
  'Дата: 18.06.2026  Время: 14:35:02',
  'Плательщик: ОсОО «Ромашка»',
  'Получатель: ОсОО «Лаборатория»',
  'Итого к оплате: 21 000 сом',
].join('\n');

const DECLARATION = [
  'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ',
  'Заявитель: ИП Иванов Иван Иванович',
  'Номер: ЕАЭС-KG-D-12345',
  'Дата выдачи: 01.03.2026',
  'Действителен до 28.02.2031',
].join('\n');

const REGISTRATION = [
  'СВИДЕТЕЛЬСТВО О ГОСУДАРСТВЕННОЙ РЕГИСТРАЦИИ',
  'ОсОО «Ромашка»',
  'ИНН: 01234567890123',
  'ОГРН: 1234567890123',
].join('\n');

console.log('\n[buildReviewPackage — receipt]');
test('receipt: surfaces only receipt-relevant fields, scores them', async () => {
  const r = await svc.buildReviewPackage(
    { media_ref: '/x/check.jpg', mime_type: 'image/jpeg', file_name: 'чек.jpg' },
    { ocr: () => RECEIPT },
  );
  assert.strictEqual(r.generated, true);
  assert.strictEqual(r.doc_type, 'receipt');
  assert.deepStrictEqual(r.expected_fields, ['payment_amount', 'payment_date', 'payment_time', 'payer', 'recipient']);
  assert.strictEqual(r.extracted_fields.payment_amount, 21000);
  assert.ok(/Ромашка/.test(r.extracted_fields.payer));
  assert.ok(/Лаборатория/.test(r.extracted_fields.recipient));
  // No registration/declaration fields leak into a receipt review.
  assert.ok(!('inn' in r.extracted_fields));
  assert.strictEqual(r.confidence, 100); // all 5 relevant fields present
  assert.strictEqual(r.confidence_band, 'HIGH');
});

console.log('\n[buildReviewPackage — declaration]');
test('declaration: doc number + issue/expiry dates + applicant', async () => {
  const r = await svc.buildReviewPackage(
    { media_ref: '/x/ds.pdf', mime_type: 'application/pdf', file_name: 'декларация.pdf' },
    { pdfText: () => DECLARATION },
  );
  assert.strictEqual(r.doc_type, 'declaration');
  assert.ok(/12345/.test(r.extracted_fields.document_number));
  assert.strictEqual(r.extracted_fields.issue_date, '2026-03-01');
  assert.strictEqual(r.extracted_fields.expiry_date, '2031-02-28');
  assert.ok(/Иванов/.test(r.extracted_fields.applicant));
  assert.strictEqual(r.method, 'pdftotext');
});

console.log('\n[buildReviewPackage — registration]');
test('registration: legal entity + ИНН + registration id', async () => {
  const r = await svc.buildReviewPackage(
    { media_ref: '/x/reg.jpg', mime_type: 'image/jpeg', file_name: 'свидетельство.jpg' },
    { ocr: () => REGISTRATION },
  );
  assert.strictEqual(r.doc_type, 'registration');
  assert.deepStrictEqual(r.expected_fields, ['legal_entity', 'inn', 'registration_id']);
  assert.strictEqual(r.extracted_fields.inn, '01234567890123');
  assert.strictEqual(r.extracted_fields.registration_id, '1234567890123');
});

console.log('\n[scoring + impact]');
test('partial extraction → MEDIUM/LOW band with missing list', async () => {
  const r = await svc.buildReviewPackage(
    { media_ref: '/x/p.jpg', mime_type: 'image/jpeg', file_name: 'чек.jpg' },
    { ocr: () => 'Квитанция об оплате\nИтого к оплате: 5000 сом' }, // only amount of 5 receipt fields
  );
  assert.strictEqual(r.doc_type, 'receipt');
  assert.strictEqual(r.confidence, 20); // 1/5
  assert.ok(r.missing.some(m => m.field === 'payer'));
});

test('output-only contract: impact never promises a write', async () => {
  const r = await svc.buildReviewPackage({ media_ref: '/x/r.jpg', mime_type: 'image/jpeg' }, { ocr: () => RECEIPT });
  assert.ok(/CANDIDATES/.test(r.impact));
  assert.ok(/Nothing is written/.test(r.impact));
});

test('unreadable file → generated:false with reason', async () => {
  const r = await svc.buildReviewPackage({ media_ref: '/x/none.png', mime_type: 'image/png' }, { /* no engine, no real file */ });
  assert.strictEqual(r.generated, false);
  assert.ok(['ocr_not_available', 'file_not_found'].includes(r.reason));
});

test('dedupeKey keys on origin + source ref', () => {
  const k = svc.dedupeKey({ media_ref: '/x/r.jpg' }, 'whatsapp');
  assert.strictEqual(k, 'REVIEW_DOCUMENT_EXTRACTION|whatsapp|/x/r.jpg');
});

Promise.all(pending).then(() => {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
});
