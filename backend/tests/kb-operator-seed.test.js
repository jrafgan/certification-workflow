'use strict';

// e2e test for the operator Master KB V2 seed: throwaway mongod → seed → assert that
// operator entries are APPROVED (source:'operator'), the conflicting status entry is
// HELD (pending), getApprovedKnowledge returns approved-only, and re-seed is idempotent.
//
// Run: node tests/kb-operator-seed.test.js  (skips if mongod is absent)

const assert   = require('assert');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const { spawn, spawnSync } = require('child_process');
const mongoose = require('mongoose');

let pass = 0, fail = 0, skip = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function mongodAvailable() { return spawnSync('mongod', ['--version'], { encoding: 'utf8' }).status === 0; }

(async () => {
  if (!mongodAvailable()) { console.log('SKIP — mongod not available'); process.exit(0); }
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbseed-'));
  const port = 27037;
  const proc = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 40; i++) { try { await mongoose.connect(`mongodb://127.0.0.1:${port}/kbseed`, { serverSelectionTimeoutMS: 500 }); ok = true; break; } catch (_) { await new Promise(r => setTimeout(r, 250)); } }
  if (!ok) { console.log('SKIP — mongod did not start'); proc.kill('SIGKILL'); process.exit(0); }

  try {
    const kb        = require('../src/knowledge/operatorMasterKbV2');
    const kbService = require('../src/services/knowledgeBaseService');
    const { KbEntry } = require('../src/models/KbEntry');

    let res;
    await test('seedOperatorKnowledge approves all entries (no held after mapping decision)', async () => {
      res = await kbService.seedOperatorKnowledge(kb);
      assert.strictEqual(res.total, kb.entries.length);
      assert.strictEqual(res.approved, kb.entries.length);
      assert.strictEqual(res.held, 0);
    });

    await test('operator entries are source:operator + approved + needs_review:false', async () => {
      const approved = await KbEntry.find({ source: 'operator', status: 'approved' }).lean();
      assert.ok(approved.length === res.approved);
      assert.ok(approved.every(e => e.needs_review === false));
      assert.ok(approved.some(e => /Дастан/.test(e.text)));
      assert.ok(approved.some(e => /35 000 сом/.test(e.text)));
    });

    await test('the status chain is an APPROVED client-facing narrative with a mapping', async () => {
      const narr = await KbEntry.findOne({ source: 'operator', 'value.kind': 'status_narrative_mapping' }).lean();
      assert.ok(narr, 'narrative entry exists');
      assert.strictEqual(narr.status, 'approved');
      assert.strictEqual(narr.value.mapping['Документ готов'], 'Оригинал получен');
      assert.strictEqual(narr.value.mapping['Запущен'], 'Ждем макет');
      assert.strictEqual(narr.value.operational_source, 'declaration_sheet_7_statuses');
    });

    await test('getApprovedKnowledge returns approved-only', async () => {
      const all = await kbService.getApprovedKnowledge();
      assert.ok(all.length === res.approved);
      assert.ok(all.every(e => e.status === 'approved'));
    });

    await test('getApprovedKnowledge filters by category', async () => {
      const pay = await kbService.getApprovedKnowledge('Payments');
      assert.ok(pay.length >= 4);
      assert.ok(pay.every(e => e.category === 'Payments'));
    });

    await test('re-seed is idempotent (no duplicate entries)', async () => {
      const before = await KbEntry.countDocuments({ source: 'operator' });
      await kbService.seedOperatorKnowledge(kb);
      const after = await KbEntry.countDocuments({ source: 'operator' });
      assert.strictEqual(before, after);
    });

  } finally {
    await mongoose.disconnect().catch(() => {});
    proc.kill('SIGKILL');
    fs.rmSync(dbpath, { recursive: true, force: true });
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) { for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`); process.exit(1); }
  process.exit(0);
})();
