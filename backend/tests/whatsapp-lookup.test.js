'use strict';

// Pure unit tests for Sprint 2 — Declaration lookup by WhatsApp phone.
// Verifies +996/short equivalence, the returned projection
// (Client / Document / Status / Last row), one-phone-many-orders, and unmatched.
// No DB / no network.
//
// Run: node tests/whatsapp-lookup.test.js  (or: npm run test:whatsapp-lookup)

const assert = require('assert');
const { lookupByPhone, rankByPhone } = require('../src/services/whatsappMatchService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DECLS = [
  { _id: 'd1', order_id: 'o1', sheet_row_id: '150', client_name: 'ИП Парманова Кенжегул', document_type: 'декларация', phone: '0777240858', status: 'завершен' },
  { _id: 'd2', order_id: 'o2', sheet_row_id: '570', client_name: 'ИП Парманова Кенжегул', document_type: 'декларация', phone: '+996777240858', status: 'ждем макет' },
  { _id: 'd3', order_id: 'o3', sheet_row_id: '500', client_name: 'ОсОО BACCI',           document_type: 'сертификат', phone: '700111222',     status: 'на согласовании' },
];

test('+996 form matches the shortened stored form and returns full projection', () => {
  const r = lookupByPhone('+996700111222', DECLS);
  assert.strictEqual(r.match_status, 'matched');
  assert.strictEqual(r.match_count, 1);
  assert.deepStrictEqual(r.results[0], { row: '500', order_id: 'o3', client: 'ОсОО BACCI', document: 'сертификат', status: 'на согласовании' });
});

test('shortened inbound number matches +996 stored form (symmetric)', () => {
  const r = lookupByPhone('777240858', DECLS); // matches d1 + d2 (same client, 2 orders)
  assert.strictEqual(r.match_status, 'needs_review');
  assert.strictEqual(r.match_count, 2);
  assert.ok(r.results.every(x => x.client === 'ИП Парманова Кенжегул'));
});

test('returns the Last Declaration row (highest row number) among many orders', () => {
  const r = lookupByPhone('996777240858', DECLS);
  assert.strictEqual(r.last_declaration_row.row, '570');         // 570 > 150
  assert.strictEqual(r.last_declaration_row.status, 'ждем макет');
  assert.strictEqual(r.last_declaration_row.document, 'декларация');
});

test('unmatched phone returns empty results and null last row', () => {
  const r = lookupByPhone('700999999', DECLS);
  assert.strictEqual(r.match_status, 'unmatched');
  assert.strictEqual(r.match_count, 0);
  assert.strictEqual(r.last_declaration_row, null);
});

test('too-short number never broad-matches', () => {
  const r = lookupByPhone('111', DECLS);
  assert.strictEqual(r.match_status, 'unmatched');
});

// ── needs_review disambiguation hints (advisory; never auto-assign) ──
test('needs_review: active+newest sorted first and flagged likely_current', () => {
  const decls = [
    { sheet_row_id: '100', client_name: 'ИП X', phone: '700111222', status: 'завершен' },
    { sheet_row_id: '300', client_name: 'ИП X', phone: '700111222', status: 'ждем макет' },     // active, newest
    { sheet_row_id: '200', client_name: 'ИП X', phone: '700111222', status: 'на согласовании' }, // active
  ];
  const r = rankByPhone('700111222', decls);
  assert.strictEqual(r.match_status, 'needs_review');
  assert.strictEqual(r.candidates[0].sheet_row_id, '300');       // active + newest first
  assert.strictEqual(r.candidates[0].likely_current, true);
  assert.strictEqual(r.candidates.filter(c => c.likely_current).length, 1); // exactly one hint
  const done = r.candidates.find(c => c.sheet_row_id === '100');
  assert.strictEqual(done.is_active, false);
  assert.strictEqual(done.likely_current, false);
});
test('needs_review: all done → likely_current falls back to the newest row', () => {
  const decls = [
    { sheet_row_id: '100', phone: '700111222', status: 'завершен' },
    { sheet_row_id: '400', phone: '700111222', status: 'завершен' },
  ];
  const lc = rankByPhone('700111222', decls).candidates.find(c => c.likely_current);
  assert.strictEqual(lc.sheet_row_id, '400');                    // newest, since none active
});
test('single match is untouched (no needs_review hints)', () => {
  const r = rankByPhone('+996700111222', DECLS);
  assert.strictEqual(r.match_status, 'matched');
  assert.strictEqual(r.candidates[0].likely_current, undefined); // hints only on ambiguity
});

console.log(`\nWhatsApp Declaration lookup (Sprint 2): ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(` - ${f.name}: ${f.err.message}`)); process.exit(1); }
