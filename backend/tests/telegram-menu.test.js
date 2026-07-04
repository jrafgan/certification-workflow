'use strict';

// Tests for services/telegramMenuService — the Telegram bot command menu.
// Pure parseCommand + answerFor (prices sourced from config/pricing.js). No I/O.
// Run: node tests/telegram-menu.test.js

const assert = require('assert');
const menu = require('../src/services/telegramMenuService');
const { PRICING } = require('../src/config/pricing');
const { fmt } = require('../src/services/leadReplyTemplates');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const DS = PRICING['ДС'], SS = PRICING['СС'];

test('parseCommand recognizes menu commands, strips @mention + case', () => {
  assert.strictEqual(menu.parseCommand('/ceny'), 'ceny');
  assert.strictEqual(menu.parseCommand('/Ceny@certificationworkflowbot'), 'ceny');
  assert.strictEqual(menu.parseCommand('  /uslugi '), 'uslugi');
  assert.strictEqual(menu.parseCommand('/start'), 'start');
});

test('parseCommand returns null for non-menu / plain text', () => {
  assert.strictEqual(menu.parseCommand('сколько стоит сертификат?'), null);
  assert.strictEqual(menu.parseCommand('/unknown'), null);
  assert.strictEqual(menu.parseCommand(''), null);
});

test('ceny answer quotes CURRENT prices from pricing.js (not stale)', () => {
  const t = menu.answerFor('ceny');
  assert.ok(t.includes(fmt(DS.variants.with_workshop.base)));      // 17 000
  assert.ok(t.includes(fmt(DS.variants.no_workshop.base)));        // 18 000
  assert.ok(t.includes(fmt(SS.base)));                             // 35 000
  assert.ok(t.includes(fmt(SS.foreign_legal_entity.base)));        // 50 000
  assert.ok(t.includes(fmt(DS.additional_pi)));                    // 10 000
  assert.ok(/подтвердит специалист/.test(t));                      // never a final price
});

test('uslugi lists the document types', () => {
  const t = menu.answerFor('uslugi');
  assert.ok(/Декларация/.test(t) && /Сертификат/.test(t) && /Отказное/.test(t) && /СГР/.test(t));
});

test('zayavka uses the configured application link', () => {
  const t = menu.answerFor('zayavka', { application_form_url: 'https://forms.example/apply' });
  assert.ok(t.includes('https://forms.example/apply'));
});

test('start greets and lists the commands', () => {
  const t = menu.answerFor('start');
  assert.ok(/dokumenty\.pro/i.test(t) && /\/ceny/.test(t) && /\/zayavka/.test(t));
});

test('answerFor returns null for a non-menu command', () => {
  assert.strictEqual(menu.answerFor('nope'), null);
});

test('autoReplyEnabled defaults true, false only when explicitly disabled', () => {
  const saved = process.env.TELEGRAM_MENU_AUTOREPLY;
  delete process.env.TELEGRAM_MENU_AUTOREPLY;
  assert.strictEqual(menu.autoReplyEnabled(), true);
  process.env.TELEGRAM_MENU_AUTOREPLY = 'false';
  assert.strictEqual(menu.autoReplyEnabled(), false);
  process.env.TELEGRAM_MENU_AUTOREPLY = 'true';
  assert.strictEqual(menu.autoReplyEnabled(), true);
  if (saved === undefined) delete process.env.TELEGRAM_MENU_AUTOREPLY; else process.env.TELEGRAM_MENU_AUTOREPLY = saved;
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
