'use strict';

// Tests for the Certification Knowledge Base builder.
//   Layer 1 (pure): extraction heuristics — sentences, categories, prices, timelines,
//     TN VED, outdated detection, per-video extraction, review package.
//   Layer 2 (e2e): throwaway mongod — ingest persists pending+needs_review entries,
//     idempotency, review gating (approve/reject), getApprovedKnowledge returns
//     approved-ONLY, and the four report deliverables.
//
// Run: node tests/knowledge-base.test.js  (e2e skipped if mongod is absent)

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

const ex = require('../src/services/knowledgeExtractionService');

const T1 = 'Декларация о соответствии оформляется на продукцию. Сертификат соответствия требуется для рискованной продукции. Нужно знать код ТН ВЭД товара. Стоимость декларации составляет 15000 сом. Оформление занимает 5 рабочих дней. Для испытаний нужно предоставить образцы в лабораторию.';

async function pureTests() {
  console.log('\n[Pure extraction]');

  await test('splitSentences splits and trims', () => {
    const s = ex.splitSentences('Первое предложение. Второе предложение! Третье?');
    assert.strictEqual(s.length, 3);
  });

  await test('detectCategories maps domain keywords', () => {
    assert.deepStrictEqual(ex.detectCategories('Декларация о соответствии'), ['Declarations']);
    assert.deepStrictEqual(ex.detectCategories('Сертификат соответствия'), ['Certificates']);
    assert.deepStrictEqual(ex.detectCategories('код ТН ВЭД товара'), ['TN VED']);
    assert.ok(ex.detectCategories('каждое наименование это позиция').includes('PI Calculations'));
    assert.ok(ex.detectCategories('предоставить образцы в лабораторию').includes('Samples'));
    assert.ok(ex.detectCategories('предоставить образцы в лабораторию').includes('Laboratories'));
  });

  await test('extractPrices reads сом and рублей', () => {
    const p = ex.extractPrices('Стоимость 15000 сом, а доставка 8000 рублей.');
    assert.strictEqual(p.length, 2);
    assert.strictEqual(p[0].amount, 15000);
    assert.strictEqual(p[0].currency, 'сом');
    assert.strictEqual(p[1].amount, 8000);
  });

  await test('extractTimelines reads business days and plain days', () => {
    const t = ex.extractTimelines('Оформление занимает 5 рабочих дней. Испытания 10 дней.');
    assert.strictEqual(t.length, 2);
    assert.strictEqual(t[0].value, 5);
    assert.strictEqual(t[0].business_days, true);
    assert.strictEqual(t[1].value, 10);
  });

  await test('extractTnVed captures codes near ТН ВЭД', () => {
    const v = ex.extractTnVed('Код ТН ВЭД 1905 90 определяет изделия.');
    assert.strictEqual(v.length, 1);
    assert.ok(v[0].codes.length >= 1);
  });

  await test('isPossiblyOutdated flags year / price / cue / old age', () => {
    assert.strictEqual(ex.isPossiblyOutdated('правила 2019 года', null, false), true);
    assert.strictEqual(ex.isPossiblyOutdated('цена 25000 сом', null, true), true);   // price
    assert.strictEqual(ex.isPossiblyOutdated('раньше было иначе', null, false), true); // cue
    assert.strictEqual(ex.isPossiblyOutdated('обычное предложение', new Date('2018-01-01'), false), true); // old
    assert.strictEqual(ex.isPossiblyOutdated('обычное предложение', new Date(), false), false);
  });

  await test('buildVideoExtraction produces rules, price, timeline, questions', () => {
    const r = ex.buildVideoExtraction({ video: { video_id: 'v1', title: 'T', published_at: new Date('2021-03-10') }, transcript: { text: T1 } });
    assert.ok(r.rules.length >= 2, 'has business rules');
    assert.ok(r.prices.length === 1, 'one price');
    assert.strictEqual(r.prices[0].value.amount, 15000);
    assert.ok(r.timelines.length === 1, 'one timeline');
    assert.ok(r.possibly_outdated, 'old + price → outdated');
    assert.ok(r.questions.length >= 1, 'raises operator questions');
    assert.ok(r.summary.includes('heuristic summary'));
    // every entry is a review candidate (no truth decided here)
    assert.ok(r.entries.every(e => ['HIGH','MEDIUM','LOW'].includes(e.confidence)));
  });

  await test('buildReviewPackage aggregates by category', () => {
    const r = ex.buildVideoExtraction({ video: { video_id: 'v1', title: 'T', published_at: new Date('2021-03-10') }, transcript: { text: T1 } });
    const pkg = ex.buildReviewPackage([r]);
    assert.strictEqual(pkg.video_count, 1);
    assert.ok(pkg.entry_count > 0);
    assert.ok(pkg.by_category['Payments'] >= 1);
  });
}

