'use strict';

// integrations/platformAdapter.js — the boundary between the Lead Conversion Agent and the
// social platforms (Instagram / Facebook / Telegram). V1 ships a STUB only: no live API is
// wired (that needs Meta Graph / Telegram Bot credentials + webhooks — a deliberate, gated
// follow-up). The engine depends on this interface, not on any concrete platform, so a real
// adapter drops in later without touching the conversion logic.
//
// Contract:
//   receive(raw)        → normalize an inbound platform event to { platform, handle, display_name, text, at }
//   deliver(draft)      → send an APPROVED LeadMessageDraft; returns { ok, ref } | { ok:false }
//
// The stub `deliver` does NOT send anywhere — it records the intent and returns ok so the
// operator-release flow can be exercised end-to-end without an external account.

function normalizeInbound(raw = {}) {
  return {
    platform:     raw.platform,
    handle:       raw.handle || raw.from || raw.sender_id,
    display_name: raw.display_name || raw.name || null,
    text:         raw.text || raw.message || raw.body || '',
    at:           raw.at ? new Date(raw.at) : new Date(),
  };
}

// A no-op adapter: implements the interface, sends nothing. Used until a real client exists.
const StubAdapter = {
  name: 'stub',
  receive(raw) { return normalizeInbound(raw); },
  async deliver(draft) {
    // Intentionally does not transmit. Real adapters POST to the platform here.
    return { ok: true, ref: `stub:${draft.platform}:${draft._id || 'draft'}`, delivered: false, note: 'stub adapter — not transmitted' };
  },
};

// RealAdapter — dispatches delivery to a live platform client by draft.platform. Telegram is
// wired (independent of Meta); Instagram/Facebook fall back to the stub until their Meta
// app review + business verification clears. `receive` stays generic (the webhook route
// pre-normalizes platform-specific payloads). deps.telegram is injectable for tests.
const RealAdapter = {
  name: 'real',
  receive(raw) { return normalizeInbound(raw); },
  async deliver(draft, deps = {}) {
    if (draft.platform === 'telegram') {
      // Prefer the USERBOT (mtcute, sends as the operator's account) when running; else Bot API.
      const userbotUrl = process.env.TG_USERBOT_SEND_URL;
      if (userbotUrl) {
        try {
          const r = await (deps.fetch || globalThis.fetch)(userbotUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: draft.to_handle, text: draft.proposed_text }) });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.ok) return { ok: true, ref: `tg-userbot:${j.message_id}`, delivered: true };
          return { ok: false, ref: null, delivered: false, detail: j };
        } catch (err) { return { ok: false, ref: null, delivered: false, detail: err.message }; }
      }
      const telegram = deps.telegram || require('./telegramClient');
      if (telegram.isConfigured()) {
        const r = await telegram.sendMessage(draft.to_handle, draft.proposed_text, deps);
        if (!r.ok) return { ok: false, ref: null, delivered: false, detail: r };
        return { ok: true, ref: `telegram:${r.message_id}`, delivered: true };
      }
    }
    // No live client for this platform yet → behave like the stub (records intent, no send).
    return StubAdapter.deliver(draft);
  },
};

module.exports = { StubAdapter, RealAdapter, normalizeInbound };
