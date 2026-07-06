'use strict';

// Tests for emailLinkService — the durable email↔WhatsApp-number link (bridged via «Декларация»).
//   • decideLinks (PURE): auto-confirm only high+unique; propose ambiguous; skip noise/low.
//   • scan: end-to-end with stubbed deep-match + order lookup + in-memory EmailLink.
//   • operator authority: override-lock, confirm/reject, and relink (correct a wrong link).
//
// Run: node tests/email-link.test.js

const assert = require('assert');
const svc = require('../src/services/emailLinkService');
const { matchKey } = require('../src/utils/phoneUtils');

let pass = 0, fail = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ── in-memory EmailLink collection stub ──
function makeStore(seed = []) {
  const docs = seed.map(d => ({ ...d }));
  const match = (q) => (d) => Object.entries(q).every(([k, v]) => String(d[k]) === String(v));
  const EmailLink = {
    _docs: docs,
    findOne: (q) => ({ lean: async () => docs.find(match(q)) || null }),
    find: (q) => {
      const res = docs.filter(match(q));
      const chain = { sort: () => chain, limit: () => chain, lean: async () => res.map(d => ({ ...d })) };
      return chain;
    },
    updateOne: async (q, update, opts = {}) => {
      const set = update.$set || {};
      const d = docs.find(match(q));
      if (d) { Object.assign(d, set); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
      if (opts.upsert) { docs.push({ ...q, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
  };
  return { models: { EmailLink }, EmailLink };
}

const KA = matchKey('+996700111222');   // phone A
const KB = matchKey('+996700333444');   // phone B

// ── decideLinks (pure) ──
test('decide: high + unique thread → confirmed (auto)', () => {
  const d = svc.decideLinks([
    { phone_key: KA, client_name: 'ИП A', sheet_rows: ['10'], emails: [{ thread_id: 't1', confidence: 'high', signals: ['лаборатория', 'имя в теме'] }] },
  ]);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].status, 'confirmed');
  assert.strictEqual(d[0].source, 'auto');
  assert.strictEqual(d[0].phone_key, KA);
});
test('decide: same thread high for TWO phones → both proposed, ambiguous_phones set', () => {
  const d = svc.decideLinks([
    { phone_key: KA, client_name: 'ИП A', emails: [{ thread_id: 't1', confidence: 'high' }] },
    { phone_key: KB, client_name: 'ИП B', emails: [{ thread_id: 't1', confidence: 'high' }] },
  ]);
  assert.strictEqual(d.length, 2);
  assert.ok(d.every(x => x.status === 'proposed'));
  const a = d.find(x => x.phone_key === KA);
  assert.deepStrictEqual(a.ambiguous_phones, [KB]);
});
test('decide: medium with no strong owner → proposed', () => {
  const d = svc.decideLinks([{ phone_key: KA, emails: [{ thread_id: 't2', confidence: 'medium' }] }]);
  assert.strictEqual(d[0].status, 'proposed');
});
test('decide: medium on a thread already high-unique to another phone → skipped (noise)', () => {
  const d = svc.decideLinks([
    { phone_key: KA, emails: [{ thread_id: 't3', confidence: 'high' }] },    // A owns t3
    { phone_key: KB, emails: [{ thread_id: 't3', confidence: 'medium' }] },  // B weak on t3 → drop
  ]);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].phone_key, KA);
});
test('decide: low confidence → skipped', () => {
  const d = svc.decideLinks([{ phone_key: KA, emails: [{ thread_id: 't4', confidence: 'low' }] }]);
  assert.strictEqual(d.length, 0);
});

// ── scan (integration with stubs) ──
function scanDeps(store) {
  return {
    ...store,
    phones: ['+996700111222'],
    clientEmails: async () => ({ searched_names: ['ИП A'], emails: [
      { thread_id: 't1', subject: 'ИП A декларация', from: 'svnsert7@gmail.com', to: 'me', at: '2026-07-01', confidence: 'high', signals: ['лаборатория', 'имя в теме'] },
      { thread_id: 't2', subject: 'вопрос', from: 'x@y.z', to: 'me', at: '2026-06-01', confidence: 'medium', signals: ['имя в теме'] },
    ] }),
    lookupOrdersByPhone: async () => ({ results: [{ row: '10', order_id: 'O10', client: 'ИП A' }], last_declaration_row: { row: '10', order_id: 'O10', client: 'ИП A' } }),
  };
}
test('scan: writes 1 confirmed (high+unique) + 1 proposed (medium)', async () => {
  const store = makeStore();
  const r = await svc.scan({ deps: scanDeps(store) });
  assert.strictEqual(r.confirmed, 1);
  assert.strictEqual(r.proposed, 1);
  const confirmed = store.EmailLink._docs.find(x => x.status === 'confirmed');
  assert.strictEqual(confirmed.gmail_thread_id, 't1');
  assert.strictEqual(confirmed.phone_key, KA);
  assert.strictEqual(confirmed.order_id, 'O10');
  assert.deepStrictEqual(confirmed.sheet_rows, ['10']);
});

// ── operator authority ──
test('upsert: operator-locked link is never overwritten by a re-scan', async () => {
  const store = makeStore([{ gmail_thread_id: 't1', phone_key: KA, status: 'rejected', source: 'operator' }]);
  const r = await svc.upsertLink({ gmail_thread_id: 't1', phone_key: KA, status: 'confirmed', source: 'auto' }, store);
  assert.strictEqual(r.outcome, 'operator_locked');
  assert.strictEqual(store.EmailLink._docs[0].status, 'rejected');   // unchanged
});
test('confirm / reject set operator source', async () => {
  const store = makeStore([{ gmail_thread_id: 't1', phone_key: KA, status: 'proposed', source: 'auto' }]);
  await svc.reject('t1', KA, 'op1', store);
  const d = store.EmailLink._docs[0];
  assert.strictEqual(d.status, 'rejected');
  assert.strictEqual(d.source, 'operator');
  assert.strictEqual(d.set_by, 'op1');
});
test('relink: reassign a wrong letter A→B (reject A, confirm B with snapshot)', async () => {
  const store = makeStore([{ gmail_thread_id: 't1', phone_key: KA, status: 'confirmed', source: 'auto', subject: 'ИП A', from_addr: 'lab@x', to_addr: 'me' }]);
  const deps = { ...store, lookupOrdersByPhone: async () => ({ results: [{ row: '55', order_id: 'O55', client: 'ИП B' }], last_declaration_row: { row: '55', order_id: 'O55', client: 'ИП B' } }) };
  const r = await svc.relink({ gmail_thread_id: 't1', from_phone: '+996700111222', to_phone: '+996700333444', operator: 'op1' }, deps);
  assert.strictEqual(r.ok, true);
  const wrong = store.EmailLink._docs.find(x => x.phone_key === KA);
  const right = store.EmailLink._docs.find(x => x.phone_key === KB);
  assert.strictEqual(wrong.status, 'rejected');
  assert.strictEqual(wrong.source, 'operator');
  assert.strictEqual(right.status, 'confirmed');
  assert.strictEqual(right.source, 'operator');
  assert.strictEqual(right.client_name, 'ИП B');
  assert.strictEqual(right.subject, 'ИП A');            // letter snapshot carried over
  assert.deepStrictEqual(right.sheet_rows, ['55']);
});
test('relink survives a failing Declaration lookup (link still reassigned)', async () => {
  const store = makeStore([{ gmail_thread_id: 't9', phone_key: KA, status: 'confirmed', source: 'auto', subject: 'S' }]);
  const deps = { ...store, lookupOrdersByPhone: async () => { throw new Error('sheet down'); } };
  const r = await svc.relink({ gmail_thread_id: 't9', from_phone: '+996700111222', to_phone: '+996700333444', operator: 'op1' }, deps);
  assert.strictEqual(r.ok, true);
  const right = store.EmailLink._docs.find(x => x.phone_key === KB);
  assert.strictEqual(right.status, 'confirmed');
  assert.strictEqual(right.subject, 'S');
});

(async () => {
  console.log('\n[email-link]');
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  console.log(`\n${fail ? '✗' : '✓'} email-link: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
