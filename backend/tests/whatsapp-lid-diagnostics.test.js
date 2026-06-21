'use strict';

// Pure tests for the LID diagnostics report builder. No WhatsApp, no I/O.
// Run: node tests/whatsapp-lid-diagnostics.test.js

const assert = require('assert');
const diag = require('../src/services/whatsappLidDiagnosticsService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

test('parseWid splits lid / c.us / group', () => {
  assert.deepStrictEqual(diag.parseWid('37087478829063@lid'), { user: '37087478829063', server: 'lid', is_lid: true });
  assert.deepStrictEqual(diag.parseWid('996700112233@c.us'), { user: '996700112233', server: 'c.us', is_lid: false });
  assert.strictEqual(diag.parseWid('123@g.us').is_lid, false);
});

test('LID with no resolver result → no phone, LID reported, honest analysis', () => {
  const r = diag.buildReport({
    message: { id: 'm1', from: '37087478829063@lid', notifyName: 'Мой Билайн' },
    contact: { id: { _serialized: '37087478829063@lid', server: 'lid' }, number: '37087478829063', name: 'Мой Билайн', pushname: 'Мой Билайн' },
    chat: { id: { _serialized: '37087478829063@lid' }, isGroup: false },
    resolved: {},
  });
  assert.strictEqual(r.phone_available, false);
  assert.strictEqual(r.phone_number, null);
  assert.strictEqual(r.lid, '37087478829063@lid');
  assert.strictEqual(r.addressing.is_lid, true);
  assert.strictEqual(r.pushName, 'Мой Билайн');
  assert.ok(/NO phone resolvable/.test(r.analysis));
  // contact.number must NOT be promoted to phone_number for a LID contact.
  assert.notStrictEqual(r.phone_number, '37087478829063');
});

test('LID WITH resolver pn → phone resolved + viable for matching', () => {
  const r = diag.buildReport({
    message: { id: 'm2', from: '37087478829063@lid', notifyName: 'Мой Билайн' },
    contact: { id: { _serialized: '37087478829063@lid', server: 'lid' }, number: '37087478829063', name: 'Мой Билайн' },
    chat: { id: { _serialized: '37087478829063@lid' } },
    resolved: { lid: '37087478829063@lid', pn: '996700112233@c.us' },
  });
  assert.strictEqual(r.phone_available, true);
  assert.strictEqual(r.phone_number, '996700112233@c.us');
  assert.strictEqual(r.lid, '37087478829063@lid');
  assert.ok(/Phone resolved/.test(r.analysis));
});

test('plain c.us contact → phone taken from contact id, not a LID', () => {
  const r = diag.buildReport({
    message: { id: 'm3', from: '996700112233@c.us', notifyName: 'Иван' },
    contact: { id: { _serialized: '996700112233@c.us', server: 'c.us' }, number: '996700112233', name: 'Иван' },
    chat: { id: { _serialized: '996700112233@c.us' } },
    resolved: {},
  });
  assert.strictEqual(r.phone_available, true);
  assert.strictEqual(r.phone_number, '996700112233@c.us');
  assert.strictEqual(r.addressing.is_lid, false);
  assert.strictEqual(r.lid, null);
});

test('business name comes from verifiedName / businessProfile', () => {
  const r = diag.buildReport({
    message: { from: '37087478829063@lid' },
    contact: { id: { _serialized: '37087478829063@lid' }, verifiedName: 'Dokumenty.pro', isBusiness: true },
    chat: {}, resolved: {},
  });
  assert.strictEqual(r.business_name, 'Dokumenty.pro');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`); process.exit(1); }
process.exit(0);
