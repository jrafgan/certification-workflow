'use strict';

// Tests for audio transcription (services/audioTranscriptionService) + voice-aware payment
// analysis. The OpenAI HTTP call is MOCKED (deps.fetch) — no real API call, no key needed.
// Run: node tests/audio-transcription.test.js

const assert = require('assert');
const ats = require('../src/services/audioTranscriptionService');
const pr  = require('../src/services/paymentReconciliationService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  PASS  ${name}`); })
    .catch((err) => { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

// A fake fetch that mimics the OpenAI transcription response.
function fakeFetch(text) {
  return async (_url, _opts) => ({ ok: true, json: async () => ({ text }) });
}

const ORIG_KEY = process.env.OPENAI_API_KEY;

(async () => {
  console.log('\n[transcribe — gated on OPENAI_API_KEY]');
  await test('no key → ok:false reason no_api_key (never crashes)', async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await ats.transcribe({ buffer: Buffer.from('x') }, { fetch: fakeFetch('hi') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_api_key');
  });

  await test('with key + mocked API → returns text', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const r = await ats.transcribe({ buffer: Buffer.from('audio') }, { fetch: fakeFetch('Стоимость 35000 сом') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'Стоимость 35000 сом');
  });

  await test('empty audio → ok:false', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const r = await ats.transcribe({ buffer: Buffer.alloc(0) }, { fetch: fakeFetch('x') });
    assert.strictEqual(r.ok, false);
  });

  console.log('\n[voice message → payment analysis (audio merged into body)]');
  await test('voice note transcribed → agreed total from audio feeds debt math', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const messages = [
      // operator quote arrives as a VOICE message (no text body)
      { direction: 'out', body: '', attachments: [{ file_name: 'voice.ogg', mime_type: 'audio/ogg', media_ref: 'm1' }] },
      { direction: 'in',  body: 'перевёл 20000 сом' },
    ];
    const deps = {
      fetch: fakeFetch('Полная стоимость 35000 сом'),
      readAudio: async () => Buffer.from('fake-audio-bytes'),
    };
    const a = await pr.analyzeConversationWithAudio(messages, deps);
    assert.strictEqual(a.agreed_total, 35000);   // from the transcribed voice note
    assert.strictEqual(a.total_paid, 20000);
    assert.strictEqual(a.debt, 15000);
    assert.strictEqual(a.status, 'частично оплачено');
  });

  await test('no transcriber/key → falls back to text only (no crash)', async () => {
    delete process.env.OPENAI_API_KEY;
    const messages = [
      { direction: 'out', body: 'Итого 30000 сом' },
      { direction: 'in',  body: 'оплатил 30000 сом' },
    ];
    const a = await pr.analyzeConversationWithAudio(messages, { readAudio: async () => Buffer.from('x') });
    assert.strictEqual(a.agreed_total, 30000);
    assert.strictEqual(a.fully_paid, true);
  });

  if (ORIG_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = ORIG_KEY;
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
  process.exit(0);
})();
