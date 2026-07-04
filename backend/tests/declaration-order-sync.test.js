'use strict';

// Tests for declarationOrderService.sync() — materialize Orders from «Декларация» into Mongo.
// No real DB: a fake Order model records updateOne() calls; the sheet reader and labRecipients
// are injected. Verifies idempotency shape ($set status/sheet_row_id, $setOnInsert client/lab),
// СС routing (Бермет), ДС-without-цех gating (no lab email), status filtering, and the limit.
//
// Run: node tests/declaration-order-sync.test.js

const assert = require('assert');
const svc = require('../src/services/declarationOrderService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return fn().then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

// Header covers the columns detectColumns() looks for (substring match, case-insensitive).
const HEADER = ['Дата создания', 'Клиент', 'Документ', 'Сумма', 'Слой', 'Номер тел.', 'Исполнитель', 'Статус'];
//               0                1         2           3        4       5             6              7
function row({ client, doc, amount = '', phone = '', status }) {
  return ['01.01.2026', client, doc, amount, 'ткань', phone, 'Оператор', status];
}

// Fake Order: records every updateOne; returns upsertedCount:1 (treat all as new).
function fakeOrder() {
  const calls = [];
  return {
    calls,
    updateOne: async (filter, update, opts) => { calls.push({ filter, update, opts }); return { upsertedCount: 1, matchedCount: 0 }; },
  };
}

const readRows = (rows) => async () => ({ header: HEADER, rows });

(async () => {
  console.log('\n[sync]');

  await test('СС «Запустить» → order upserted with Бермет lab email; $set carries status+row', async () => {
    const Order = fakeOrder();
    const s = await svc.sync({}, { Order, readDeclarationRows: readRows([row({ client: 'ОсОО Ромашка', doc: 'Сертификат СС', status: 'Запустить', phone: '996700112233' })]) });
    assert.strictEqual(s.created, 1);
    assert.strictEqual(Order.calls.length, 1);
    const { filter, update } = Order.calls[0];
    assert.deepStrictEqual(filter, { sheet_row_id: '2' });
    assert.strictEqual(update.$set.status, 'Запустить');
    assert.strictEqual(update.$set.sheet_row_id, '2');
    assert.strictEqual(update.$setOnInsert.client.name, 'ОсОО Ромашка');
    assert.strictEqual(update.$setOnInsert.client.phone, '996700112233');
    assert.ok(update.$setOnInsert.laboratory.laboratoryEmail, 'СС must route to a lab email');
  });

  await test('ДС without цех-docs → order upserted but NO lab email (gated); ds_no_route counted', async () => {
    const Order = fakeOrder();
    const s = await svc.sync({}, { Order, readDeclarationRows: readRows([row({ client: 'ИП Иванов', doc: 'Декларация ДС', status: 'Запустить' })]) });
    assert.strictEqual(s.created, 1);
    assert.strictEqual(s.ds_no_route, 1);
    assert.strictEqual(Order.calls[0].update.$setOnInsert.laboratory, undefined, 'ДС must NOT be auto-routed to a lab');
  });

  await test('non-actionable status is skipped (no upsert)', async () => {
    const Order = fakeOrder();
    const s = await svc.sync({}, { Order, readDeclarationRows: readRows([
      row({ client: 'ОсОО Завершёнка', doc: 'СС', status: 'Завершен' }),
      row({ client: 'ОсОО Актив', doc: 'СС', status: 'Ждем макет' }),
    ]) });
    assert.strictEqual(s.upserted, 1, 'only the actionable «Ждем макет» row');
    assert.strictEqual(s.skipped, 1);
    assert.strictEqual(Order.calls.length, 1);
    assert.strictEqual(Order.calls[0].update.$set.status, 'Ждем макет');
  });

  await test('limit caps upserts per run', async () => {
    const Order = fakeOrder();
    const rows = [1, 2, 3].map(n => row({ client: 'ОсОО ' + n, doc: 'СС', status: 'Запустить' }));
    const s = await svc.sync({ limit: 2 }, { Order, readDeclarationRows: readRows(rows) });
    assert.strictEqual(s.upserted, 2);
    assert.strictEqual(Order.calls.length, 2);
  });

  await test('garbage/empty rows produce no upsert', async () => {
    const Order = fakeOrder();
    const s = await svc.sync({}, { Order, readDeclarationRows: readRows([['', '', '', '', '', '', '', '']]) });
    assert.strictEqual(s.upserted, 0);
    assert.strictEqual(Order.calls.length, 0);
  });

  console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of failures) console.error(`\n✗ ${f.name}\n${f.err.stack}`); process.exit(1); }
})();
