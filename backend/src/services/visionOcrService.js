'use strict';

// services/visionOcrService.js — image OCR via an OpenAI vision model (the strongest
// available image reader), replacing local tesseract for photos of receipts / documents.
//
// Mirrors audioTranscriptionService: read-only, external paid API, fully injectable for
// tests (deps.fetch). Requires OPENAI_API_KEY; without it isConfigured() is false and the
// caller (documentUnderstandingService) falls back to tesseract. Returns PLAIN TEXT only —
// the deterministic regex layer in documentUnderstandingService still does the field
// extraction, so this service is a drop-in replacement for the tesseract text step.
//
// Handles IMAGES only (jpeg/png/webp/gif) — the primary case is a WhatsApp photo of a
// receipt/document. Scanned PDFs stay on the existing pdftotext→tesseract path.

const fs = require('fs');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// The exact model id is volatile — keep it in env (standing rule: volatile values → env).
// Default is the operator-requested GPT-5.1; override with OPENAI_VISION_MODEL if the id
// changes. A wrong id fails loudly with a clear api_error (no silent fallback to garbage).
function model() { return process.env.OPENAI_VISION_MODEL || 'gpt-5.1'; }
function apiKey() { return process.env.OPENAI_API_KEY || null; }
function isConfigured() { return !!apiKey(); }

// Instruct the model to act as a faithful OCR engine, not an interpreter: transcribe
// exactly what is printed (RU/KY), preserve line order, add nothing.
const OCR_PROMPT =
  'Ты — OCR-движок. Извлеки ВЕСЬ текст с изображения ровно так, как он напечатан, ' +
  'сохраняя порядок строк. Не переводи, не пересказывай, не комментируй, ничего не ' +
  'добавляй. Верни только распознанный текст. Если текста нет — верни пустую строку.';

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
};

// Best-effort image mime for the data URI: explicit mimeType wins, else infer from the
// filename extension, else default to jpeg (WhatsApp photos are jpeg).
function imageMime(mimeType, fileName) {
  if (mimeType && /^image\//i.test(mimeType)) return mimeType.toLowerCase();
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return IMAGE_MIME[ext] || 'image/jpeg';
}

function isImageInput({ mimeType, fileName } = {}) {
  if (mimeType && /^image\//i.test(mimeType)) return true;
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return !!IMAGE_MIME[ext];
}

// ocrImage({ buffer|path, mimeType?, fileName? }, deps) → { ok, text, model } | { ok:false, reason }
async function ocrImage(input = {}, deps = {}) {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'no_api_key', hint: 'Задайте OPENAI_API_KEY в .env (внешний платный сервис).' };
  if (!isImageInput(input)) return { ok: false, reason: 'not_an_image' };

  let buffer = input.buffer;
  if (!buffer && input.path) {
    try { buffer = fs.readFileSync(input.path); } catch (_) { return { ok: false, reason: 'image_not_found', path: input.path }; }
  }
  if (!buffer || !buffer.length) return { ok: false, reason: 'empty_image' };

  const mime = imageMime(input.mimeType, input.fileName || input.path);
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;

  // Minimal body (model + messages) on purpose: newer models reject temperature/max_tokens
  // params, so we omit them for forward-compatibility with whatever OPENAI_VISION_MODEL is.
  const body = {
    model: model(),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUri, detail: 'high' } },
      ],
    }],
  };

  const doFetch = deps.fetch || globalThis.fetch;
  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = ''; try { detail = JSON.stringify(await res.json()); } catch (_) { /* ignore */ }
      return { ok: false, reason: 'api_error', status: res.status, detail };
    }
    const json = await res.json();
    const text = String(json.choices?.[0]?.message?.content || '').trim();
    return { ok: true, text, model: model() };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

module.exports = { isConfigured, model, ocrImage, isImageInput, ENDPOINT };
