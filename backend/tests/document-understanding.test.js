'use strict';

// Tests for Document Understanding.
//   Pure: extractFields over representative RU receipt/certificate text.
//   Routing: extractText dispatch by file kind with injected pdf/ocr engines.
//   Integration: real `pdftotext` round-trip on a generated text PDF (if poppler present).
//
// Run: node tests/document-understanding.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const du = require('../src/services/documentUnderstandingService');

let pass = 0, fail = 0, skip = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const RECEIPT = [
  'Квитанция об оплате',
  'Дата: 18.06.2026  Время: 14:35:02',
  'Плательщик: ОсОО «Ромашка»',
  'ИНН: 01234567890123',
  'Назначение платежа: оплата за декларацию',
  'Итого к оплате: 21 000 сом',
  '№ операции: A-77Service',
].join('\n');

const CERT = [
  'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ',
  'Заявитель: ИП Иванов Иван Иванович',
  'ИНН 20987654321098',
  'Номер: ЕАЭС-KG-D-12345',
  'Дата выдачи: 01.03.2026',
  'Действителен до 28.02.2031',
].join('\n');

const REG = [
  'СВИДЕТЕЛЬСТВО О ГОСУДАРСТВЕННОЙ РЕГИСТРАЦИИ',
  'ОсОО «Ромашка»',
  'ИНН: 01234567890123',
  'ОГРН: 1234567890123',
].join('\n');

console.log('\n[Pure extractFields]');

test('receipt: amount / date / time / entity / ИНН / doc number', () => {
  const r = du.extractFields(RECEIPT);
  assert.strictEqual(r.fields.payment_amount.value, 21000);
  assert.strictEqual(r.fields.payment_date.value, '2026-06-18');
  assert.strictEqual(r.fields.payment_time.value, '14:35:02');
  assert.ok(/Ромашка/.test(r.fields.legal_entity.value));
  assert.strictEqual(r.fields.inn.value, '01234567890123');
  assert.ok(r.fields.document_number.value.startsWith('A-77'));
  assert.strictEqual(r.confidence, 'HIGH');
});

test('receipt: payer / recipient parties', () => {
  const r = du.extractFields(RECEIPT);
  assert.ok(/Ромашка/.test(r.fields.payer.value), 'payer parsed');
});

test('certificate: applicant + ИНН + document number + issue/expiry dates', () => {
  const r = du.extractFields(CERT);
  assert.ok(/ИП Иванов/.test(r.fields.applicant.value), 'applicant parsed');
  assert.strictEqual(r.fields.inn.value, '20987654321098');
  assert.ok(/12345/.test(r.fields.document_number.value));
  assert.strictEqual(r.fields.issue_date.value, '2026-03-01');
  assert.strictEqual(r.fields.expiry_date.value, '2031-02-28');
  assert.strictEqual(r.doc_type, 'declaration');
});

test('registration: legal entity + ИНН + registration id (ОГРН)', () => {
  const r = du.extractFields(REG);
  assert.ok(/Ромашка/.test(r.fields.legal_entity.value));
  assert.strictEqual(r.fields.inn.value, '01234567890123');
  assert.strictEqual(r.fields.registration_id.value, '1234567890123');
  assert.strictEqual(r.doc_type, 'registration');
});

test('inferDocType: receipt detected from content', () => {
  assert.strictEqual(du.inferDocType(RECEIPT), 'receipt');
});

test('empty / non-document text → NONE', () => {
  const r = du.extractFields('привет, как дела');
  assert.strictEqual(r.confidence, 'NONE');
  assert.strictEqual(r.found.length, 0);
});

console.log('\n[extractText routing]');

test('PDF routes to the pdf engine (injected)', () => {
  const r = du.extractText({ media_ref: '/x/file.pdf', mime_type: 'application/pdf' }, { pdfText: () => RECEIPT });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.method, 'pdftotext');
});

test('image routes to OCR (injected)', () => {
  const r = du.extractText({ media_ref: '/x/scan.jpg', mime_type: 'image/jpeg' }, { ocr: () => 'ИНН 01234567890123' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.method, 'ocr');
});

test('image with NO OCR engine → ocr_not_available (honest)', () => {
  const r = du.extractText({ media_ref: '/x/scan.png', mime_type: 'image/png' }, { /* no ocr, no real file */ });
  assert.strictEqual(r.ok, false);
  // either ocr_not_available (no tesseract) or file_not_found if a real engine exists
  assert.ok(['ocr_not_available', 'file_not_found'].includes(r.reason));
});

test('understandDocument end-to-end with injected pdf engine', () => {
  const r = du.understandDocument({ media_ref: '/x/r.pdf', mime_type: 'application/pdf', file_name: 'чек.pdf' }, { pdfText: () => RECEIPT });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fields.payment_amount.value, 21000);
  assert.strictEqual(r.fields.inn.value, '01234567890123');
});

console.log('\n[Integration: real pdftotext]');

function popplerAvailable() { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }
function libreofficeAvailable() { try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }

(function realPdfRoundtrip() {
  if (!popplerAvailable() || !libreofficeAvailable()) { skip++; console.log('  SKIP  real pdftotext — poppler/libreoffice not both present'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'du-'));
  try {
    const txt = path.join(dir, 'receipt.txt');
    fs.writeFileSync(txt, RECEIPT, 'utf8');
    // Convert the UTF-8 (Cyrillic) text to a real PDF, then read it back through the engine.
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, txt], { stdio: 'ignore', timeout: 60000 });
    const pdf = path.join(dir, 'receipt.pdf');
    test('real PDF → pdftotext → fields extracted (Cyrillic round-trip)', () => {
      assert.ok(fs.existsSync(pdf), 'pdf generated');
      const r = du.understandDocument({ media_ref: pdf, mime_type: 'application/pdf', file_name: 'receipt.pdf' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.method, 'pdftotext');
      assert.strictEqual(r.fields.inn.value, '01234567890123');
      assert.strictEqual(r.fields.payment_amount.value, 21000);
    });
  } catch (e) { skip++; console.log('  SKIP  real pdftotext —', e.message.split('\n')[0]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
