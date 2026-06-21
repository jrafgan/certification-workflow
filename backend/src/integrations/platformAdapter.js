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

module.exports = { StubAdapter, normalizeInbound };
