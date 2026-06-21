'use strict';

// Self-contained, PUPPETEER-FREE tests for the WhatsApp live-testing sprint:
//   • TEST_MODE gating (allowed contact vs observe-only) and handling decisions,
//   • the read-only file classifier + explainer (goals #5/#6),
//   • the analyzeMessage pipeline wiring (goals #1–#9) with injected fakes so no
//     DB / Sheets / network is touched.
//
// Run: node tests/whatsapp-test-mode.test.js

const assert = require('assert');

const tm        = require('../src/services/whatsappTestModeService');
const classifier = require('../src/services/fileClassifierService');
const liveTest  = require('../src/services/whatsappLiveTestService');

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  console.log('\n[TEST_MODE gating]');

  await test('isTestMode reads truthy flags', () => {
    assert.strictEqual(tm.isTestMode({ TEST_MODE: 'true' }), true);
    assert.strictEqual(tm.isTestMode({ TEST_MODE: '1' }), true);
    assert.strictEqual(tm.isTestMode({ TEST_MODE: 'on' }), true);
    assert.strictEqual(tm.isTestMode({ TEST_MODE: 'false' }), false);
    assert.strictEqual(tm.isTestMode({}), false);
  });

  await test('allowedContactName defaults to "Мой Билайн"', () => {
    assert.strictEqual(tm.allowedContactName({}), 'Мой Билайн');
    assert.strictEqual(tm.allowedContactName({ WHATSAPP_TEST_CONTACT: 'Test Peer' }), 'Test Peer');
  });

  await test('isAllowedContact matches by saved name (case-insensitive)', () => {
    assert.strictEqual(tm.isAllowedContact({ name: 'Мой Билайн' }, 'Мой Билайн'), true);
    assert.strictEqual(tm.isAllowedContact({ pushname: 'мой билайн' }, 'Мой Билайн'), true);
    assert.strictEqual(tm.isAllowedContact({ name: 'Иван Клиент' }, 'Мой Билайн'), false);
  });

  await test('isAllowedContact matches by number when allowed value is a phone', () => {
    assert.strictEqual(tm.isAllowedContact({ number: '996700112233' }, '700112233'), true);
    assert.strictEqual(tm.isAllowedContact({ number: '996700999999' }, '700112233'), false);
  });

  await test('decideHandling routes self / allowed / others correctly', () => {
    assert.strictEqual(tm.decideHandling({ fromMe: true,  testMode: true,  allowed: true }),  'skip_self');
    assert.strictEqual(tm.decideHandling({ fromMe: false, testMode: true,  allowed: true }),  'process');
    assert.strictEqual(tm.decideHandling({ fromMe: false, testMode: true,  allowed: false }), 'observe_only');
    assert.strictEqual(tm.decideHandling({ fromMe: false, testMode: false, allowed: false }), 'process'); // TEST_MODE off → all processed
  });

  console.log('\n[File classifier + explainer]');

  await test('classifies the four required file kinds', () => {
    assert.strictEqual(classifier.fileKind({ mime_type: 'application/pdf' }), 'pdf');
    assert.strictEqual(classifier.fileKind({ mime_type: 'image/jpeg' }), 'image');
    assert.strictEqual(classifier.fileKind({ mime_type: 'image/png' }), 'image');
    assert.strictEqual(classifier.fileKind({ file_name: 'x.docx' }), 'word');
    assert.strictEqual(classifier.fileKind({ file_name: 'y.xlsx' }), 'excel');
  });

  await test('classifyAttachment maps filename keywords to categories', () => {
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'чек_оплаты.pdf', mime_type: 'application/pdf' }).category, 'payment_receipt');
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'макет_v1.pdf', mime_type: 'application/pdf' }).category, 'layout');
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'свидетельство_ИП.jpg', mime_type: 'image/jpeg' }).category, 'ip_registration');
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'устав.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }).category, 'company_registration');
  });

  await test('confidence: HIGH when kind+keyword agree, MEDIUM kind-only, LOW neither', () => {
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'чек.pdf', mime_type: 'application/pdf' }).confidence, 'HIGH');
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'scan001.pdf', mime_type: 'application/pdf' }).confidence, 'MEDIUM');
    assert.strictEqual(classifier.classifyAttachment({ file_name: 'note', mime_type: 'text/plain' }).confidence, 'LOW');
  });

  await test('explainAttachment produces a read-only explanation, no content parsing', () => {
    const ex = classifier.explainAttachment({ file_name: 'чек_оплаты.pdf', mime_type: 'application/pdf', size: 51234 });
    assert.ok(/PDF document/.test(ex.explanation));
    assert.ok(/payment receipt/.test(ex.explanation));
    assert.ok(/contents were not parsed/i.test(ex.explanation));
  });

  console.log('\n[analyzeMessage pipeline (injected fakes — no I/O)]');

  // Fakes for the read-only search dependencies.
  const matchService = {
    lookupOrdersByPhone: async (phone) => ({
      phone, phone_key: '700112233', match_status: 'matched', match_count: 1,
      results: [{ row: '5', client: 'ОсОО Ромашка', document: 'ДС', status: 'Ждем макет' }],
      last_declaration_row: { row: '5' },
    }),
  };
  const applicationMatchService = {
    matchConversation: async () => ({
      status: 'matched', confidence: 'HIGH', application_count: 1,
      candidates: [{ row: 7, legal_entity: 'ОсОО Ромашка', submitted_at: new Date('2026-06-18'), score: 0.9, signals: { phone: true } }],
    }),
  };
  const draftPackageService = require('../src/services/draftPackageService'); // pure builder only

  await test('text message exercises goals 1, 7, 8, 9 (draft built dry, not persisted)', async () => {
    const raw = {
      id: 'm1', from: '996700112233@c.us', contact: { name: 'Мой Билайн' },
      body: 'Документы по ОсОО Ромашка', timestamp: Math.floor(Date.now() / 1000), attachments: [],
    };
    const r = await liveTest.analyzeMessage(raw, { matchService, applicationMatchService, draftPackageService });
    assert.strictEqual(r.goals.text.length, raw.body.length);
    assert.strictEqual(r.goals.declaration_search.match_status, 'matched');
    assert.strictEqual(r.goals.new_form_search.status, 'matched');
    assert.strictEqual(r.goals.draft_package.generated, true);
    assert.strictEqual(r.goals.draft_package.dry_run, true);
    assert.strictEqual(r.goals.draft_package.proposed_action, 'CREATE_DECLARATION_ROW');
  });

  await test('attachment message exercises goals 2–6 (receive/classify/explain)', async () => {
    const raw = {
      id: 'm2', from: '996700112233@c.us', contact: { name: 'Мой Билайн' }, body: '',
      timestamp: Math.floor(Date.now() / 1000),
      attachments: [{ file_name: 'чек_оплаты.pdf', mime_type: 'application/pdf', size: 1024 }],
    };
    const r = await liveTest.analyzeMessage(raw, { matchService, applicationMatchService, draftPackageService });
    assert.strictEqual(r.goals.attachments.length, 1);
    assert.strictEqual(r.goals.attachments[0].kind, 'pdf');
    assert.strictEqual(r.goals.attachments[0].category, 'payment_receipt');
    assert.ok(r.goals.attachments[0].explanation);
  });

  await test('search steps degrade to blockers when a dependency throws (graceful)', async () => {
    const throwing = { lookupOrdersByPhone: async () => { throw new Error('no DB'); } };
    const throwingNF = { matchConversation: async () => { throw new Error('no sheets creds'); } };
    const raw = { id: 'm3', from: '996700112233@c.us', contact: { name: 'Мой Билайн' }, body: 'hi', timestamp: 0, attachments: [] };
    const r = await liveTest.analyzeMessage(raw, { matchService: throwing, applicationMatchService: throwingNF, draftPackageService });
    assert.ok(r.goals.declaration_search.blocker);
    assert.ok(r.goals.new_form_search.blocker);
    assert.strictEqual(r.goals.draft_package.reason, 'new_form_unavailable');
  });

  console.log(`\n──────────────────────────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`); }
  process.exit(fail > 0 ? 1 : 0);
})();
