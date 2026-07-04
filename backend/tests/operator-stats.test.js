'use strict';

// Tests for services/operatorStatsService — the per-operator work counter.
// Pure aggregate() + recordOutboundReply() with injected fakes. No MongoDB / no network.
// Run: node tests/operator-stats.test.js

const assert = require('assert');
const stats = require('../src/services/operatorStatsService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

(async () => {
  console.log('\n[aggregate — pure per-operator counts]');
  await test('groups by operator, counts intents + categories, totals', () => {
    const msgs = [
      { handled_by: 'op1', question_intent: 'price_question', question_category: 'certificate' },
      { handled_by: 'op1', question_intent: 'price_question', question_category: 'declaration' },
      { handled_by: 'op1', question_intent: 'docs_question',  question_category: 'declaration' },
      { handled_by: 'op2', question_intent: 'timeline_question', question_category: 'sgr' },
    ];
    const r = stats.aggregate(msgs, { users: { op1: 'Алия', op2: 'Бекболот' } });
    assert.strictEqual(r.totals.total, 4);
    assert.strictEqual(r.operators.length, 2);
    // sorted by total desc → op1 first
    assert.strictEqual(r.operators[0].display_name, 'Алия');
    assert.strictEqual(r.operators[0].total, 3);
    assert.strictEqual(r.operators[0].by_intent.price_question, 2);
    assert.strictEqual(r.operators[0].by_category.declaration, 2);
    assert.strictEqual(r.totals.by_intent.price_question, 2);
    assert.strictEqual(r.totals.by_category.sgr, 1);
  });

  await test('missing handled_by → unassigned bucket; missing intent → unknown', () => {
    const r = stats.aggregate([{ question_intent: null, question_category: null }], {});
    assert.strictEqual(r.operators[0].operator_id, 'unassigned');
    assert.strictEqual(r.operators[0].display_name, 'Не закреплено');
    assert.strictEqual(r.operators[0].by_intent.unknown, 1);
  });

  await test('empty input → empty operators, zero totals', () => {
    const r = stats.aggregate([], {});
    assert.deepStrictEqual(r.operators, []);
    assert.strictEqual(r.totals.total, 0);
  });

  console.log('\n[recordOutboundReply — classifies last inbound, attributes operator]');
  await test('stores outbound with handled_by + question classification', async () => {
    let created = null;
    const fakeModel = {
      findOne: () => ({ sort: () => ({ lean: async () => ({ body: 'сколько стоит сертификат?' }) }) }),
      create: async (doc) => { created = doc; return doc; },
    };
    const doc = await stats.recordOutboundReply(
      { to: '+996 700 11 22 33', body: 'ответ', handledBy: 'op9' },
      { WhatsAppMessage: fakeModel },
    );
    assert.strictEqual(created.direction, 'outbound');
    assert.strictEqual(created.handled_by, 'op9');
    assert.strictEqual(created.to_phone, '+996 700 11 22 33');
    // "сколько стоит" → price_question; "сертификат" → certificate
    assert.strictEqual(created.question_intent, 'price_question');
    assert.strictEqual(created.question_category, 'certificate');
    assert.ok(doc);
  });

  await test('no prior inbound → classifies empty (unknown) but still records', async () => {
    let created = null;
    const fakeModel = {
      findOne: () => ({ sort: () => ({ lean: async () => null }) }),
      create: async (doc) => { created = doc; return doc; },
    };
    await stats.recordOutboundReply(
      { to: '996700112233', body: 'hi', handledBy: 'op1' },
      { WhatsAppMessage: fakeModel },
    );
    assert.strictEqual(created.question_intent, 'unknown');
    assert.strictEqual(created.question_category, 'unknown');
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
