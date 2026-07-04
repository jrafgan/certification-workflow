'use strict';

// Tests for lab email preparation (services/labEmailService) — DRAFT only, never sends.
// Pure routing/subject/dup + injected «Декларация» count. No live network.
// Run: node tests/lab-email.test.js

const assert = require('assert');
const le = require('../src/services/labEmailService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

(async () => {
  console.log('\n[routing — ДС: получатель не задан (Дастану не пишем), СС→Бермет]');
  await test('ДС → recipient unset by default (no Dastan)', () => {
    const r = le.routeLab('ДС');
    assert.strictEqual(r.email, '');           // unknown variant → получателя нет, пока не уточнили документы на цех
    assert.strictEqual(r.recipient_name, '');
  });
  await test('СС → Kyrgyz Test - Бермет <mng-1@kyrgyz-test.kg>', () => {
    const r = le.routeLab('СС');
    assert.strictEqual(r.lab, 'Бермет');
    assert.strictEqual(r.email, 'mng-1@kyrgyz-test.kg');
  });

  console.log('\n[subject + sequential numbering (KB §13)]');
  await test('first time → plain name', () => {
    assert.strictEqual(le.subjectFor('ИП Иванов', 0), 'ИП Иванов');
  });
  await test('name already exists N times → «name N+1»', () => {
    assert.strictEqual(le.subjectFor('ИП Иванов', 1), 'ИП Иванов 2');
    assert.strictEqual(le.subjectFor('ИП Иванов', 3), 'ИП Иванов 4');
  });

  console.log('\n[buildLabEmail — gated draft]');
  await test('builds ДС draft but flags missing recipient, never sends', () => {
    const e = le.buildLabEmail({ clientName: 'ИП Иванов', docType: 'ДС', piCount: 3, additionalPi: 2, mockupFileName: 'макет_ИП Иванов.docx', attachmentFileName: 'приложение_ИП Иванов.docx', priorCount: 0 });
    assert.strictEqual(e.ok, true);
    assert.strictEqual(e.to_email, null);              // Дастану не пишем; новая почта ещё не задана
    assert.strictEqual(e.to, null);                    // нет битого "<>"
    assert.strictEqual(e.recipient_configured, false);
    assert.ok(e.recipient_warning && /швейный цех/.test(e.recipient_warning));  // ДС: сначала уточнить документы на цех
    assert.strictEqual(e.declaration_variant, 'unknown');
    assert.strictEqual(e.subject, 'ИП Иванов');
    assert.strictEqual(e.auto_send, false);
    assert.ok(e.attachments.some(a => a.kind === 'mockup'));
    assert.ok(e.attachments.some(a => a.kind === 'client_certificate'));
    assert.ok(/декларацию/.test(e.body));
    assert.strictEqual(e.duplicate_warning, null);
  });

  await test('prior name → numbered subject + duplicate warning', () => {
    const e = le.buildLabEmail({ clientName: 'ОсОО Мегуми', docType: 'СС', priorCount: 2 });
    assert.strictEqual(e.subject, 'ОсОО Мегуми 3');
    assert.strictEqual(e.lab, 'Бермет');
    assert.ok(e.duplicate_warning && /дубл/i.test(e.duplicate_warning));
  });

  await test('unknown doc type → not ok (no guess, no send)', () => {
    assert.strictEqual(le.buildLabEmail({ clientName: 'X', docType: null }).ok, false);
  });

  console.log('\n[countPriorByName — «Декларация» col D, injected]');
  await test('counts case/space-insensitive name matches in column D', async () => {
    // «Декларация» row: D = col 3.
    const DR = (client) => { const r = new Array(14).fill(''); r[le.DECL_CLIENT_COL] = client; return r; };
    const readDeclaration = async () => [DR('ИП Иванов'), DR('ип иванов'), DR('ОсОО Бета'), DR('  ИП  Иванов ')];
    const n = await le.countPriorByName('ИП Иванов', { readDeclaration });
    assert.strictEqual(n, 3);  // 3 variants of "ИП Иванов" (case/space), Бета excluded
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
