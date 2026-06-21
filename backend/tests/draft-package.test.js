'use strict';

// Self-contained test for the Draft Package Generator.
// Two layers:
//   1. Pure logic — completeness evaluation, confidence scoring/bands, duplicate
//      detection, reason composition, the full CREATE_DECLARATION_ROW build, and
//      dedupe keying. No DB.
//   2. End-to-end — spins up a throwaway local mongod, then exercises
//      generate (read-only inputs → pending proposals) → idempotency → listPending
//      → decide(approve/reject), asserting NO external writes occur.
//
// Run: node tests/draft-package.test.js
// Requires the `mongod` binary on PATH for the e2e layer; if unavailable the e2e
// layer is skipped and reported as SKIP. The pure layer always runs.

const assert   = require('assert');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const { spawn, spawnSync } = require('child_process');
const mongoose = require('mongoose');

let pass = 0, fail = 0, skip = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const svc = require('../src/services/draftPackageService');

// Fake Sheets client supporting values.append (Approved Draft Execution). Each
// append takes the next row, stores the status cell (column G) so the read-after-
// write verify in sheetsSync can confirm it, and returns an updatedRange.
function makeAppendSheetsMock({ sheetName = 'Декларации', startRow = 2 } = {}) {
  const store = new Map();
  const calls = { append: [], get: [] };
  let nextRow = startRow;
  const q = `'${sheetName}'`;
  const client = {
    spreadsheets: {
      get: async () => ({ data: { properties: { title: sheetName }, sheets: [{ properties: { title: sheetName } }] } }),
      values: {
        append: async (req) => {
          calls.append.push(req);
          const row    = nextRow++;
          const values = req.requestBody.values[0];
          store.set(`${q}!G${row}`, values[6]); // status column
          return { data: { updates: { updatedRange: `${q}!A${row}:G${row}` } } };
        },
        get: async (req) => {
          calls.get.push(req);
          const v = store.get(req.range);
          return { data: v == null ? {} : { values: [[v]] } };
        },
        update: async (req) => { store.set(req.range, req.requestBody.values[0][0]); return { data: {} }; },
      },
    },
  };
  return { client, store, calls };
}

// A complete, promotable application.
const APP = {
  row:          7,
  legal_entity: 'ОсОО Ромашка',
  phone:        '+996700112233',
  submitted_at: new Date('2026-06-18T10:00:00Z'),
};

// ─── Layer 1: pure logic ──────────────────────────────────────────────────────

