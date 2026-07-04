'use strict';

// services/outboundWhatsappService.js — single safety-gated WhatsApp SEND path, shared by the
// panel reply route and by lead/outreach approvals. Guarantees EVERY outbound (operator reply
// or approved first-contact) passes the anti-ban gate and goes out on the active channel.
//
// Channel priority: GOWA gateway (507, unofficial) → legacy whatsapp-web.js bridge → official
// Meta Cloud API. The agent never auto-sends — callers are operator-triggered.

const gowa   = require('../integrations/gowaClient');
const cloud  = require('../services/whatsappCloudService');
const safety = require('../services/whatsappWebSafety');

function activeChannel() {
  if (gowa.isConfigured()) return 'gowa';
  if (process.env.WHATSAPP_WEB_SEND_URL) return 'whatsapp_web';
  return 'cloud_api';
}

// send(to, body, opts) → { ok, ... }. When gated:true (default) the anti-ban gate runs first;
// pass gated:false only for already-template/within-window Cloud API sends that don't need it.
async function send(to, body, opts = {}) {
  const gated = opts.gated !== false;
  if (gowa.isConfigured()) {
    if (gated) {
      const g = await safety.gate({ to, body });
      if (!g.allow) return { ok: false, reason: 'safety_blocked', detail: g.reason, wait_ms: g.waitMs || null, cold: !!g.cold };
      const r = await gowa.sendText(to, body);
      if (r.ok) safety.recordSend(to, body, { cold: g.cold });
      return r;
    }
    return gowa.sendText(to, body);
  }
  const webUrl = process.env.WHATSAPP_WEB_SEND_URL;
  if (webUrl) {
    try {
      const r = await (globalThis.fetch)(webUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body }) });
      const json = await r.json().catch(() => ({}));
      return r.ok ? json : { ok: false, reason: 'wa_web_error', detail: json };
    } catch (err) { return { ok: false, reason: 'wa_web_unreachable', detail: err.message }; }
  }
  return cloud.sendText(to, body);
}

module.exports = { send, activeChannel };
