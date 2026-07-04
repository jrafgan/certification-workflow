'use strict';

// tg-userbot/server.js — Telegram USERBOT via mtcute (MTProto, ESM). Logs in as the operator's
// OWN account (@jrafgan / 996507391773), forwards incoming messages (DM + group) to the backend
// webhook → panel inbox + interest detection, and exposes POST /send for operator replies.
//
// ⚠️ Unofficial userbot channel. Telegram tolerates userbots far more than WhatsApp tolerates
// whatsapp-web.js, but mass cold DMs still risk a ban — outbound stays operator-gated upstream.
//
// Manual sign-in flow (so we can switch the code to SMS): sendCode → [resendCode→SMS] → signIn
// → checkPassword (2FA). Code/password are fed over HTTP; session persists in a volume.
//
// Env: TG_API_ID, TG_API_HASH, TG_PHONE, TG_SESSION, TG_WEBHOOK_URL, TG_WEBHOOK_SECRET, TG_PORT.

import http   from 'node:http';
import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { TelegramClient } from '@mtcute/node';
import { Dispatcher } from '@mtcute/dispatcher';

const PORT = parseInt(process.env.TG_PORT, 10) || 3200;
const log = (event, data = {}) => console.log(`[tg-userbot] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`);

const SESSION = process.env.TG_SESSION || 'storage/jrafgan';
fs.mkdirSync(path.dirname(SESSION), { recursive: true });

const PHONE = process.env.TG_PHONE;
const tg = new TelegramClient({ apiId: Number.parseInt(process.env.TG_API_ID, 10), apiHash: process.env.TG_API_HASH, storage: SESSION });

let authorized = false;
let awaiting = null;                 // 'code' | 'password' | null
let phoneCodeHash = null;
let codeResolve = null, pwdResolve = null;
const askCode = () => { awaiting = 'code'; return new Promise((r) => { codeResolve = r; }); };
const askPassword = () => { awaiting = 'password'; return new Promise((r) => { pwdResolve = r; }); };
const matches = (err, re) => re.test(String(err && (err.text || err.message || err)));

// ─── Forward an incoming message to the backend webhook (HMAC-signed) ────────────
async function forward(msg) {
  const url = process.env.TG_WEBHOOK_URL;
  if (!url) return;
  const chat = msg.chat || {};
  const sender = msg.sender || {};
  const chatType = chat.chatType || chat.type || 'private';
  const body = JSON.stringify({
    event: 'message',
    payload: {
      id: String(msg.id ?? ''), chat_id: String(chat.id ?? ''), chat_type: chatType, is_group: chatType !== 'private',
      from_id: String(sender.id ?? chat.id ?? ''), username: sender.username || null,
      from_name: sender.displayName || sender.firstName || chat.title || null,
      text: msg.text || '', at: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString(),
    },
  });
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (secret) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try { await fetch(url, { method: 'POST', headers, body }); } catch (err) { log('forward_error', { error: err.message }); }
}

async function finishLogin() {
  authorized = true; awaiting = null;
  try { tg.startUpdatesLoop(); } catch (_) { /* high-level may already run it */ }
  const me = await tg.getMe();
  log('logged_in', { username: me.username, name: me.displayName });
}

async function ensureLogin() {
  const dp = Dispatcher.for(tg);
  dp.onNewMessage(async (msg) => { try { if (!msg.isOutgoing) await forward(msg); } catch (e) { log('msg_error', { error: e.message }); } });

  try { await tg.getMe(); return finishLogin(); }          // already authorized (session restored)
  catch (_) { /* needs sign-in */ }

  let sent = await tg.sendCode({ phone: PHONE });
  phoneCodeHash = sent.phoneCodeHash;
  log('code_sent', { type: sent.type && sent.type.name, next: sent.nextType && sent.nextType.name });

  for (;;) {                                               // retry on invalid/expired code
    const code = await askCode();
    try {
      await tg.signIn({ phone: PHONE, phoneCodeHash, phoneCode: String(code) });
      return finishLogin();
    } catch (err) {
      if (matches(err, /SESSION_PASSWORD_NEEDED/)) {
        for (;;) {                                         // retry on wrong 2FA password
          const pwd = await askPassword();
          try { await tg.checkPassword(String(pwd)); return finishLogin(); }
          catch (e2) { if (matches(e2, /PASSWORD_HASH_INVALID/)) { log('password_invalid', {}); continue; } throw e2; }
        }
      }
      if (matches(err, /PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/)) { log('code_invalid', { err: String(err.text || err.message) }); continue; }
      throw err;
    }
  }
}

// ─── Internal HTTP: login submission/resend + status + send ──────────────────────
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => res(b)); });

http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/status') return json(200, { authorized, awaiting });

    if (req.method === 'POST' && req.url === '/login/code') {
      const { value } = JSON.parse((await readBody(req)) || '{}');
      if (!codeResolve) return json(409, { ok: false, reason: 'not_awaiting_code' });
      const r = codeResolve; codeResolve = null; awaiting = null; r(String(value || ''));
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/login/password') {
      const { value } = JSON.parse((await readBody(req)) || '{}');
      if (!pwdResolve) return json(409, { ok: false, reason: 'not_awaiting_password' });
      const r = pwdResolve; pwdResolve = null; awaiting = null; r(String(value || ''));
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/login/resend') {           // switch delivery (→ SMS)
      if (authorized) return json(409, { ok: false, reason: 'already_authorized' });
      try {
        const sent = await tg.resendCode({ phone: PHONE, phoneCodeHash });
        phoneCodeHash = sent.phoneCodeHash;
        log('code_resent', { type: sent.type && sent.type.name });
        return json(200, { ok: true, type: sent.type && sent.type.name });
      } catch (err) { return json(502, { ok: false, reason: 'resend_failed', detail: String(err.text || err.message) }); }
    }

    if (req.method === 'POST' && req.url === '/send') {
      if (!authorized) return json(409, { ok: false, reason: 'not_authorized' });
      const { to, text } = JSON.parse((await readBody(req)) || '{}');
      if (!to || !text) return json(400, { ok: false, reason: 'to_and_text_required' });
      try { const sent = await tg.sendText(to, String(text)); return json(200, { ok: true, message_id: sent && sent.id }); }
      catch (err) { return json(502, { ok: false, reason: 'send_failed', detail: String(err.text || err.message) }); }
    }
    json(404, { error: 'not_found' });
  } catch (err) { json(500, { error: err.message }); }
}).listen(PORT, () => log('http_listening', { port: PORT }));

ensureLogin().catch((err) => { log('fatal', { error: String(err && (err.text || err.message || err)) }); process.exit(1); });
