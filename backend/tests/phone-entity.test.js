'use strict';

// Tests for the Phone ↔ Legal Entity Registry (services/phoneEntityService).
// Pure reasoning + the gated lifecycle (propose/confirm/reject/resolve, conflict +
// one-confirmed-per-number) via an in-memory fake model (deps injection). No DB.
//
// Run: node tests/phone-entity.test.js

const assert = require('assert');
const svc = require('../src/services/phoneEntityService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

// ─── In-memory fake of the PhoneEntityLink model (only what the service uses) ───
function makeFake() {
  const rows = [];
  let seq = 0;
  const matches = (r, q) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v));
  const wrap = (r) => r && Object.assign(r, {
    toObject() { return r; },
    async save() { return r; },
  });
  return {
    rows,
    async create(doc) { const r = wrap({ _id: `id${++seq}`, ...doc }); rows.push(r); return r; },
    findOne(q) { return { lean: async () => rows.find(r => matches(r, q)) || null }; },
    findById(id) { return Promise.resolve(rows.find(r => String(r._id) === String(id)) || null); },
    async updateOne(q, upd) { const r = rows.find(x => matches(x, q)); if (r && upd.$set) Object.assign(r, upd.$set); return { n: r ? 1 : 0 }; },
    find(q = {}) {
      let out = rows.filter(r => matches(r, q));
      const builder = { sort() { return builder; }, limit() { return builder; }, lean: async () => out };
      return builder;
    },
  };
}

(async () => {
  console.log('\n[pure — sameEntity / assessProposal]');

  await test('sameEntity ignores legal form (ИП Иванов ≈ Иванов)', () => {
    assert.strictEqual(svc.sameEntity('ИП Иванов Максим', 'Иванов Максим'), true);
  });
  await test('sameEntity distinguishes different entities', () => {
    assert.strictEqual(svc.sameEntity('ОсОО Мегуми', 'ОсОО Klara'), false);
  });
  await test('sameEntity false on empty names', () => {
    assert.strictEqual(svc.sameEntity('', 'ОсОО Мегуми'), false);
  });
  await test('assessProposal — no confirmed → clean', () => {
    assert.strictEqual(svc.assessProposal(null, 'ОсОО Мегуми').conflict, false);
  });
  await test('assessProposal — same entity → matches_confirmed (no conflict)', () => {
    const a = svc.assessProposal({ legal_entity: 'ИП Иванов' }, 'Иванов');
    assert.strictEqual(a.type, 'matches_confirmed');
    assert.strictEqual(a.conflict, false);
  });
  await test('assessProposal — different entity → conflict', () => {
    const a = svc.assessProposal({ legal_entity: 'ОсОО Мегуми' }, 'ОсОО Klara');
    assert.strictEqual(a.conflict, true);
  });

  console.log('\n[gated lifecycle — propose / confirm / reject / resolve]');

  await test('propose creates a gated proposal (status proposed, not confirmed)', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const { link, created } = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Мегуми', source: 'application' }, deps);
    assert.strictEqual(created, true);
    assert.strictEqual(link.status, 'proposed');
  });

  await test('confirm enforces one confirmed entity, then resolve() returns it', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const { link } = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Мегуми' }, deps);
    await svc.confirm(link._id, { confirmedBy: 'op' }, deps);
    const resolved = await svc.resolve('996700111222', deps);
    assert.ok(resolved);
    assert.strictEqual(resolved.legal_entity, 'ОсОО Мегуми');
    assert.strictEqual(resolved.status, 'confirmed');
  });

  await test('a different entity proposed for a confirmed number is flagged conflict', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const p1 = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Мегуми' }, deps);
    await svc.confirm(p1.link._id, {}, deps);
    const p2 = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Klara' }, deps);
    assert.strictEqual(p2.assessment.conflict, true);
    assert.strictEqual(p2.link.conflict, true);
  });

  await test('confirming a conflicting entity without supersede throws', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const p1 = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Мегуми' }, deps);
    await svc.confirm(p1.link._id, {}, deps);
    const p2 = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Klara' }, deps);
    await assert.rejects(() => svc.confirm(p2.link._id, {}, deps), /supersede/);
  });

  await test('supersede replaces the old binding (old → superseded, new → confirmed)', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const p1 = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Мегуми' }, deps);
    await svc.confirm(p1.link._id, {}, deps);
    const p2 = await svc.propose({ phone: '+996700111222', legal_entity: 'ОсОО Klara' }, deps);
    await svc.confirm(p2.link._id, { supersede: true }, deps);
    const resolved = await svc.resolve('996700111222', deps);
    assert.strictEqual(resolved.legal_entity, 'ОсОО Klara');
    const old = deps.PhoneEntityLink.rows.find(r => r._id === p1.link._id);
    assert.strictEqual(old.status, 'superseded');
  });

  await test('reject marks a proposal rejected; resolve stays null', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const { link } = await svc.propose({ phone: '+996555000111', legal_entity: 'ИП Карина' }, deps);
    await svc.reject(link._id, { rejectedBy: 'op' }, deps);
    assert.strictEqual(await svc.resolve('996555000111', deps), null);
  });

  await test('findByEntity returns confirmed numbers for an entity', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    const p = await svc.propose({ phone: '+996700111222', legal_entity: 'ИП Иванов Максим' }, deps);
    await svc.confirm(p.link._id, {}, deps);
    const hits = await svc.findByEntity('Иванов', deps);
    assert.strictEqual(hits.length, 1);
  });

  await test('propose rejects empty phone / entity (gated validation)', async () => {
    const deps = { PhoneEntityLink: makeFake() };
    await assert.rejects(() => svc.propose({ phone: '', legal_entity: 'X' }, deps));
    await assert.rejects(() => svc.propose({ phone: '+996700111222', legal_entity: '' }, deps));
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
