'use strict';

// Tests for Phone Mismatch Detection.
//   Layer 1 (pure): detectMismatches across all mismatch types + clean case.
//   Layer 2 (e2e): throwaway mongod — analyzeMessage over stored WhatsAppMessages,
//     including live-resolver drift detection; scanMessages batch.
//
// Run: node tests/phone-mismatch.test.js  (e2e skipped if mongod is absent)

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

const svc = require('../src/services/phoneMismatchService');
const types = (r) => r.mismatches.map(m => m.type);

async function pureTests() {
  console.log('\n[Pure detectMismatches]');

  await test('clean unique match → ok, no mismatches', () => {
    const r = svc.detectMismatches({ phone_resolution: 'phone', phone_key: '700112233', match_status: 'matched', candidates: [{ client_name: 'ОсОО Ромашка' }], body: 'привет' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mismatches.length, 0);
  });

  await test('LID without phone → LID_ONLY_NO_PHONE', () => {
    const r = svc.detectMismatches({ phone_resolution: 'lid_only', lid: '37087478829063@lid', phone_key: '', match_status: 'unmatched', candidates: [] });
    assert.ok(types(r).includes('LID_ONLY_NO_PHONE'));
  });

  await test('phone present, no declaration → UNMATCHED_PHONE', () => {
    const r = svc.detectMismatches({ phone_resolution: 'phone', phone_key: '700999888', match_status: 'unmatched', candidates: [] });
    assert.deepStrictEqual(types(r), ['UNMATCHED_PHONE']);
  });

  await test('every mismatch carries a recommend-only correction proposal (write:false)', () => {
    const r = svc.detectMismatches({ phone_resolution: 'lid_only', lid: 'x@lid', phone_key: '', match_status: 'unmatched', candidates: [] });
    assert.ok(r.mismatches.every(x => x.proposal && x.proposal.action && x.proposal.write === false));
  });

  await test('phone maps to many orders → AMBIGUOUS_MULTI_ORDER', () => {
    const r = svc.detectMismatches({ phone_resolution: 'phone', phone_key: '700112233', match_status: 'needs_review', candidates: [{ client_name: 'A' }, { client_name: 'B' }] });
    assert.ok(types(r).includes('AMBIGUOUS_MULTI_ORDER'));
  });

  await test('stored mapping differs from live resolution → LID_MAPPING_DRIFT', () => {
    const r = svc.detectMismatches({ phone_resolution: 'stored_lid', phone_key: '700000000', live_phone_key: '700112233', match_status: 'matched', candidates: [{ client_name: 'A' }] });
    assert.ok(types(r).includes('LID_MAPPING_DRIFT'));
  });

  await test('unique match but conversation names a different entity → NAME_MISMATCH', () => {
    const r = svc.detectMismatches({ phone_resolution: 'phone', phone_key: '700112233', match_status: 'matched', candidates: [{ client_name: 'ОсОО Ромашка' }], body: 'Это ИП Петров, по моей заявке' });
    assert.ok(types(r).includes('NAME_MISMATCH'));
  });

  await test('unique match, conversation names the SAME entity → no NAME_MISMATCH', () => {
    const r = svc.detectMismatches({ phone_resolution: 'phone', phone_key: '700112233', match_status: 'matched', candidates: [{ client_name: 'ОсОО Ромашка' }], body: 'Это ОсОО Ромашка по заявке' });
    assert.ok(!types(r).includes('NAME_MISMATCH'));
  });
}

function mongodAvailable() { return spawnSync('mongod', ['--version'], { encoding: 'utf8' }).status === 0; }

async function e2eTests() {
  console.log('\n[End-to-end]');
  if (!mongodAvailable()) { skip++; console.log('  SKIP  e2e — mongod not available'); return; }
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const port = 27038;
  const proc = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 40; i++) { try { await mongoose.connect(`mongodb://127.0.0.1:${port}/pm`, { serverSelectionTimeoutMS: 500 }); ok = true; break; } catch (_) { await new Promise(r => setTimeout(r, 250)); } }
  if (!ok) { skip++; console.log('  SKIP  e2e — mongod did not start'); proc.kill('SIGKILL'); return; }

  try {
    const { WhatsAppMessage } = require('../src/models/WhatsAppMessage');

    const unmatched = await WhatsAppMessage.create({ provider_message_id: 'pm-1', from_phone: '996700999888', phone_key: '700999888', phone_resolution: 'phone', match_status: 'unmatched', candidates: [] });
    const lidOnly   = await WhatsAppMessage.create({ provider_message_id: 'pm-2', lid: '37087478829063@lid', phone_resolution: 'lid_only', match_status: 'unmatched', candidates: [] });
    const clean     = await WhatsAppMessage.create({ provider_message_id: 'pm-3', from_phone: '996700112233', phone_key: '700112233', phone_resolution: 'phone', match_status: 'matched', candidates: [{ client_name: 'ОсОО Ромашка' }], body: 'ОсОО Ромашка' });

    await test('analyzeMessage flags an unmatched phone', async () => {
      const r = await svc.analyzeMessage(unmatched._id, {});
      assert.strictEqual(r.ok, false);
      assert.ok(r.mismatches.some(m => m.type === 'UNMATCHED_PHONE'));
    });

    await test('analyzeMessage flags a LID-only message', async () => {
      const r = await svc.analyzeMessage(lidOnly._id, {});
      assert.ok(r.mismatches.some(m => m.type === 'LID_ONLY_NO_PHONE'));
    });

    await test('analyzeMessage detects live-resolver drift on a stored LID', async () => {
      const drift = await WhatsAppMessage.create({ provider_message_id: 'pm-4', lid: '37087478829063@lid', from_phone: '996700000000', phone_key: '700000000', phone_resolution: 'stored_lid', match_status: 'matched', candidates: [{ client_name: 'A' }] });
      const lidResolver = async () => [{ lid: '37087478829063@lid', pn: '996700112233@c.us' }]; // different phone
      const r = await svc.analyzeMessage(drift._id, { lidResolver });
      assert.ok(r.mismatches.some(m => m.type === 'LID_MAPPING_DRIFT'));
    });

    await test('analyzeMessage returns ok for a clean unique match', async () => {
      const r = await svc.analyzeMessage(clean._id, {});
      assert.strictEqual(r.ok, true);
    });

    await test('scanMessages returns only flagged messages', async () => {
      const r = await svc.scanMessages({ limit: 100 }, {});
      assert.ok(r.scanned >= 4);
      // Without a live resolver, scan flags the unmatched phone + the LID-only message
      // (the stored-LID drift message needs a live resolver, so it reads clean here).
      assert.ok(r.flagged_count >= 2);
      assert.ok(!r.flagged.some(f => f.message_id === String(clean._id))); // clean excluded
    });

  } finally {
    await mongoose.disconnect().catch(() => {});
    proc.kill('SIGKILL');
    fs.rmSync(dbpath, { recursive: true, force: true });
  }
}

(async () => {
  await pureTests();
  await e2eTests();
  console.log(`\n──────────────────────────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`); }
  process.exit(fail > 0 ? 1 : 0);
})();
