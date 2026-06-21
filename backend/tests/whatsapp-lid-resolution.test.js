'use strict';

// Tests for WhatsApp LID → phone resolution at ingest.
//   Layer 1 (pure): isLid/lidKey/phoneFromWid, deriveIdentity, mapIncomingMessage shape.
//   Layer 2 (e2e):  throwaway mongod — LID resolves to phone, resolution unavailable,
//                   stored mapping reused, mixed phone/LID conversation, live>stored
//                   priority. Verifies messages are never dropped and mappings persist.
//
// Run: node tests/whatsapp-lid-resolution.test.js  (e2e skipped if mongod is absent)

const assert   = require('assert');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const { spawn, spawnSync } = require('child_process');
const mongoose = require('mongoose');

let pass = 0, fail = 0, skip = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const lidService    = require('../src/services/whatsappLidService');
const ingestService = require('../src/services/whatsappIngestService');

const LID  = '37087478829063@lid';
const PN   = '996700112233@c.us';

// ─── Layer 1: pure ────────────────────────────────────────────────────────────
async function pureTests() {
  console.log('\n[Pure]');

  await test('isLid / lidKey / phoneFromWid', () => {
    assert.strictEqual(lidService.isLid(LID), true);
    assert.strictEqual(lidService.isLid(PN), false);
    assert.strictEqual(lidService.lidKey(LID), '37087478829063');
    assert.strictEqual(lidService.lidKey(PN), '');
    assert.strictEqual(lidService.phoneFromWid(PN), '996700112233');
  });

  await test('deriveIdentity: LID → lid-only (digits NOT treated as phone)', () => {
    const id = lidService.deriveIdentity({ from: LID });
    assert.strictEqual(id.resolution, 'lid_only');
    assert.strictEqual(id.from_phone, '');
    assert.strictEqual(id.phone_key, '');
    assert.strictEqual(id.lid, LID);
    assert.strictEqual(id.lid_key, '37087478829063');
  });

  await test('deriveIdentity: @c.us → phone', () => {
    const id = lidService.deriveIdentity({ from: PN });
    assert.strictEqual(id.resolution, 'phone');
    assert.strictEqual(id.from_phone, '996700112233');
    assert.strictEqual(id.phone_key, '700112233');
    assert.strictEqual(id.lid, null);
  });

  await test('mapIncomingMessage carries LID fields from a resolved identity', () => {
    const identity = { from_phone: '996700112233', phone_key: '700112233', lid: LID, lid_key: '37087478829063', resolution: 'resolved_lid', resolved_at: new Date() };
    const m = ingestService.mapIncomingMessage({ id: 'x', from: LID, body: 'hi', timestamp: 1 }, identity);
    assert.strictEqual(m.from_phone, '996700112233');
    assert.strictEqual(m.phone_key, '700112233');
    assert.strictEqual(m.lid, LID);
    assert.strictEqual(m.phone_resolution, 'resolved_lid');
    assert.ok(m.phone_resolved_at instanceof Date);
  });

  await test('mapIncomingMessage with no identity does not mistake a LID for a phone', () => {
    const m = ingestService.mapIncomingMessage({ id: 'y', from: LID, body: 'hi' });
    assert.strictEqual(m.from_phone, '');
    assert.strictEqual(m.phone_key, '');
    assert.strictEqual(m.lid, LID);
    assert.strictEqual(m.phone_resolution, 'lid_only');
  });
}

// ─── Layer 2: e2e ───────────────────────────────────────────────────────────────
function mongodAvailable() { return spawnSync('mongod', ['--version'], { encoding: 'utf8' }).status === 0; }