async function pureTests() {
  console.log('\n[Pure logic]');

  await test('confidenceBand maps score → HIGH/MEDIUM/LOW', () => {
    assert.strictEqual(svc.confidenceBand(95), 'HIGH');
    assert.strictEqual(svc.confidenceBand(80), 'HIGH');
    assert.strictEqual(svc.confidenceBand(60), 'MEDIUM');
    assert.strictEqual(svc.confidenceBand(59), 'LOW');
  });

  await test('evaluateApplication: entity + phone alone is sufficient at base confidence', () => {
    const r = svc.evaluateApplication(APP, {});
    assert.strictEqual(r.sufficient, true);
    assert.strictEqual(r.confidence, svc.CONF.base);
    assert.strictEqual(r.band, 'MEDIUM');
    assert.ok(r.evidence.some(e => e.kind === 'application'));
    // missing payment/certificate/document_type are surfaced
    assert.ok(r.missing.some(m => m.field === 'payment'));
  });

  await test('evaluateApplication: payment + certificate signals reach the example 95%', () => {
    const r = svc.evaluateApplication(APP, {
      payment:     { detail: 'Payment of 5000 detected via WhatsApp receipt.' },
      certificate: { detail: 'IP registration certificate attached.' },
    });
    assert.strictEqual(r.confidence, 95); // base 60 + payment 20 + certificate 15
    assert.strictEqual(r.band, 'HIGH');
  });

  await test('evaluateApplication: missing entity → insufficient (no anchor)', () => {
    const r = svc.evaluateApplication({ row: 1, phone: '+996700112233' }, {});
    assert.strictEqual(r.sufficient, false);
    assert.strictEqual(r.confidence, 0);
    assert.ok(r.missing.some(m => m.field === 'legal_entity'));
  });

  await test('evaluateApplication: unnormalizable phone → insufficient (no channel)', () => {
    const r = svc.evaluateApplication({ row: 1, legal_entity: 'ОсОО Ромашка', phone: '123' }, {});
    assert.strictEqual(r.sufficient, false);
    assert.ok(r.missing.some(m => m.field === 'phone'));
  });

  await test('evaluateApplication: duplicate warning lowers confidence and adds evidence', () => {
    const base = svc.evaluateApplication(APP, { payment: { detail: 'paid' } });
    const dup  = svc.evaluateApplication(APP, {
      payment: { detail: 'paid' },
      possible_duplicate: { ref: 'declaration_row:42', detail: 'looks like a duplicate' },
    });
    assert.strictEqual(dup.confidence, base.confidence - svc.CONF.duplicate_penalty);
    assert.ok(dup.evidence.some(e => e.kind === 'duplicate_warning'));
  });

  await test('findPossibleDuplicate: same entity + same phone → warns', () => {
    const decls = [{ _id: 'd1', client_name: 'ОсОО Ромашка', phone: '0700112233', sheet_row_id: '42' }];
    const dup = svc.findPossibleDuplicate(decls, APP);
    assert.ok(dup);
    assert.strictEqual(dup.ref, 'declaration_row:42');
  });

  await test('findPossibleDuplicate: same phone but different entity → no warning (separate order)', () => {
    const decls = [{ _id: 'd1', client_name: 'ИП Иванов', phone: '0700112233', sheet_row_id: '42' }];
    assert.strictEqual(svc.findPossibleDuplicate(decls, APP), null);
  });

  await test('buildCreateDeclarationDraft: full six-field contract + proposed row at «Запустить»', () => {
    const pkg = svc.buildCreateDeclarationDraft(APP, {
      payment:     { detail: 'Payment detected.', amount: 5000, date: new Date('2026-06-18') },
      certificate: { detail: 'Certificate received.' },
      document_type: 'ДС',
    });
    assert.strictEqual(pkg.generated, true);
    assert.strictEqual(pkg.proposed_action, 'CREATE_DECLARATION_ROW');
    assert.ok(pkg.reason && pkg.impact);
    assert.ok(Array.isArray(pkg.evidence) && pkg.evidence.length >= 3);
    assert.strictEqual(pkg.confidence, 100); // 60+20+15+5
    assert.strictEqual(pkg.confidence_band, 'HIGH');
    assert.strictEqual(pkg.proposed_data.status, svc.PROMOTION_STATUS);
    assert.strictEqual(pkg.proposed_data.status, 'Запустить');
    assert.strictEqual(pkg.proposed_data.client_name, 'ОсОО Ромашка');
    assert.strictEqual(pkg.proposed_data.phone, '700112233'); // normalized local
    assert.strictEqual(pkg.proposed_data.payment_amount, 5000);
  });

  await test('buildCreateDeclarationDraft: insufficient evidence → not generated', () => {
    const pkg = svc.buildCreateDeclarationDraft({ row: 2, phone: 'abc' }, {});
    assert.strictEqual(pkg.generated, false);
    assert.strictEqual(pkg.reason, 'insufficient_evidence');
  });

  await test('dedupeKey: stable per application identity, distinct per submission', () => {
    const k1 = svc.dedupeKey(APP);
    const k2 = svc.dedupeKey({ ...APP, submitted_at: new Date('2026-07-01T10:00:00Z') });
    assert.ok(k1.startsWith('CREATE_DECLARATION_ROW|700112233|ромашка|'));
    assert.notStrictEqual(k1, k2); // same entity, different submission = separate order
  });

  await test('buildExecutionPreview: before is empty, after mirrors proposed_data', () => {
    const pkg = { proposed_action: 'CREATE_DECLARATION_ROW', proposed_data: { status: 'Запустить', client_name: 'ОсОО Ромашка' } };
    const p = svc.buildExecutionPreview(pkg);
    assert.strictEqual(p.before.declaration, null);
    assert.strictEqual(p.after.declaration.client_name, 'ОсОО Ромашка');
    assert.strictEqual(p.after.declaration.status, 'Запустить');
  });

  await test('composeReason: joins evidence details, excludes duplicate warning', () => {
    const reason = svc.composeReason([
      { kind: 'application', detail: 'Application found.' },
      { kind: 'payment',     detail: 'Payment detected.' },
      { kind: 'duplicate_warning', detail: 'looks like a dup' },
    ]);
    assert.strictEqual(reason, 'Application found. Payment detected.');
  });
}

