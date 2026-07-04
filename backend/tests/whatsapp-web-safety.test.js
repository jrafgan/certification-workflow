'use strict';

// Tests for services/whatsappWebSafety — the whatsapp-web.js anti-ban safety layer.
// Pure checkRate/pacingDelay + gate with an injected WhatsAppMessage model. No real network.
// Run: node tests/whatsapp-web-safety.test.js

const assert = require('assert');
const safety = require('../src/services/whatsappWebSafety');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

const ENV = { ...process.env };
function restore() { process.env = { ...ENV }; safety._resetState(); }

// Fake model: openKeys = phone_keys that have a recent inbound (open conversation).
function fakeWA(openKeys = []) { return { exists: async (q) => openKeys.includes(q.phone_key) }; }

(async () => {
  console.log('\n[pacingDelay + checkRate — pure]');
  await test('pacingDelay within [min,max]', () => {
    const c = safety.cfg();
    const d = safety.pacingDelay(c, () => 0.5);
    assert.ok(d >= c.minDelayMs && d <= c.maxDelayMs);
    restore();
  });
  await test('checkRate blocks under min gap, allows after', () => {
    const c = safety.cfg();
    const now = 1_000_000_000_000;
    assert.strictEqual(safety.checkRate([now - 1000], now, c, now - 1000).allowed, false); // 1s < min gap
    assert.strictEqual(safety.checkRate([now - 60000], now, c, now - 60000).allowed, true); // 60s gap ok
    restore();
  });
  await test('checkRate enforces daily cap', () => {
    process.env.SAFE_MAX_PER_DAY = '3';
    const c = safety.cfg();
    const now = 2_000_000_000_000;
    const sends = [now - 10, now - 20, now - 30]; // 3 today
    assert.strictEqual(safety.checkRate(sends, now, c, 0).reason, 'daily_cap');
    restore();
  });

  console.log('\n[gate — reactive vs cold]');
  await test('reactive reply (open conversation) → allowed', async () => {
    safety._resetState();
    const g = await safety.gate({ to: '996700111222', body: 'спасибо!' }, { WhatsAppMessage: fakeWA(['700111222']), now: Date.now(), rnd: () => 0.3 });
    assert.strictEqual(g.allow, true);
    assert.strictEqual(g.cold, false);
    assert.ok(g.delayMs >= 4000);
    restore();
  });
  await test('cold send → allowed but flagged cold, with extra spacing', async () => {
    safety._resetState();
    const g = await safety.gate({ to: '996700999888', body: 'здравствуйте' }, { WhatsAppMessage: fakeWA([]), now: Date.now(), rnd: () => 0 });
    assert.strictEqual(g.allow, true);
    assert.strictEqual(g.cold, true);
    assert.ok(g.delayMs >= 4000 * 3 - 1); // coldDelayMult applied
    restore();
  });
  await test('reactiveOnly=true → cold blocked', async () => {
    process.env.SAFE_REACTIVE_ONLY = 'true';
    safety._resetState();
    const g = await safety.gate({ to: '996700999888', body: 'hi' }, { WhatsAppMessage: fakeWA([]), now: Date.now() });
    assert.strictEqual(g.allow, false);
    assert.strictEqual(g.reason, 'no_open_conversation');
    restore();
  });
  await test('cold daily cap → blocked after N cold sends', async () => {
    process.env.SAFE_COLD_MAX_PER_DAY = '2';
    process.env.SAFE_MIN_DELAY_MS = '0';
    safety._resetState();
    const now = Date.now();
    const deps = { WhatsAppMessage: fakeWA([]), now };
    // record 2 cold sends → 3rd blocked
    safety.recordSend('996700000001', 'a', { cold: true, now });
    safety.recordSend('996700000002', 'b', { cold: true, now });
    const g = await safety.gate({ to: '996700000003', body: 'c' }, deps);
    assert.strictEqual(g.allow, false);
    assert.strictEqual(g.reason, 'cold_daily_cap');
    restore();
  });
  await test('bulk identical fan-out → blocked', async () => {
    process.env.SAFE_DUP_FANOUT = '2';
    process.env.SAFE_MIN_DELAY_MS = '0';
    process.env.SAFE_REACTIVE_ONLY = 'false';
    safety._resetState();
    const now = Date.now();
    const wa = fakeWA(['700000001', '700000002', '700000003']); // all "open" so only dup-rule fires
    safety.recordSend('996700000001', 'СКИДКА 50%', { now });
    safety.recordSend('996700000002', 'СКИДКА 50%', { now });
    const g = await safety.gate({ to: '996700000003', body: 'СКИДКА 50%' }, { WhatsAppMessage: wa, now });
    assert.strictEqual(g.allow, false);
    assert.strictEqual(g.reason, 'bulk_identical_blocked');
    restore();
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
