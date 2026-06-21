'use strict';

// Tests for leadIntentService — language / intent / service-category classification.
// Run: node tests/lead-intent.test.js

const assert = require('assert');
const li = require('../src/services/leadIntentService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

console.log('\n[language]');
test('Cyrillic → ru', () => assert.strictEqual(li.detectLanguage('здравствуйте, сколько стоит'), 'ru'));
test('Kyrgyz letters/words → ky', () => assert.strictEqual(li.detectLanguage('Саламатсызбы, канча турат?'), 'ky'));
test('Latin → en', () => assert.strictEqual(li.detectLanguage('hello, how much for a certificate'), 'en'));
test('empty → unknown', () => assert.strictEqual(li.detectLanguage('   '), 'unknown'));

console.log('\n[service category]');
test('certificate', () => assert.strictEqual(li.detectServiceCategory('нужен сертификат на одежду'), 'certificate'));
test('declaration', () => assert.strictEqual(li.detectServiceCategory('сколько стоит декларация'), 'declaration'));
test('refusal letter', () => assert.strictEqual(li.detectServiceCategory('нужно отказное письмо'), 'refusal_letter'));
test('sgr', () => assert.strictEqual(li.detectServiceCategory('нужен СГР'), 'sgr'));
test('mpstats (branded, beats generic)', () => assert.strictEqual(li.detectServiceCategory('подключить mpstats'), 'mpstats'));
test('wildbox', () => assert.strictEqual(li.detectServiceCategory('хочу вайлдбокс'), 'wildbox'));
test('unknown', () => assert.strictEqual(li.detectServiceCategory('добрый день'), 'unknown'));

console.log('\n[intent]');
test('greeting', () => assert.strictEqual(li.detectIntent('Здравствуйте'), 'greeting'));
test('price question', () => assert.strictEqual(li.detectIntent('сколько стоит сертификат?'), 'price_question'));
test('price question (ky)', () => assert.strictEqual(li.detectIntent('канча турат?'), 'price_question'));
test('payment made', () => assert.strictEqual(li.detectIntent('я оплатил 15000 сом'), 'payment_made'));
test('application help', () => assert.strictEqual(li.detectIntent('как заполнить заявку'), 'application_help'));
test('identify self (entity)', () => assert.strictEqual(li.detectIntent('это осоо bacci'), 'identify_self'));
test('unknown', () => assert.strictEqual(li.detectIntent('asdf qwer'), 'unknown'));

console.log('\n[classify confidence]');
test('intent + service → HIGH', () => {
  const r = li.classify('сколько стоит декларация?');
  assert.strictEqual(r.intent, 'price_question');
  assert.strictEqual(r.service_category, 'declaration');
  assert.strictEqual(r.confidence, 'HIGH');
});
test('greeting only → LOW', () => assert.strictEqual(li.classify('привет').confidence, 'LOW'));
test('intent without a service category → MEDIUM', () => assert.strictEqual(li.classify('сколько стоит?').confidence, 'MEDIUM'));
test('nothing → NONE', () => assert.strictEqual(li.classify('xyz 123').confidence, 'NONE'));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