// ─── Layer 2: end-to-end with a throwaway mongod ───────────────────────────────

function mongodAvailable() {
  const r = spawnSync('mongod', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

async function startMongo() {
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-mongo-'));
  const port   = 27034;
  const proc = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/dp_test`;
  for (let i = 0; i < 40; i++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 });
      return { proc, dbpath };
    } catch (_) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error('mongod did not become ready');
}

async function stopMongo(handle) {
  try { await mongoose.disconnect(); } catch (_) {}
  if (handle?.proc)   { try { handle.proc.kill('SIGKILL'); } catch (_) {} }
  if (handle?.dbpath) { try { fs.rmSync(handle.dbpath, { recursive: true, force: true }); } catch (_) {} }
}

async function e2eTests() {
  console.log('\n[End-to-end]');
  if (!mongodAvailable()) { skip++; console.log('  SKIP  e2e — mongod binary not available'); return; }

  let handle;
  try { handle = await startMongo(); }
  catch (err) { skip++; console.log(`  SKIP  e2e — ${err.message}`); return; }

  try {
    const { DraftPackage } = require('../src/models/DraftPackage');
    const { Declaration }  = require('../src/models/Declaration');

    // A reader stub standing in for the (read-only) New Form / New Applications source.
    const applications = [
      { row: 7, legal_entity: 'ОсОО Ромашка', phone: '+996700112233', submitted_at: new Date('2026-06-18T10:00:00Z') },
      { row: 8, legal_entity: '',             phone: '+996700999999', submitted_at: new Date('2026-06-18T11:00:00Z') }, // no entity → skipped
      { row: 9, legal_entity: 'ИП Петров',    phone: 'xx',            submitted_at: new Date('2026-06-18T12:00:00Z') }, // bad phone → skipped
    ];
    const applicationsReader = { readApplications: async () => ({ applications, reason: 'ok' }) };

    // Inject a payment signal for the promotable application only.
    const signalsFor = async (app) =>
      app.row === 7 ? { payment: { detail: 'Payment detected via WhatsApp receipt.' } } : {};

    let summary;
    await test('generate builds proposals only for sufficient applications', async () => {
      summary = await svc.generate({ applicationsReader, signalsFor, DraftPackage, Declaration });
      assert.strictEqual(summary.generated, 1);
      assert.strictEqual(summary.skipped, 2);
      assert.strictEqual(await DraftPackage.countDocuments({}), 1);
    });

    await test('generated package carries the full contract and proposed row', async () => {
      const pkg = await DraftPackage.findOne({}).lean();
      assert.strictEqual(pkg.proposed_action, 'CREATE_DECLARATION_ROW');
      assert.strictEqual(pkg.status, 'pending');
      assert.strictEqual(pkg.confidence, 80); // base 60 + payment 20
      assert.strictEqual(pkg.confidence_band, 'HIGH');
      assert.strictEqual(pkg.proposed_data.status, 'Запустить');
      assert.strictEqual(pkg.proposed_data.client_name, 'ОсОО Ромашка');
      assert.strictEqual(pkg.source.application_row, 7);
    });

    await test('generate is idempotent (same inputs → no duplicate proposals)', async () => {
      const again = await svc.generate({ applicationsReader, signalsFor, DraftPackage, Declaration });
      assert.strictEqual(again.generated, 0);
      assert.strictEqual(again.reasons.duplicate_package, 1);
      assert.strictEqual(await DraftPackage.countDocuments({}), 1);
    });

    await test('an existing matching Declaration adds a duplicate warning + lowers confidence', async () => {
      await DraftPackage.deleteMany({});
      await Declaration.create({ source: 'google_sheets', sheet_row_id: '42', client_name: 'ОсОО Ромашка', phone: '0700112233', status: 'Завершен' });
      const s = await svc.generate({ applicationsReader, signalsFor, DraftPackage, Declaration });
      assert.strictEqual(s.generated, 1);
      const pkg = await DraftPackage.findOne({}).lean();
      assert.strictEqual(pkg.confidence, 55); // 60 + 20 payment - 25 duplicate penalty
      assert.ok(pkg.evidence.some(e => e.kind === 'duplicate_warning'));
    });

    await test('listPending returns the operator-facing view, highest confidence first', async () => {
      const list = await svc.listPending(50, { DraftPackage });
      assert.strictEqual(list.length, 1);
      assert.ok(list[0].reason && list[0].impact && 'proposed_data' in list[0]);
    });

    await test('decide(approve) records intent but writes NOTHING externally', async () => {
      const pkg = await DraftPackage.findOne({});
      const declCountBefore = await Declaration.countDocuments({});
      const out = await svc.decide(pkg._id, 'approve', { decidedBy: 'tester' }, { DraftPackage });
      assert.strictEqual(out.status, 'approved');
      assert.strictEqual(out.decided_by, 'tester');
      // No Declaration row was created — approval is output only.
      assert.strictEqual(await Declaration.countDocuments({}), declCountBefore);
    });

    await test('deciding an already-decided package is rejected', async () => {
      const pkg = await DraftPackage.findOne({ status: 'approved' });
      await assert.rejects(() => svc.decide(pkg._id, 'reject', {}, { DraftPackage }), /already approved/);
    });

    await test('decide(reject) dismisses a pending package', async () => {
      await DraftPackage.deleteMany({});
      const pkg = await DraftPackage.create({
        proposed_action: 'CREATE_DECLARATION_ROW', reason: 'r', confidence: 60, confidence_band: 'MEDIUM',
        impact: 'i', dedupe_key: 'k-reject', status: 'pending',
      });
      const out = await svc.decide(pkg._id, 'reject', {}, { DraftPackage });
      assert.strictEqual(out.status, 'rejected');
    });

    // ── Approved Draft Execution ──────────────────────────────────────────────
    const sheetsSync = require('../src/integrations/sheetsSync');
    process.env.DECLARATION_SHEET_ID   = 'exec-spreadsheet-id';
    process.env.DECLARATION_SHEET_NAME = 'Декларации';

    const PROPOSED = {
      status: 'Запустить', client_name: 'ОсОО Ромашка', phone: '700112233',
      document_type: 'ДС', payment_amount: 5000, payment_date: null, source: 'google_sheets', notes: null,
    };
    async function freshPackage(status = 'pending', key = `k-exec-${Date.now()}-${Math.random()}`) {
      return DraftPackage.create({
        proposed_action: 'CREATE_DECLARATION_ROW', reason: 'Application found. Payment detected.',
        confidence: 80, confidence_band: 'HIGH', impact: 'i', proposed_data: PROPOSED,
        dedupe_key: key, status,
      });
    }

    await test('SAFETY: execute refuses a package that is not approved', async () => {
      const pkg = await freshPackage('pending');
      await assert.rejects(
        () => svc.executeApprovedPackage(pkg._id, { executedBy: 't' }, { DraftPackage, Declaration, sheetsSync }),
        /must be "approved"/
      );
      // Package untouched — no transition to executed, no execution log.
      const after = await DraftPackage.findById(pkg._id).lean();
      assert.strictEqual(after.status, 'pending');
      assert.ok(!after.execution || !after.execution.sheet_row_id);
    });

    await test('previewExecution is read-only (no append, no Declaration)', async () => {
      const mock = makeAppendSheetsMock();
      sheetsSync._setSheetsClient(mock.client);
      const pkg = await freshPackage('approved');
      const declBefore = await Declaration.countDocuments({});
      const out = await svc.previewExecution(pkg._id, { DraftPackage });
      assert.strictEqual(out.preview.before.declaration, null);
      assert.strictEqual(out.preview.after.declaration.client_name, 'ОсОО Ромашка');
      assert.strictEqual(mock.calls.append.length, 0);
      assert.strictEqual(await Declaration.countDocuments({}), declBefore);
    });

    let executed;
    await test('execute appends the row, creates the linked Declaration, logs execution', async () => {
      const mock = makeAppendSheetsMock({ startRow: 2 });
      sheetsSync._setSheetsClient(mock.client);
      const pkg = await freshPackage('approved');

      const res = await svc.executeApprovedPackage(pkg._id, { executedBy: 'tester' }, { DraftPackage, Declaration, sheetsSync });
      executed = res;
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.operator, 'tester');
      assert.ok(res.sheet_row_id, 'sheet_row_id assigned');
      assert.ok(res.declaration_id, 'declaration_id returned');
      assert.ok(res.executed_at instanceof Date);
      // before/after preview
      assert.strictEqual(res.preview.before.declaration, null);
      assert.strictEqual(res.preview.after.sheet_row_id, res.sheet_row_id);

      // Exactly one append; the status cell stored lowercase to match the sheet.
      assert.strictEqual(mock.calls.append.length, 1);
      assert.strictEqual(mock.store.get(`'Декларации'!G${res.sheet_row_id}`), 'запустить');

      // Declaration replica created and synced to the new row.
      const decl = await Declaration.findById(res.declaration_id).lean();
      assert.strictEqual(decl.sheet_row_id, res.sheet_row_id);
      assert.strictEqual(decl.status, 'Запустить');         // canonical mirror
      assert.strictEqual(decl.client_name, 'ОсОО Ромашка');
      assert.strictEqual(decl.source, 'google_sheets');
      assert.strictEqual(decl.sync_status, 'synced');

      // Execution audit log on the package: operator, timestamp, draft id, row created.
      const after = await DraftPackage.findById(pkg._id).lean();
      assert.strictEqual(after.status, 'executed');
      assert.strictEqual(after.execution.executed_by, 'tester');
      assert.ok(after.execution.executed_at);
      assert.strictEqual(String(after.execution.declaration_id), String(res.declaration_id));
      assert.strictEqual(after.execution.sheet_row_id, res.sheet_row_id);
    });

    await test('SAFETY: re-executing an executed package is refused (no second row)', async () => {
      const mock = makeAppendSheetsMock();
      sheetsSync._setSheetsClient(mock.client);
      const pkg = await DraftPackage.findById(executed.draft_id);
      await assert.rejects(
        () => svc.executeApprovedPackage(pkg._id, { executedBy: 'tester' }, { DraftPackage, Declaration, sheetsSync }),
        /already executed/
      );
      assert.strictEqual(mock.calls.append.length, 0);
    });

    await test('SAFETY: only CREATE_DECLARATION_ROW is executable', async () => {
      const pkg = await DraftPackage.create({
        proposed_action: 'CREATE_DECLARATION_ROW', reason: 'r', confidence: 80, confidence_band: 'HIGH',
        impact: 'i', proposed_data: PROPOSED, dedupe_key: `k-action-${Date.now()}`, status: 'approved',
      });
      // Force an out-of-scope action directly in the DB (bypassing enum on create path).
      await DraftPackage.collection.updateOne({ _id: pkg._id }, { $set: { proposed_action: 'SOME_OTHER_ACTION' } });
      await assert.rejects(
        () => svc.executeApprovedPackage(pkg._id, {}, { DraftPackage, Declaration, sheetsSync }),
        /Only CREATE_DECLARATION_ROW/
      );
    });

    await test('append verify mismatch → nothing created, package stays approved (retryable)', async () => {
      const mock = makeAppendSheetsMock();
      // Verify read-back returns a different value than what was appended.
      mock.client.spreadsheets.values.get = async () => ({ data: { values: [['что-то другое']] } });
      sheetsSync._setSheetsClient(mock.client);
      const pkg = await freshPackage('approved');
      const declBefore = await Declaration.countDocuments({});

      const res = await svc.executeApprovedPackage(pkg._id, { executedBy: 'tester' }, { DraftPackage, Declaration, sheetsSync });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(await Declaration.countDocuments({}), declBefore); // no row created
      const after = await DraftPackage.findById(pkg._id).lean();
      assert.strictEqual(after.status, 'approved'); // still retryable
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
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