// ─── e2e ────────────────────────────────────────────────────────────────────────
function mongodAvailable() { return spawnSync('mongod', ['--version'], { encoding: 'utf8' }).status === 0; }
async function startMongo() {
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mongo-'));
  const port = 27036;
  const proc = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/kb_test`;
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
  let handle; try { handle = await startMongo(); } catch (e) { skip++; console.log(`  SKIP  e2e — ${e.message}`); return; }

  try {
    const kb = require('../src/services/knowledgeBaseService');
    const { KbEntry } = require('../src/models/KbEntry');

    const video = { video_id: 'vidE2E001', title: 'Сертификаты и декларации', published_at: new Date('2021-03-10'), channel: '@dokumenty_pro' };

    let ingest;
    await test('ingestVideo persists pending + needs_review entries (nothing activated)', async () => {
      ingest = await kb.ingestVideo(video, { text: T1 }, {});
      assert.ok(ingest.created > 0);
      const all = await KbEntry.find({ source_video_id: 'vidE2E001' }).lean();
      assert.ok(all.length > 0);
      assert.ok(all.every(e => e.status === 'pending' && e.needs_review === true));
    });

    await test('re-ingest is idempotent (deduped)', async () => {
      const again = await kb.ingestVideo(video, { text: T1 }, {});
      assert.strictEqual(again.created, 0);
      assert.ok(again.skipped > 0);
    });

    await test('getApprovedKnowledge is empty before any approval', async () => {
      assert.strictEqual((await kb.getApprovedKnowledge()).length, 0);
    });

    let approvedId;
    await test('decideEntry(approve) activates exactly one entry', async () => {
      const pending = await kb.listForReview({});
      approvedId = pending[0]._id;
      const e = await kb.decideEntry(approvedId, 'approve', { decidedBy: 'operator' });
      assert.strictEqual(e.status, 'approved');
      assert.strictEqual(e.needs_review, false);
    });

    await test('getApprovedKnowledge returns approved-ONLY', async () => {
      const approved = await kb.getApprovedKnowledge();
      assert.strictEqual(approved.length, 1);
      assert.strictEqual(String(approved[0]._id), String(approvedId));
      assert.strictEqual(approved[0].status, 'approved');
    });

    await test('decideEntry(reject) keeps it out of approved knowledge', async () => {
      const pending = await kb.listForReview({});
      const e = await kb.decideEntry(pending[0]._id, 'reject', { decidedBy: 'operator', note: 'outdated price' });
      assert.strictEqual(e.status, 'rejected');
      const approved = await kb.getApprovedKnowledge();
      assert.ok(approved.every(a => a.status === 'approved'));
    });

    await test('buildReports returns the four deliverables', async () => {
      const rep = await kb.buildReports();
      assert.ok(rep.inventory.find(v => v.video_id === 'vidE2E001'));
      const er = rep.extractionReport.find(v => v.video_id === 'vidE2E001');
      assert.ok(er.summary && (er.rules.length + er.facts.length) > 0);
      assert.ok(er.prices.length >= 1 && er.timelines.length >= 1);
      assert.ok(rep.outdatedReport.total_outdated_entries >= 1);
      assert.ok(rep.structure.categories.includes('TN VED'));
      assert.ok(/Only status:approved/.test(rep.structure.activation_rule));
      assert.ok(rep.structure.counts['Payments'].total >= 1);
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
