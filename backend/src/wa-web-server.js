'use strict';

// wa-web-server.js — runner for the UNOFFICIAL WhatsApp Web bridge (whatsapp-web.js).
//
// ⚠️ Temporary channel (ban risk) — see integrations/whatsappWebClient.js. Runs as its OWN
// process/container (Chromium), separate from the main backend, sharing the same MongoDB.
//
// Responsibilities:
//   • boot the web client, print the QR to the logs (scan once with 507391773),
//   • on each incoming message → whatsappIngestService.ingestIncoming → panel inbox + match,
//   • expose a tiny INTERNAL HTTP API so the backend's panel send route can reply through
//     this channel: POST /send {to, body}, GET /status. Not exposed publicly.
//
// Env: MONGODB_URI (shared), WA_WEB_PORT (default 3100), WHATSAPP_SESSION_PATH,
//      WHATSAPP_MEDIA_DIR, PUPPETEER_EXECUTABLE_PATH.

const http     = require('http');
const mongoose = require('mongoose');
const webClient = require('./integrations/whatsappWebClient');
const ingest    = require('./services/whatsappIngestService');
const safety    = require('./services/whatsappWebSafety');
const { WhatsAppMessage } = require('./models/WhatsAppMessage');
const { LidMapping } = require('./models/LidMapping');
const { matchKey, digitsOnly } = require('./utils/phoneUtils');

const PORT = parseInt(process.env.WA_WEB_PORT, 10) || 3100;
let client = null;   // set on 'ready'
let ready  = false;
let lastQr = null;   // most recent QR string (cleared on ready) — exposed at GET /qr for scanning
let schedulerStarted = false;

function log(event, data = {}) { console.log(`[wa-web] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`); }

// resolveLids — use the LIVE web.js client (getContactLidAndPhone) to turn imported LID-only
// threads (chat_id '<digits>@lid', from_phone = raw LID) into REAL phone numbers, then persist
// the mapping (LidMapping) and re-key the thread's messages so the panel shows a human number
// and the phone→order/application match starts working. READ-only toward WhatsApp (no sends).
async function resolveLids({ limit = 1000, batch = 12 } = {}) {
  if (!ready || !client) return { ok: false, reason: 'client_not_ready' };
  const lids = (await WhatsAppMessage.distinct('chat_id', { chat_id: /@lid$/i })).filter(Boolean).slice(0, limit);
  let resolved = 0, updatedMsgs = 0, failed = 0; const sample = [];
  for (let i = 0; i < lids.length; i += batch) {
    const chunk = lids.slice(i, i + batch);
    let pairs = [];
    try { pairs = await client.getContactLidAndPhone(chunk); }
    catch (e) { failed += chunk.length; log('resolve_batch_error', { error: e.message }); continue; }
    for (let j = 0; j < chunk.length; j++) {
      const lid = chunk[j];
      const pn  = pairs[j] && pairs[j].pn;                 // '<phone>@c.us'
      const phone = pn ? digitsOnly(String(pn).split('@')[0]) : '';
      const key = phone ? matchKey(phone) : '';
      if (!phone || !key) { failed++; continue; }
      const lidK = String(lid).replace(/@lid$/i, '');
      const now = new Date();
      try {
        await LidMapping.findOneAndUpdate({ lid },
          { lid, lid_key: lidK, phone, phone_key: key, source: 'getContactLidAndPhone', resolved_at: now, last_seen_at: now },
          { upsert: true, setDefaultsOnInsert: true });
      } catch (_) { /* persistence best-effort */ }
      const common = { phone_key: key, lid, lid_key: lidK, phone_resolution: 'resolved_lid', phone_resolved_at: now };
      const rin  = await WhatsAppMessage.updateMany({ chat_id: lid, direction: 'inbound' },        { $set: { ...common, from_phone: phone } });
      const rout = await WhatsAppMessage.updateMany({ chat_id: lid, direction: { $ne: 'inbound' } }, { $set: { ...common, to_phone: phone } });
      resolved++; updatedMsgs += (rin.modifiedCount || 0) + (rout.modifiedCount || 0);
      if (sample.length < 12) sample.push({ lid: lidK, phone });
    }
  }
  log('resolve_lids_done', { threads: lids.length, resolved, updatedMsgs, failed });
  return { ok: true, threads: lids.length, resolved, updated_msgs: updatedMsgs, failed, sample };
}

// ─── Self-maintaining WhatsApp backup ──────────────────────────────────────────
// The web.js session (QR once) lets us keep the VPS DB a live mirror of client chats
// WITHOUT re-linking: live inbound is captured by the 'message' event; syncHistory() tops up
// anything missed while offline + captures OUTBOUND (sent from the phone), which the live
// event ignores. Idempotent (dedup by provider_message_id) so re-runs are safe. READ-only.
let lastSyncTs = 0;         // watermark (ms) — only chats/messages newer than this are pulled
let syncing = false;

