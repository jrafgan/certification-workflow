'use strict';

// Tests for the client entity (services/clientEntityService) — stage/actor (pure) +
// buildByPhone aggregation with injected sources. No live network. Run: node tests/client-entity.test.js

const assert = require('assert');
const ce = require('../src/services/clientEntityService');
const { matchKey } = require('../src/utils/phoneUtils');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

(async () => {
  console.log('\n[stage + next actor — who must act]');
  await test('завершен → done, no actor', () => { assert.strictEqual(ce.stageFor('завершен'), 'done'); assert.strictEqual(ce.nextActorFor('завершен'), null); });
  await test('empty/«запустить» → intake → operator', () => { assert.strictEqual(ce.nextActorFor(''), 'operator'); assert.strictEqual(ce.nextActorFor('Запустить'), 'operator'); });
  await test('«ждем макет» → lab', () => { assert.strictEqual(ce.nextActorFor('Ждем макет'), 'lab'); });
  await test('«на согласовании» → client', () => { assert.strictEqual(ce.nextActorFor('На согласовании'), 'client'); });
  await test('«ждем оригинал» → lab', () => { assert.strictEqual(ce.nextActorFor('ждем оригинал'), 'lab'); });

  console.log('\n[buildByPhone — entity by phone]');
  // «Декларация»: J=9 phone, N=13 status, D=3 client.
  const DR = (phone, client, status) => { const r = new Array(14).fill(''); r[9] = phone; r[3] = client; r[13] = status; return r; };
  const readDeclaration = async () => [
    DR('+996700111222', 'ОсОО Мегуми', 'ждем оригинал'),
    DR('+996700111222', 'ОсОО Мегуми', 'завершен'),
    DR('+996700999999', 'Другой', 'завершен'),
  ];
  const readRows = async () => ({ header: [], rows: [] });
  const resolveEntity = async () => ({ legal_entity: 'ОсОО Мегуми' });

  await test('aggregates Declaration orders for the phone (J), resolves entity', async () => {
    const e = await ce.buildByPhone('+996700111222', { readDeclaration, readRows, resolveEntity });
    assert.strictEqual(e.found, true);
    assert.strictEqual(e.legal_entity, 'ОсОО Мегуми');
    assert.strictEqual(e.entity_confirmed, true);
    assert.strictEqual(e.orders.length, 2);                 // only this phone's rows
    assert.strictEqual(e.active_count, 1);                  // one «ждем оригинал», one «завершен»
    assert.strictEqual(e.alive, true);
    const active = e.orders.find(o => o.stage !== 'done');
    assert.strictEqual(active.next_actor, 'lab');           // ждём оригинал → лаборатория
  });

  await test('phone only in «Новая форма» (no Declaration) → new application, alive', async () => {
    const HEADER = ['А', 'ватсап', 'Ваше юр. лицо ?', 'название вашего юр. лица или организации ?', 'страна', 'адрес', 'Ваш номер телефона ?', 'e mail', 'инн', 'произв', 'страна пр', 'адрес пр', 'магазин', 'бренд', 'детский или взрослый', 'товары', 'состав', 'тнвэд'];
    const ROW = ['t', '+996555000111', 'ИП', 'Новиков', 'КР', 'адрес', '+996555000111', 'a@b.kg', '123', '', '', '', '', 'Brand', 'Взрослая', 'Футболка 6109100000', '', ''];
    const e = await ce.buildByPhone('+996555000111', {
      readDeclaration: async () => [],
      readRows: async () => ({ header: HEADER, rows: [ROW] }),
      resolveEntity: async () => null,
    });
    assert.strictEqual(e.is_new_application, true);
    assert.strictEqual(e.in_declaration, false);
    assert.ok(e.application && e.application.name === 'Новиков');
    assert.strictEqual(e.entity_confirmed, false);
    assert.ok(/WhatsApp/.test(e.whatsapp_pending.certificate));   // cert/receipt pending channel
  });

  await test('bad phone → not found', async () => {
    const e = await ce.buildByPhone('abc', {});
    assert.strictEqual(e.found, false);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
