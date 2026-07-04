'use strict';

// Tests: whatsappMatchService now matches against the LIVE «Декларация» sheet (injected),
// not the empty Mongo replica. Run: node tests/whatsapp-live-match.test.js

const assert = require('assert');
const svc = require('../src/services/whatsappMatchService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

// Raw «Декларация» rows: D(3)=client, J(9)=phone, N(13)=status.
const row = (client, phone, status) => { const r = []; r[3] = client; r[9] = phone; r[13] = status; return r; };
const READ = async () => [
  row('ООО Ромашка', '+996700111222', 'Ждем макет'),
  row('ИП Петров', '0700111222', 'На согласовании'),   // same phone as row above → 2 orders
  row('ООО Один', '996555000111', 'Запустить'),
];
const fakeMsg = (over) => {
  const doc = Object.assign({ save: async function () { doc._saved = true; } }, over);
  return doc;
};

(async () => {
  await test('liveDeclarations maps sheet rows → candidates with sheet_row_id', async () => {
    const d = await svc.liveDeclarations({ readDeclaration: READ });
    assert.strictEqual(d.length, 3);
    assert.strictEqual(d[0].sheet_row_id, '2');
    assert.strictEqual(d[0].client_name, 'ООО Ромашка');
    assert.strictEqual(d[2].status, 'Запустить');
    assert.strictEqual(d[0].order_id, null);           // no Mongo order — the row IS the order
  });

  await test('unique phone → matched + matched_sheet_row set (was "unmatched" against empty Mongo)', async () => {
    const doc = fakeMsg({ _id: 'a', from_phone: '996555000111', phone_key: '555000111' });
    const FakeWA = { findById: async () => doc };
    const r = await svc.matchMessage('a', { WhatsAppMessage: FakeWA, readDeclaration: READ });
    assert.strictEqual(r.match_status, 'matched');
    assert.strictEqual(doc.match_status, 'matched');
    assert.strictEqual(doc.matched_sheet_row, '4');
    assert.strictEqual(doc.candidates[0].client_name, 'ООО Один');
    assert.ok(doc._saved);
  });

  await test('phone with 2 orders → needs_review, no sheet row auto-picked', async () => {
    const doc = fakeMsg({ _id: 'b', from_phone: '700111222', phone_key: '700111222' });
    const FakeWA = { findById: async () => doc };
    const r = await svc.matchMessage('b', { WhatsAppMessage: FakeWA, readDeclaration: READ });
    assert.strictEqual(r.match_status, 'needs_review');
    assert.strictEqual(doc.candidates.length, 2);
    assert.strictEqual(doc.matched_sheet_row, null);
  });

  await test('unknown phone → unmatched', async () => {
    const doc = fakeMsg({ _id: 'c', from_phone: '996999888777', phone_key: '999888777' });
    const FakeWA = { findById: async () => doc };
    const r = await svc.matchMessage('c', { WhatsAppMessage: FakeWA, readDeclaration: READ });
    assert.strictEqual(r.match_status, 'unmatched');
    assert.strictEqual(doc.matched_sheet_row, null);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
