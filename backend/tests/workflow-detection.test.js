'use strict';

// Self-contained test for the Gmail Agent workflow-detection MVP.
// Two layers:
//   1. Pure logic — classification, recommendation decision, sender gate, and the
//      gmailClient body/attachment extraction. No DB.
//   2. End-to-end — spins up a throwaway local mongod, then exercises
//      detect → list → confirm (status + sheet update) → reject → idempotency.
//
// Run: node tests/workflow-detection.test.js
// Requires the `mongod` binary on PATH (used for the e2e layer; if unavailable the
// e2e layer is skipped and reported as SKIP, pure layer still runs).

const assert      = require('assert');
const os          = require('os');
const fs          = require('fs');
const path        = require('path');
const { spawn, spawnSync } = require('child_process');
const mongoose    = require('mongoose');

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

// ─── Synthetic Gmail message builder ────────────────────────────────────────────
// Mirrors the shape gmailClient expects from a format='full' fetch.

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function buildMessage({ id = 'msg-1', from, subject, bodyText, attachments = [] }) {
  const parts = [
    { mimeType: 'text/plain', body: { data: b64url(bodyText || '') } },
  ];
  for (const fn of attachments) {
    parts.push({ filename: fn, mimeType: 'application/pdf', body: { attachmentId: 'a' } });
  }
  return {
    id,
    payload: {
      headers: [
        { name: 'From',    value: from },
        { name: 'Subject', value: subject },
      ],
      parts,
    },
  };
}

// Fake Google Sheets client backed by an in-memory range→value store. Supports
// the metadata get (verifySpreadsheet), values.update (write), and values.get
// (read-after-write verify).
function makeSheetsMock({ title = 'Декларации', tabs = ['Декларации'] } = {}) {
  const store = new Map();
  const calls = { update: [], get: [], meta: [] };
  const client = {
    spreadsheets: {
      get: async (req) => {
        calls.meta.push(req);
        return { data: { properties: { title }, sheets: tabs.map(t => ({ properties: { title: t } })) } };
      },
      values: {
        update: async (req) => {
          calls.update.push(req);
          store.set(req.range, req.requestBody.values[0][0]);
          return { data: {} };
        },
        get: async (req) => {
          calls.get.push(req);
          const v = store.get(req.range);
          return { data: v == null ? {} : { values: [[v]] } };
        },
      },
    },
  };
  return { client, store, calls };
}

const gmailClient = require('../src/integrations/gmailClient');
const svc         = require('../src/services/workflowDetectionService');
const googleAuth  = require('../src/integrations/googleAuth');

const LAB = 'standartpro98@gmail.com';

// ─── Layer 1: pure logic ────────────────────────────────────────────────────────

