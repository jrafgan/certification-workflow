'use strict';

// Tests for the client-card assembly:
//   • conversationSummary — rule-based RU summary of a WhatsApp thread (PURE).
//   • applicationCardByPhone — New-Form fields for a phone, multi-match aware (stubbed rows/mapper).
//
// Run: node tests/client-card.test.js

const assert = require('assert');
const svc = require('../src/services/taskInboxService');

let pass = 0, fail = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const DAY = 86400000;
const NOW = Date.parse('2026-07-05T12:00:00Z');

// ── conversationSummary ──
test('summary: empty → «переписки нет»', () => {
  assert.ok(/переписки.*нет/i.test(svc.conversationSummary([], { now: NOW })));
});
test('summary: we sent a quote, client silent → ждёт + no reply after us', () => {
  const msgs = [
    { direction: 'inbound', body: 'сколько стоит?', at: NOW - 12 * DAY },
    { direction: 'outbound', body: 'стоимость оформления декларации 17000 сом', at: NOW - 12 * DAY },
  ];
  const s = svc.conversationSummary(msgs, { now: NOW });
  assert.ok(/12 дн/.test(s));
  assert.ok(/стоимость/i.test(s));
  assert.ok(/ответа после нашего/i.test(s));
});
test('summary: client wrote last → ждёт нашего ответа', () => {
  const s = svc.conversationSummary([{ direction: 'inbound', body: 'привет', at: NOW - DAY }], { now: NOW });
  assert.ok(/ждёт нашего ответа/i.test(s));
});
test('summary: client refused → пометка отказа', () => {
  const s = svc.conversationSummary([{ direction: 'inbound', body: 'передумали, не будем', at: NOW }], { now: NOW });
  assert.ok(/отказ/i.test(s));
});

// ── applicationCardByPhone (stubbed rows + real formFieldMapper) ──
function stub(rows, header) {
  return { readRows: async () => ({ header, rows }), mapper: require('../src/services/formFieldMapper') };
}
// Real New Form headers (must match formFieldMapper FIELD_SYNONYMS: APPLICANT_L_E_NAME→col3,
// LEGAL_ENTITY→col2, MANUFACTURER_L_E_NAME→col9, MANUFACTURER_COUNTRY→col10, TNVED→col15).
const HEADER = ['А', 'ваш номер ватсап', 'Ваше юр. лицо ?', 'название вашего юр. лица или организации ?',
  'Страна регистрации вашего юр лица', 'юридический адрес', 'номер телефона', 'ваш e mail',
  'ОГРН БИН ИИН ИНН', 'Название юр. лица производителя', 'Страна производства товара',
  'адрес производства', 'название магазина', 'наименование бренда', 'товар детский или взрослый',
  'список ваших товаров - состав - тнвэд'];

test('card: finds the application by phone, maps fields', async () => {
  const rows = [[
    '10.01.2026 13:09:36', '+996700111222', 'ИП', 'Умарова Виктория Сергеевна', 'Кыргызстан',
    'адрес', '', 'u@mail.com', '12345', 'ИП Юсупова Ольга', 'Кыргызстан', '', 'Shop', 'Brand',
    'взрослый', 'Блузка - полиэстер 100% - 6206400000',
  ]];
  const r = await svc.applicationCardByPhone('+996700111222', stub(rows, HEADER));
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.card.entity_type, 'ИП');
  assert.strictEqual(r.card.company_name, 'Умарова Виктория Сергеевна');
  assert.strictEqual(r.card.producer, 'ИП Юсупова Ольга');
  assert.strictEqual(r.card.production_country, 'Кыргызстан');
  assert.ok(/6206400000/.test(r.card.tnved || r.card.goods || ''));
});
test('card: no match → found:false', async () => {
  const rows = [['10.01.2026', '+996700999888', 'ИП', 'Кто-то', 'KG', '', '', '', '', '', '', '', '', '', '', '']];
  const r = await svc.applicationCardByPhone('+996700111222', stub(rows, HEADER));
  assert.strictEqual(r.found, false);
});
test('card: multiple rows same phone → match_count>1, newest wins', async () => {
  const rows = [
    ['01.01.2026 10:00:00', '+996700111222', 'ИП', 'Старая заявка', 'KG', '', '', '', '', '', '', '', '', '', '', ''],
    ['05.02.2026 10:00:00', '+996700111222', 'ИП', 'Новая заявка', 'KG', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const r = await svc.applicationCardByPhone('+996700111222', stub(rows, HEADER));
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.match_count, 2);
  assert.strictEqual(r.card.company_name, 'Новая заявка');   // newest by submitted_at
});

(async () => {
  console.log('\n[client-card]');
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  console.log(`\n${fail ? '✗' : '✓'} client-card: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
