'use strict';

// services/audioTranscriptionService.js — speech-to-text for WhatsApp voice messages via OpenAI.
//
// Transcribes audio (голосовые) to text so the rest of the pipeline (payment reconciliation,
// conversation understanding) can read voice messages, not just text. Uses the OpenAI audio
// transcription API (Whisper / gpt-4o-transcribe), multilingual incl. Russian + Kyrgyz.
//
// Requires OPENAI_API_KEY (operator-provided; external paid service). Without it, isConfigured()
// is false and transcribe() returns { ok:false, reason:'no_api_key' } — never crashes, never
// blocks. The HTTP call is injectable (deps.fetch) for tests; we never call the real API in tests.

const fs = require('fs');

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
// whisper-1 is the safe multilingual default; override with OPENAI_TRANSCRIBE_MODEL.
function model() { return process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1'; }
function apiKey() { return process.env.OPENAI_API_KEY || null; }
function isConfigured() { return !!apiKey(); }

// transcribe({ buffer|path, filename?, mimeType?, language? }, deps) → { ok, text } | { ok:false, reason }
//   language: optional hint ('ru' | 'ky' | …). Whisper auto-detects if omitted; we default to 'ru'
//   because most messages are Russian, while Kyrgyz still transcribes.
async function transcribe(input = {}, deps = {}) {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'no_api_key', hint: 'Задайте OPENAI_API_KEY в .env (внешний платный сервис).' };

  let buffer = input.buffer;
  if (!buffer && input.path) {
    try { buffer = fs.readFileSync(input.path); } catch (_) { return { ok: false, reason: 'audio_not_found', path: input.path }; }
  }
  if (!buffer || !buffer.length) return { ok: false, reason: 'empty_audio' };

  const doFetch = deps.fetch || globalThis.fetch;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: input.mimeType || 'audio/ogg' }), input.filename || 'voice.ogg');
  form.append('model', model());
  // Language hint: 'auto' or empty → OMIT it so the model auto-detects. This is the
  // right default for mixed Russian/Kyrgyz speech (forcing 'ru' garbles Kyrgyz, and
  // gpt-4o-transcribe rejects an explicit 'ky' code). Set OPENAI_TRANSCRIBE_LANG to a
  // concrete code only when every voice note is reliably that one language.
  const lang = input.language || process.env.OPENAI_TRANSCRIBE_LANG || '';
  if (lang && !/^auto$/i.test(lang)) form.append('language', lang);
  // Optional free-text prompt to bias decoding (e.g. domain terms / language names).
  const prompt = input.prompt || process.env.OPENAI_TRANSCRIBE_PROMPT || '';
  if (prompt) form.append('prompt', prompt);
  // temperature=0 by default → most faithful / least "creative" decoding, and
  // reproducible run-to-run (важно для трудной кыргызско-русской речи). Override via
  // input.temperature or OPENAI_TRANSCRIBE_TEMPERATURE.
  const temp = input.temperature != null ? input.temperature
    : (process.env.OPENAI_TRANSCRIBE_TEMPERATURE != null && process.env.OPENAI_TRANSCRIBE_TEMPERATURE !== ''
        ? process.env.OPENAI_TRANSCRIBE_TEMPERATURE : 0);
  form.append('temperature', String(temp));

  try {
    const res = await doFetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) {
      let detail = ''; try { detail = JSON.stringify(await res.json()); } catch (_) { /* ignore */ }
      return { ok: false, reason: 'api_error', status: res.status, detail };
    }
    const json = await res.json();
    return { ok: true, text: String(json.text || '').trim(), model: model() };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

// transcribeVoiceMessage(message, deps) — convenience for a WhatsApp message that carries a voice
// note. deps.readAudio(ref) returns the audio buffer (wired to the WhatsApp media store later).
// Returns the recognized text or null (so callers can fall back to message.body).
async function transcribeVoiceMessage(message = {}, deps = {}) {
  const att = (Array.isArray(message.attachments) ? message.attachments : [])
    .find(a => /audio|ogg|voice|opus|mpeg|mp3|m4a|wav/i.test(`${a.mime_type || ''} ${a.file_name || ''}`));
  const ref = att ? (att.media_ref || att.file_name) : (message.media_ref && /audio|ogg|voice/i.test(message.mime_type || '') ? message.media_ref : null);
  if (!ref) return null;
  if (!isConfigured()) return null;

  let buffer = null;
  if (typeof deps.readAudio === 'function') { try { buffer = await deps.readAudio(ref); } catch (_) { /* ignore */ } }
  if (!buffer) return null;

  const r = await transcribe({ buffer, filename: att && att.file_name, mimeType: att && att.mime_type, language: message.language }, deps);
  return r.ok ? r.text : null;
}

module.exports = { isConfigured, model, transcribe, transcribeVoiceMessage, ENDPOINT };