async function syncHistory({ perChat = 40, sinceMs = null, groups = false } = {}) {
  if (!ready || !client) return { ok: false, reason: 'client_not_ready' };
  if (syncing) return { ok: false, reason: 'already_running' };
  syncing = true;
  const since = sinceMs != null ? sinceMs : lastSyncTs;
  let chatsSynced = 0, scanned = 0, inbound = 0, outbound = 0, dup = 0, chatErr = 0;
  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (chat.isGroup && !groups) continue;                       // client 1:1 chats only
      const chatTs = (chat.timestamp || 0) * 1000;
      if (since && chatTs && chatTs < since) continue;             // no activity since last sync
      let msgs;
      try { msgs = await chat.fetchMessages({ limit: perChat }); } catch (_) { chatErr++; continue; }
      chatsSynced++;
      const chatId = chat.id && chat.id._serialized;                // stable thread key (…@c.us / …@lid)
      for (const m of msgs) {
        const ts = (m.timestamp || 0) * 1000;
        if (since && ts && ts < since) continue;
        scanned++;
        const raw = {
          id: m.id && m.id._serialized, from: m.from, to: m.to, chat_id: chatId,
          body: m.body || '', timestamp: m.timestamp, fromMe: !!m.fromMe,
          is_group: !!chat.isGroup, provider: 'whatsapp_web_sync',
        };
        if (!raw.id) continue;
        try {
          if (m.fromMe) { const r = await ingest.archiveOutbound(raw); (r && r.skipped) ? dup++ : outbound++; }
          else          { const r = await ingest.ingestIncoming(raw); (r && r.skipped) ? dup++ : inbound++; }
        } catch (_) { /* one bad message must not stop the sync */ }
      }
    }
    lastSyncTs = Date.now();
    const resolve = await resolveLids();                            // key any new LID threads → real number
    log('sync_history_done', { chatsSynced, scanned, inbound, outbound, dup, chatErr, resolved: resolve.resolved });
    return { ok: true, chatsSynced, scanned, inbound, outbound, dup, chatErr, resolve };
  } catch (e) {
    log('sync_history_error', { error: e.message });
    return { ok: false, error: e.message };
  } finally { syncing = false; }
}

// Scheduler: incremental every 3h; a deeper backfill once a day; both auto-resolve LIDs after.
function startBackupScheduler() {
  const HOUR = 3600 * 1000;
  let ticks = 0;
  setInterval(async () => {
    if (!ready) return;
    ticks++;
    const deep = ticks % 8 === 0;                                  // ~every 24h a deeper pass
    await syncHistory(deep ? { perChat: 250, sinceMs: 0 } : { perChat: 40 });
  }, 3 * HOUR);
  log('backup_scheduler_started', { incremental_h: 3, deep_every_ticks: 8 });
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[wa-web] MONGODB_URI not set — ingest needs it. Exiting.'); process.exit(1); }
  await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
  log('mongo_connected', {});

  // Boot the WhatsApp Web client. Incoming → ingest (panel inbox + phone→order match).
  await webClient.startClient({
    onReady: (c) => {
      client = c; ready = true; lastQr = null; log('client_ready', {});
      if (!schedulerStarted) {
        schedulerStarted = true;
        startBackupScheduler();
        // Initial backfill (deeper), delayed so the client finishes syncing its store first.
        setTimeout(() => { syncHistory({ perChat: 250, sinceMs: 0 }).catch(() => {}); }, 60 * 1000);
      }
    },
    onQr: (qr) => {
      lastQr = qr;
      if (ready) { ready = false; log('relink_required', { alert: 'WhatsApp отвязал устройство — нужен ОДИН повторный QR-скан (507391773)' }); }
    },
    onIncoming: async (raw) => {
      try { const r = await ingest.ingestIncoming(raw); log('ingested', { id: raw.id, skipped: r.skipped || null }); }
      catch (err) { log('ingest_error', { id: raw.id, error: err.message }); }
    },
  });

  // Internal HTTP API for the panel send route (operator-initiated replies only).
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ready, channel: 'whatsapp_web', has_qr: !!lastQr, needs_relink: !ready && !!lastQr, last_sync_at: lastSyncTs ? new Date(lastSyncTs).toISOString() : null, syncing }));
    }
    if (req.method === 'GET' && req.url === '/qr') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ready, qr: ready ? null : lastQr }));
    }
    if (req.method === 'POST' && req.url === '/sync-history') {
      (async () => {
        try { const r = await syncHistory({ perChat: 250, sinceMs: 0 }); res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); }
        catch (e) { log('sync_history_route_error', { error: e.message }); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      })();
      return;
    }
    if (req.method === 'POST' && req.url === '/resolve-lids') {
      (async () => {
        try { const r = await resolveLids(); res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); }
        catch (e) { log('resolve_lids_error', { error: e.message }); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      })();
      return;
    }
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let payload = {}; try { payload = JSON.parse(body || '{}'); } catch (_) {}
        let result;
        if (!ready) {
          result = { ok: false, reason: 'client_not_ready' };
        } else {
          // Anti-ban gate: reactive-first, rate-limited, cold-capped, human-paced.
          const g = await safety.gate({ to: payload.to, body: payload.body }, { WhatsAppMessage });
          if (!g.allow) {
            result = { ok: false, reason: 'safety_blocked', detail: g.reason, wait_ms: g.waitMs || null, cold: !!g.cold };
            log('send_blocked', { to: payload.to, reason: g.reason, cold: !!g.cold });
          } else {
            result = await webClient.sendText(client, payload.to, payload.body, { typingMs: g.delayMs });
            if (result.ok) safety.recordSend(payload.to, payload.body, { cold: g.cold });
          }
        }
        res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }).listen(PORT, () => log('http_listening', { port: PORT }));
}

main().catch((err) => { console.error('[wa-web] fatal:', err); process.exit(1); });
