'use strict';

// Tests for whatsappLidService.applyStoredMappings — the self-healing sweep that rewrites
// lid-only inbound messages once a lid_mapping exists (so the panel never shows a raw LID).
// Stubbed models — no DB.
//
// Run: node tests/wa-lid-selfheal.test.js

const assert = require('assert');
const lid = require('../src/services/whatsappLidService');

let pass = 0, fail = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function stub({ stuck = [], mappings = [] } = {}) {
  const writes = [];
  return {
    writes,
    deps: {
      WhatsAppMessage: {
        find: () => ({ select: () => ({ limit: () => ({ lean: async () => stuck }) }) }),
        bulkWrite: async (ops) => { writes.push(...ops); return { modifiedCount: ops.length }; },
      },
      LidMapping: { find: () => ({ lean: async () => mappings }) },
    },
  };
}

test('rewrites a lid-only message when a mapping exists', async () => {
  const s = stub({
    stuck: [{ _id: 'm1', lid: '175453709054161@lid' }],
    mappings: [{ lid: '175453709054161@lid', phone: '996555388184', phone_key: '555388184' }],
  });
  const r = await lid.applyStoredMappings(s.deps);
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.fixed, 1);
  const set = s.writes[0].updateOne.update.$set;
  assert.strictEqual(set.phone_key, '555388184');
  assert.strictEqual(set.from_phone, '996555388184');
  assert.strictEqual(set.phone_resolution, 'stored_lid');
});

test('leaves a lid-only message alone when NO mapping exists', async () => {
  const s = stub({ stuck: [{ _id: 'm2', lid: '999@lid' }], mappings: [] });
  const r = await lid.applyStoredMappings(s.deps);
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.fixed, 0);
  assert.strictEqual(s.writes.length, 0);
});

test('derives phone_key from phone when mapping lacks phone_key', async () => {
  const s = stub({
    stuck: [{ _id: 'm3', lid: '5@lid' }],
    mappings: [{ lid: '5@lid', phone: '996700111222' }],   // no phone_key
  });
  const r = await lid.applyStoredMappings(s.deps);
  assert.strictEqual(r.fixed, 1);
  assert.ok(s.writes[0].updateOne.update.$set.phone_key); // matchKey(phone)
});

test('nothing stuck → no-op', async () => {
  const s = stub({ stuck: [], mappings: [] });
  const r = await lid.applyStoredMappings(s.deps);
  assert.deepStrictEqual(r, { scanned: 0, fixed: 0 });
});

(async () => {
  console.log('\n[wa-lid-selfheal]');
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  console.log(`\n${fail ? '✗' : '✓'} wa-lid-selfheal: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
