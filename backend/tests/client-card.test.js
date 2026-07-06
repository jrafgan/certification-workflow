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
  assert.strictEqual(r.selected_row, r.card.sheet_row);
  assert.strictEqual(r.matches.length, 2);
});
test('card: operator picks an older row → that row is rendered', async () => {
  const rows = [
    ['01.01.2026 10:00:00', '+996700111222', 'ИП', 'Старая заявка', 'KG', '', '', '', '', '', '', '', '', '', '', ''],
    ['05.02.2026 10:00:00', '+996700111222', 'ИП', 'Новая заявка', 'KG', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const deps = { ...stub(rows, HEADER), sheet_row: 2 };        // row 2 = the older «Старая заявка»
  const r = await svc.applicationCardByPhone('+996700111222', deps);
  assert.strictEqual(r.card.company_name, 'Старая заявка');
  assert.strictEqual(r.selected_row, 2);
});
test('card: picking a non-existent row → falls back to newest', async () => {
  const rows = [['05.02.2026 10:00:00', '+996700111222', 'ИП', 'Новая заявка', 'KG', '', '', '', '', '', '', '', '', '', '', '']];
  const r = await svc.applicationCardByPhone('+996700111222', { ...stub(rows, HEADER), sheet_row: 999 });
  assert.strictEqual(r.card.company_name, 'Новая заявка');
});

// ── clientEmails: match «Декларация» client NAME × email SUBJECT (no lab-based high, no body-scan) ──
const LAB = {
  SS:               { email: 'mng-1@kyrgyz-test.kg' },
  DS_NO_WORKSHOP:   { email: 'svnsert7@gmail.com' },
  DS_WITH_WORKSHOP: { email: 'servisstan@internet.ru' },
};
function emailDeps(threads) {
  return { labRecipients: LAB, gmail: { searchThreads: async (q, cap) => threads.slice(0, cap) } };
}
// clientEmails builds the entity via clientEntityService.buildByPhone — stub that through require cache.
function withEntity(entity, fn) {
  const path = require.resolve('../src/services/clientEntityService');
  const orig = require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports: { buildByPhone: async () => entity } };
  return Promise.resolve(fn()).finally(() => { if (orig) require.cache[path] = orig; else delete require.cache[path]; });
}
const LAUNCHED_ENT = {
  found: true, in_declaration: true, legal_entity: 'ИП Умарова',
  orders: [{ client: 'ИП Умарова', status: 'Запущен' }],
};

test('emails: gate — client not in Declaration → not searched', async () => {
  const r = await withEntity({ found: true, in_declaration: false }, () =>
    svc.clientEmails('+996700111222', emailDeps([])));
  assert.strictEqual(r.found, false);
  assert.ok(/Деклара/i.test(r.reason));
});
test('emails: gate — order still «Запустить» → not sent to lab yet', async () => {
  const r = await withEntity(
    { found: true, in_declaration: true, legal_entity: 'ИП Умарова', orders: [{ client: 'ИП Умарова', status: 'Запустить' }] },
    () => svc.clientEmails('+996700111222', emailDeps([])));
  assert.strictEqual(r.found, false);
  assert.ok(/Запустить/.test(r.reason));
});
test('emails: specific Declaration name in subject → high', async () => {
  const threads = [{ threadId: 't1', subject: 'ИП Умарова декларация', from: 'Айгерим <svnsert7@gmail.com>', to: 'me', date: new Date('2026-07-01') }];
  const r = await withEntity(LAUNCHED_ENT, () => svc.clientEmails('+996700111222', emailDeps(threads)));
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.emails[0].confidence, 'high');
  assert.ok(r.emails[0].signals.includes('имя в теме'));
  assert.ok(r.emails[0].signals.includes('от лаборатории'));   // info tag only (does not drive confidence)
});
test('emails: subject without the client name → dropped (not this client\'s letter)', async () => {
  const threads = [{ threadId: 't2', subject: 'общий вопрос по оплате', from: 'me', to: 'servisstan@internet.ru', date: new Date('2026-06-20') }];
  const r = await withEntity(LAUNCHED_ENT, () => svc.clientEmails('+996700111222', emailDeps(threads)));
  assert.strictEqual(r.found, false);                           // адрес лаборатории есть, но имени в теме нет → не матч
});
test('emails: short/generic name in subject → medium (never auto-high)', async () => {
  const ent = { found: true, in_declaration: true, legal_entity: 'AMIR', orders: [{ client: 'AMIR', status: 'Запущен' }] };
  const threads = [{ threadId: 't3', subject: 'AMIR order update', from: 'x@y.z', to: 'me', date: new Date('2026-06-10') }];
  const r = await withEntity(ent, () => svc.clientEmails('+996700111222', emailDeps(threads)));
  assert.strictEqual(r.emails[0].confidence, 'medium');
});
test('emails: client name only in BODY, not subject → NOT matched (kills webinar false positives)', async () => {
  const threads = [{ threadId: 't4', subject: 'Explore AI Innovations: Agents 2.0 Webinar', from: 'news@promo.co', to: 'me', date: new Date('2026-07-05') }];
  const r = await withEntity(LAUNCHED_ENT, () => svc.clientEmails('+996700111222', emailDeps(threads)));
  assert.strictEqual(r.found, false);                           // тело не читаем → имя в теле не даёт ложный матч
});
test('emails: high (specific) ranks before medium (short)', async () => {
  const ent = { found: true, in_declaration: true, legal_entity: 'ИП Умарова', orders: [{ client: 'ИП Умарова', status: 'З' }, { client: 'AMIR', status: 'З' }] };
  const threads = [
    { threadId: 'short', subject: 'AMIR', from: 'x@y.z', to: 'me', date: new Date('2026-07-05') },
    { threadId: 'full',  subject: 'ИП Умарова оригинал', from: 'mng-1@kyrgyz-test.kg', to: 'me', date: new Date('2026-06-01') },
  ];
  const r = await withEntity(ent, () => svc.clientEmails('+996700111222', emailDeps(threads)));
  assert.strictEqual(r.emails[0].thread_id, 'full');            // high before medium despite older date
  assert.strictEqual(r.emails[0].confidence, 'high');
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
