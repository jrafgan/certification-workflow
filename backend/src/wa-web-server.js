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

const PORT = parseInt(process.env.WA_WEB_PORT, 10) || 3100;
let client = null;   // set on 'ready'
let ready  = false;

function log(event, data = {}) { console.log(`[wa-web] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`); }

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[wa-web] MONGODB_URI not set — ingest needs it. Exiting.'); process.exit(1); }
  await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
  log('mongo_connected', {});

  // Boot the WhatsApp Web client. Incoming → ingest (panel inbox + phone→order match).
  await webClient.startClient({
    onReady: (c) => { client = c; ready = true; log('client_ready', {}); },
    onIncoming: async (raw) => {
      try { const r = await ingest.ingestIncoming(raw); log('ingested', { id: raw.id, skipped: r.skipped || null }); }
      catch (err) { log('ingest_error', { id: raw.id, error: err.message }); }
    },
  });

  // Internal HTTP API for the panel send route (operator-initiated replies only).
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ready, channel: 'whatsapp_web' }));
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