async function pureTests() {
  console.log('\n[Pure logic]');

  await test('isKnownLabSender accepts known lab in angle brackets', () => {
    assert.strictEqual(svc.isKnownLabSender(`Lab <${LAB}>`), true);
  });
  await test('isKnownLabSender rejects unknown sender', () => {
    assert.strictEqual(svc.isKnownLabSender('Someone <a@other.com>'), false);
  });

  await test('classifyMessage detects layout from body keyword', () => {
    const { matchedByEvent } = svc.classifyMessage({ body: 'Здравствуйте, согласуйте макет', filenames: [] });
    assert.ok(matchedByEvent.LAYOUT_RECEIVED, 'LAYOUT_RECEIVED expected');
    assert.ok(!matchedByEvent.ORIGINAL_RECEIVED);
  });

  await test('classifyMessage detects original from body + filename', () => {
    const { matchedByEvent } = svc.classifyMessage({ body: 'ДС во вложении', filenames: ['декларация.pdf'] });
    assert.ok(matchedByEvent.ORIGINAL_RECEIVED, 'ORIGINAL_RECEIVED expected');
  });

  await test('classifyMessage flags both events (conflict cues)', () => {
    const { matchedByEvent } = svc.classifyMessage({ body: 'макет и ДС во вложении', filenames: [] });
    assert.ok(matchedByEvent.LAYOUT_RECEIVED && matchedByEvent.ORIGINAL_RECEIVED);
  });

  await test('classifyMessage returns nothing for unrelated mail', () => {
    const { matchedByEvent } = svc.classifyMessage({ body: 'добрый день, как дела', filenames: ['photo.png'] });
    assert.deepStrictEqual(matchedByEvent, {});
  });

  await test('decideRecommendation: layout from "Ждем макет" → transition', () => {
    assert.deepStrictEqual(
      svc.decideRecommendation('LAYOUT_RECEIVED', 'Ждем макет'),
      { recommendation: 'transition', recommended_to: 'На согласовании' }
    );
  });
  await test('decideRecommendation: layout from "Ждем оригинал" → transition (Case B)', () => {
    assert.deepStrictEqual(
      svc.decideRecommendation('LAYOUT_RECEIVED', 'Ждем оригинал'),
      { recommendation: 'transition', recommended_to: 'На согласовании' }
    );
  });
  await test('decideRecommendation: original from "Ждем оригинал" → transition', () => {
    assert.deepStrictEqual(
      svc.decideRecommendation('ORIGINAL_RECEIVED', 'Ждем оригинал'),
      { recommendation: 'transition', recommended_to: 'Оригинал получен' }
    );
  });
  await test('decideRecommendation: wrong precondition → needs_review', () => {
    assert.deepStrictEqual(
      svc.decideRecommendation('LAYOUT_RECEIVED', 'Завершен'),
      { recommendation: 'needs_review', recommended_to: null }
    );
  });

  await test('gmailClient.getMessageBody decodes plain text', () => {
    const m = buildMessage({ from: LAB, subject: 'S', bodyText: 'согласуйте макет' });
    assert.strictEqual(gmailClient.getMessageBody(m), 'согласуйте макет');
  });
  await test('gmailClient.getAttachmentFilenames lists attachments', () => {
    const m = buildMessage({ from: LAB, subject: 'S', bodyText: 'x', attachments: ['макет.pdf', 'spec.pdf'] });
    assert.deepStrictEqual(gmailClient.getAttachmentFilenames(m), ['макет.pdf', 'spec.pdf']);
  });

  await test('toSheetStatus lowercases every canonical status', () => {
    const sheetsSync = require('../src/integrations/sheetsSync');
    const map = {
      'Запустить': 'запустить', 'Ждем макет': 'ждем макет', 'На согласовании': 'на согласовании',
      'Ждем оригинал': 'ждем оригинал', 'Оригинал получен': 'оригинал получен',
      'Завершен': 'завершен', 'Отменен': 'отменен',
    };
    for (const [canon, lower] of Object.entries(map)) {
      assert.strictEqual(sheetsSync.toSheetStatus(canon), lower);
    }
  });

  await test('verifyAuth reports missing credentials (no network)', async () => {
    const saved = process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    try {
      const r = await googleAuth.verifyAuth();
      assert.strictEqual(r.ok, false);
      assert.ok(r.missing.includes('GOOGLE_REFRESH_TOKEN'));
    } finally {
      if (saved !== undefined) process.env.GOOGLE_REFRESH_TOKEN = saved;
    }
  });
}

// ─── Layer 2: end-to-end with a throwaway mongod ────────────────────────────────

