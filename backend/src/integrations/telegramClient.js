'use strict';

// integrations/telegramClient.js — Telegram Bot API transport for the Lead Conversion Agent.
//
// Telegram is INDEPENDENT of Meta (no business verification): a bot token from @BotFather is
// all that's needed. Outbound: POST api.telegram.org/bot<token>/sendMessage. Inbound: Telegram
// calls our webhook with an Update; we verify the secret-token header, parse, and hand the
// normalized message to the conversion engine. This module is the transport only — the agent
// still never auto-sends (operator approves + releases each draft).
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (echoed back in the
//      X-Telegram-Bot-Api-Secret-Token header on every inbound update).
// The HTTP call is injectable (deps.fetch) for tests — no real Telegram call in tests.

const crypto = require('crypto');

function token() { return process.env.TELEGRAM_BOT_TOKEN || null; }
function isConfigured() { return !!token(); }
function apiBase() { return `https://api.telegram.org/bot${token()}`; }

// ─── Outbound: send a text message ──────────────────────────────────────────────
async function sendMessage(chatId, text, deps = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured', hint: 'Задайте TELEGRAM_BOT_TOKEN (токен от @BotFather).' };
  if (!chatId || !text) return { ok: false, reason: 'missing_chat_or_text' };

  const doFetch = deps.fetch || globalThis.fetch;
  try {
    const res = await doFetch(`${apiBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) return { ok: false, reason: 'api_error', status: res.status, detail: json };
    return { ok: true, message_id: json.result && json.result.message_id, chat_id: String(chatId) };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

// ─── Inbound: verify the secret-token header set via setWebhook ──────────────────
// Returns ok:null when no secret is configured (skip in dev), ok:true/false otherwise.
function verifySecret(headerToken) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return { ok: null, reason: 'no_webhook_secret' };
  if (!headerToken) return { ok: false, reason: 'no_secret_header' };
  const a = Buffer.from(String(headerToken));
  const b = Buffer.from(String(secret));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok };
}

// ─── Inbound: normalize a Telegram Update → the engine's ingest shape ────────────
// → { platform:'telegram', handle, display_name, text, at } | null (non-message update).
// handle = chat id (string) so the delivery adapter can reply with sendMessage(handle, ...).
// PURE (no I/O) — unit-testable.
function parseUpdate(update = {}) {
  const m = update.message || update.edited_message;
  if (!m || !m.chat) return null;
  const from = m.from || {};
  const display_name = [from.first_name, from.last_name].filter(Boolean).join(' ')
    || from.username || null;
  return {
    platform:     'telegram',
    handle:       String(m.chat.id),
    display_name,
    username:     from.username ? `@${from.username}` : null,
    text:         m.text || m.caption || '',
    at:           m.date ? new Date(m.date * 1000) : new Date(),
  };
}

// ─── Setup helper: register the webhook with Telegram (operator/dev runs once) ───
async function setWebhook(url, deps = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  const doFetch = deps.fetch || globalThis.fetch;
  const body = { url: String(url), allowed_updates: ['message', 'edited_message'] };
  if (process.env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
  const res = await doFetch(`${apiBase()}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false }));
}

module.exports = { isConfigured, sendMessage, verifySecret, parseUpdate, setWebhook };