async function startMongo() {
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-mongo-'));
  const port = 27035;
  const proc = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/lid_test`;
  for (let i = 0; i < 40; i++) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); return { proc, dbpath }; }
    catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('mongod did not become ready');
}
async function stopMongo(h) {
  try { await mongoose.disconnect(); } catch (_) {}
  if (h?.proc) { try { h.proc.kill('SIGKILL'); } catch (_) {} }
  if (h?.dbpath) { try { fs.rmSync(h.dbpath, { recursive: true, force: true }); } catch (_) {} }
}

async function e2eTests() {
  console.log('\n[End-to-end]');
  if (!mongodAvailable()) { skip++; console.log('  SKIP  e2e — mongod binary not available'); return; }
  let handle;
  try { handle = await startMongo(); }
  catch (err) { skip++; console.log(`  SKIP  e2e — ${err.message}`); return; }

  try {
    const { WhatsAppMessage } = require('../src/models/WhatsAppMessage');
    const { LidMapping }      = require('../src/models/LidMapping');
    const { Declaration }     = require('../src/models/Declaration');

    // Seed a Declaration whose phone matches the resolved phone (proves matching works).
    await Declaration.create({ source: 'google_sheets', sheet_row_id: '5', client_name: 'ОсОО Ромашка', phone: '0700112233', status: 'Ждем макет' });

    await test('LID resolves to phone (live) → persisted mapping + matched', async () => {
      const resolver = async (ids) => ids.map(lid => ({ lid, pn: PN }));
      const res = await ingestService.ingestIncoming(
        { id: 'lid-1', from: LID, body: 'Здравствуйте', timestamp: 1748600000 },
        { lidResolver: resolver }
      );
      assert.strictEqual(res.message.phone_resolution, 'resolved_lid');
      assert.strictEqual(res.message.from_phone, '996700112233');
      assert.strictEqual(res.message.phone_key, '700112233');
      assert.strictEqual(res.message.lid, LID);
      assert.ok(res.message.phone_resolved_at);
      // persisted mapping
      const map = await LidMapping.findOne({ lid: LID }).lean();
      assert.ok(map && map.phone === '996700112233' && map.phone_key === '700112233');
      assert.ok(map.resolved_at);
      // matched to the seeded declaration via the resolved phone
      assert.strictEqual(res.match.match_status, 'matched');
    });

    await test('LID resolution unavailable → lid-only, message stored, never dropped', async () => {
      await LidMapping.deleteMany({});
      const resolver = async () => [];               // resolver returns nothing
      const res = await ingestService.ingestIncoming(
        { id: 'lid-2', from: '55500011122@lid', body: 'no phone available', timestamp: 1748600001 },
        { lidResolver: resolver }
      );
      assert.strictEqual(res.message.phone_resolution, 'lid_only');
      assert.strictEqual(res.message.from_phone, '');
      assert.strictEqual(res.message.phone_key, '');
      assert.strictEqual(res.message.lid, '55500011122@lid');
      // stored (not dropped) and matchable later
      assert.ok(await WhatsAppMessage.findById(res.message._id));
      assert.strictEqual(res.match.match_status, 'unmatched');
    });

    await test('stored LID mapping reused when live resolution is absent', async () => {
      await LidMapping.create({ lid: LID, lid_key: '37087478829063', phone: '996700112233', phone_key: '700112233', resolved_at: new Date() });
      // No lidResolver supplied → must fall back to the stored mapping.
      const res = await ingestService.ingestIncoming({ id: 'lid-3', from: LID, body: 'снова я', timestamp: 1748600002 }, {});
      assert.strictEqual(res.message.phone_resolution, 'stored_lid');
      assert.strictEqual(res.message.from_phone, '996700112233');
      assert.strictEqual(res.message.phone_key, '700112233');
      assert.strictEqual(res.match.match_status, 'matched');
    });

    await test('live resolution takes priority over a stale stored mapping', async () => {
      await LidMapping.deleteMany({});
      await LidMapping.create({ lid: LID, lid_key: '37087478829063', phone: '996700000000', phone_key: '700000000', resolved_at: new Date(0) });
      const resolver = async (ids) => ids.map(lid => ({ lid, pn: PN })); // fresh, different phone
      const res = await ingestService.ingestIncoming({ id: 'lid-4', from: LID, body: 'fresh', timestamp: 1748600003 }, { lidResolver: resolver });
      assert.strictEqual(res.message.phone_resolution, 'resolved_lid');
      assert.strictEqual(res.message.phone_key, '700112233'); // from live resolve, not stored
      const map = await LidMapping.findOne({ lid: LID }).lean();
      assert.strictEqual(map.phone_key, '700112233'); // mapping refreshed
    });

    await test('mixed phone/LID conversation: both stored with correct identity', async () => {
      const resolver = async (ids) => ids.map(lid => ({ lid, pn: PN }));
      const plain = await ingestService.ingestIncoming({ id: 'mix-1', from: '996700112233@c.us', body: 'phone msg', timestamp: 1748600100 }, { lidResolver: resolver });
      const viaLid = await ingestService.ingestIncoming({ id: 'mix-2', from: LID, body: 'lid msg', timestamp: 1748600101 }, { lidResolver: resolver });
      assert.strictEqual(plain.message.phone_resolution, 'phone');
      assert.strictEqual(plain.message.lid, undefined);
      assert.strictEqual(viaLid.message.phone_resolution, 'resolved_lid');
      assert.strictEqual(viaLid.message.lid, LID);
      // Same underlying contact → same phone_key from both addressing modes.
      assert.strictEqual(plain.message.phone_key, viaLid.message.phone_key);
    });

  } finally {
    await stopMongo(handle);
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