function mongodAvailable() {
  const r = spawnSync('mongod', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

async function startMongo() {
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mongo-'));
  const port   = 27033;
  const proc = spawn('mongod', [
    '--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1',
  ], { stdio: 'ignore' });

  const uri = `mongodb://127.0.0.1:${port}/wf_test`;
  // Retry connect until mongod is accepting connections
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
  if (handle?.proc) { try { handle.proc.kill('SIGKILL'); } catch (_) {} }
  if (handle?.dbpath) { try { fs.rmSync(handle.dbpath, { recursive: true, force: true }); } catch (_) {} }
}

async function e2eTests() {
  console.log('\n[End-to-end]');
  if (!mongodAvailable()) {
    skip++;
    console.log('  SKIP  e2e — mongod binary not available');
    return;
  }

  let handle;
  try {
    handle = await startMongo();
  } catch (err) {
    skip++;
    console.log(`  SKIP  e2e — ${err.message}`);
    return;
  }

  try {
    const { Order }            = require('../src/models/Order');
    const { Declaration }      = require('../src/models/Declaration');
    const { WorkflowDetection } = require('../src/models/WorkflowDetection');
    const sheetsSync           = require('../src/integrations/sheetsSync');

    // Configure a sheet and inject a fake Sheets client (in-memory backing store).
    process.env.DECLARATION_SHEET_ID   = 'test-spreadsheet-id';
    process.env.DECLARATION_SHEET_NAME = 'Декларации';
    const sheets = makeSheetsMock();
    sheetsSync._setSheetsClient(sheets.client);

    // ── Happy path: layout received → confirm → status + sheet write-back ──
    const order = await Order.create({ status: 'Ждем макет' });
    await Declaration.create({ order_id: order._id, source: 'google_sheets', sheet_row_id: '5', status: 'Ждем макет' });

    const layoutMsg = buildMessage({
      id: 'm-layout',
      from: `Лаборатория <${LAB}>`,
      subject: 'Макет для согласования',
      bodyText: 'Здравствуйте! Согласуйте макет во вложении.',
      attachments: ['макет_v1.pdf'],
    });

    let res;
    await test('detectFromMessage creates a transition recommendation', async () => {
      res = await svc.detectFromMessage(order._id, 'thread-1', layoutMsg);
      assert.strictEqual(res.detected, true);
      assert.strictEqual(res.detection.detected_event, 'LAYOUT_RECEIVED');
      assert.strictEqual(res.detection.recommendation, 'transition');
      assert.strictEqual(res.detection.recommended_to, 'На согласовании');
    });

    await test('detection records sender, subject, last message text, attachments', async () => {
      const pending = await svc.listPending();
      assert.strictEqual(pending.length, 1);
      const p = pending[0];
      assert.strictEqual(p.sender, `Лаборатория <${LAB}>`);
      assert.strictEqual(p.subject, 'Макет для согласования');
      assert.ok(p.last_message.includes('Согласуйте макет'));
      assert.deepStrictEqual(p.attachments, ['макет_v1.pdf']);
    });

    await test('WORKFLOW_EVENT_DETECTED appended to order', async () => {
      const o = await Order.findById(order._id).lean();
      assert.ok(o.events.some(e => e.type === 'WORKFLOW_EVENT_DETECTED'));
    });

    await test('detectFromMessage is idempotent on the same message', async () => {
      const again = await svc.detectFromMessage(order._id, 'thread-1', layoutMsg);
      assert.strictEqual(again.skipped, true);
      assert.strictEqual(again.reason, 'duplicate');
      assert.strictEqual(await WorkflowDetection.countDocuments({ thread_id: 'thread-1' }), 1);
    });

    await test('confirmDetection applies transition + generates verified sheet write', async () => {
      sheets.calls.update.length = 0;
      const out = await svc.confirmDetection(res.detection._id, 'tester');
      assert.strictEqual(out.toStatus, 'На согласовании');
      assert.strictEqual(out.sheetUpdated, true);
      assert.strictEqual(out.sheetWrite.written, true);
      assert.strictEqual(out.sheetWrite.verified, true);

      const o = await Order.findById(order._id).lean();
      assert.strictEqual(o.status, 'На согласовании');
      assert.ok(o.events.some(e => e.type === 'LAB_LAYOUT_RECEIVED' && e.actor === 'operator'));
      assert.ok(o.events.some(e => e.type === 'ORDER_STATUS_CHANGED' && e.description === 'Ждем макет → На согласовании'));

      // Integration assertion: order status change → exactly one sheet update request
      // hitting the right spreadsheet/row/column. The sheet stores statuses lowercase.
      assert.strictEqual(sheets.calls.update.length, 1);
      assert.strictEqual(sheets.calls.update[0].spreadsheetId, 'test-spreadsheet-id');
      assert.strictEqual(sheets.calls.update[0].range, `'Декларации'!G5`);
      assert.strictEqual(sheets.calls.update[0].valueInputOption, 'RAW');
      assert.deepStrictEqual(sheets.calls.update[0].requestBody.values, [['на согласовании']]);

      // The written (lowercase) value is what now lives in the (fake) sheet.
      assert.strictEqual(sheets.store.get(`'Декларации'!G5`), 'на согласовании');

      const decl = await Declaration.findOne({ order_id: order._id }).lean();
      assert.strictEqual(decl.status, 'На согласовании'); // mirror stays canonical
      assert.strictEqual(decl.sync_status, 'synced'); // write verified
      assert.ok(decl.last_synced_at);

      const det = await WorkflowDetection.findById(res.detection._id).lean();
      assert.strictEqual(det.status, 'confirmed');
      assert.strictEqual(det.decided_by, 'tester');
    });

    await test('verifySpreadsheet returns title and tabs', async () => {
      sheetsSync._setSheetsClient(sheets.client);
      const r = await sheetsSync.verifySpreadsheet();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.title, 'Декларации');
      assert.deepStrictEqual(r.tabs, ['Декларации']);
    });

    await test('readStatusCell reads the current (lowercase) sheet value', async () => {
      const v = await sheetsSync.readStatusCell('Декларации', '5');
      assert.strictEqual(v, 'на согласовании');
    });

    await test('confirming an already-decided detection is rejected', async () => {
      await assert.rejects(() => svc.confirmDetection(res.detection._id, 'tester'),
        /already confirmed/);
    });

    // ── Original received → reject path ──
    const order2 = await Order.create({ status: 'Ждем оригинал' });
    const origMsg = buildMessage({
      id: 'm-original',
      from: LAB,
      subject: 'Декларация готова',
      bodyText: 'ДС во вложении',
      attachments: ['декларация.pdf'],
    });

    await test('original detection → transition to "Оригинал получен"', async () => {
      const r = await svc.detectFromMessage(order2._id, 'thread-2', origMsg);
      assert.strictEqual(r.detection.detected_event, 'ORIGINAL_RECEIVED');
      assert.strictEqual(r.detection.recommended_to, 'Оригинал получен');
      order2._lastDetection = r.detection._id;
    });

    await test('rejectDetection marks rejected and leaves order untouched', async () => {
      const det = await WorkflowDetection.findOne({ thread_id: 'thread-2' });
      await svc.rejectDetection(det._id, 'tester');
      const after = await WorkflowDetection.findById(det._id).lean();
      assert.strictEqual(after.status, 'rejected');
      const o = await Order.findById(order2._id).lean();
      assert.strictEqual(o.status, 'Ждем оригинал'); // unchanged
      assert.ok(o.events.some(e => e.type === 'WORKFLOW_EVENT_REJECTED'));
    });

    // ── needs_review: detection in wrong precondition cannot be auto-applied ──
    const order3 = await Order.create({ status: 'Завершен' });
    await test('needs_review detection cannot be confirmed', async () => {
      const r = await svc.detectFromMessage(order3._id, 'thread-3', buildMessage({
        id: 'm-nr', from: LAB, subject: 'макет', bodyText: 'макет во вложении',
      }));
      assert.strictEqual(r.detection.recommendation, 'needs_review');
      await assert.rejects(() => svc.confirmDetection(r.detection._id, 'tester'),
        /cannot be auto-applied/);
    });

    // ── sender gate ──
    await test('non-lab sender is skipped (no detection)', async () => {
      const r = await svc.detectFromMessage(order2._id, 'thread-x', buildMessage({
        id: 'm-x', from: 'client@gmail.com', subject: 'макет', bodyText: 'макет',
      }));
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(r.reason, 'sender_not_known_lab');
    });

    // ── Sheets write-back: direct unit coverage ──
    await test('writeDeclarationRow skips a record with no sheet row', async () => {
      const manual = await Declaration.create({ order_id: order3._id, source: 'manual', status: 'Запустить' });
      const r = await sheetsSync.writeDeclarationRow(manual._id);
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(r.reason, 'no_sheet_row');
    });

    await test('writeDeclarationRow marks error on API failure (stays retryable)', async () => {
      const o = await Order.create({ status: 'Ждем оригинал' });
      await Declaration.create({ order_id: o._id, source: 'google_sheets', sheet_row_id: '9', status: 'Ждем оригинал', sync_status: 'pending' });
      const failing = makeSheetsMock();
      failing.client.spreadsheets.values.update = async () => { throw new Error('429 rate limited'); };
      sheetsSync._setSheetsClient(failing.client);

      const d = await Declaration.findOne({ sheet_row_id: '9' });
      const r = await sheetsSync.writeDeclarationRow(d._id);
      assert.strictEqual(r.written, false);
      const after = await Declaration.findById(d._id).lean();
      assert.strictEqual(after.sync_status, 'error');
    });

    await test('writeDeclarationRow flags verify mismatch (read-back differs)', async () => {
      const o = await Order.create({ status: 'Ждем оригинал' });
      const d = await Declaration.create({ order_id: o._id, source: 'google_sheets', sheet_row_id: '15', status: 'Ждем оригинал', sync_status: 'pending' });
      const mism = makeSheetsMock();
      // Write succeeds but read-back returns a different value.
      mism.client.spreadsheets.values.get = async () => ({ data: { values: [['SOMETHING ELSE']] } });
      sheetsSync._setSheetsClient(mism.client);

      const r = await sheetsSync.writeDeclarationRow(d._id);
      assert.strictEqual(r.written, true);
      assert.strictEqual(r.verified, false);
      assert.strictEqual(r.sheetValue, 'SOMETHING ELSE');
      const after = await Declaration.findById(d._id).lean();
      assert.strictEqual(after.sync_status, 'error');
    });

    await test('verify tolerates sheet padding/case (normalized compare)', async () => {
      const o = await Order.create({ status: 'Оригинал получен' });
      const d = await Declaration.create({ order_id: o._id, source: 'google_sheets', sheet_row_id: '20', status: 'Оригинал получен', sync_status: 'pending' });
      const padded = makeSheetsMock();
      // Sheet returns the value padded and mixed-case; normalization should match.
      padded.client.spreadsheets.values.get = async () => ({ data: { values: [['   Оригинал Получен  ']] } });
      sheetsSync._setSheetsClient(padded.client);

      const r = await sheetsSync.writeDeclarationRow(d._id);
      assert.strictEqual(r.written, true);
      assert.strictEqual(r.verified, true);
      assert.strictEqual(r.status, 'оригинал получен'); // wrote lowercase
      const after = await Declaration.findById(d._id).lean();
      assert.strictEqual(after.sync_status, 'synced');
    });

    await test('retryPendingDeclarations re-writes pending and errored rows', async () => {
      const good = makeSheetsMock();
      sheetsSync._setSheetsClient(good.client);
      const o2 = await Order.create({ status: 'Оригинал получен' });
      await Declaration.create({ order_id: o2._id, source: 'google_sheets', sheet_row_id: '12', status: 'Оригинал получен', sync_status: 'pending' });

      const r = await sheetsSync.retryPendingDeclarations();
      assert.ok(r.written >= 2, `expected >=2 writes, got ${r.written}`);
      // Row 9 (errored earlier) and row 12 (pending) both written and now synced.
      assert.ok(good.calls.update.some(c => c.range === `'Декларации'!G9`));
      assert.ok(good.calls.update.some(c => c.range === `'Декларации'!G12`));
      const d9  = await Declaration.findOne({ sheet_row_id: '9' }).lean();
      const d12 = await Declaration.findOne({ sheet_row_id: '12' }).lean();
      assert.strictEqual(d9.sync_status, 'synced');
      assert.strictEqual(d12.sync_status, 'synced');
    });

    await test('statusRange quotes non-ASCII sheet names', () => {
      assert.strictEqual(sheetsSync.statusRange('Декларации', '5'), `'Декларации'!G5`);
      assert.strictEqual(sheetsSync.statusRange('Sheet1', '7'), 'Sheet1!G7');
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
