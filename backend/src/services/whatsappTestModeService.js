'use strict';

// services/whatsappTestModeService.js — TEST_MODE policy for live WhatsApp testing.
//
// During live testing the agent is restricted to a SINGLE allowed contact for any
// active processing ("Мой Билайн" by default). Every other contact is OBSERVE-ONLY:
// log it and do nothing else — no responses, no sends, no actions, no state changes.
//
// This module is PURE (no I/O, no whatsapp-web.js, no DB) so the gating decision is
// fully unit-testable. The provider client imports `decideHandling` to route each
// inbound message; the harness imports the helpers to build its report.
//
// SAFETY NOTE: nothing here marks chats as read or alters unread counters — it only
// CLASSIFIES how a message should be handled. Read-receipt safety lives in the client
// (it never calls sendSeen / markUnread and connects with markOnlineOnConnect:false).

const DEFAULT_TEST_CONTACT = 'Мой Билайн';

// isTestMode(env) — TEST_MODE is enabled when TEST_MODE is a truthy flag.
function isTestMode(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.TEST_MODE || '').trim());
}

// allowedContactName(env) — the single contact permitted for active testing.
function allowedContactName(env = process.env) {
  const v = String(env.WHATSAPP_TEST_CONTACT || '').trim();
  return v || DEFAULT_TEST_CONTACT;
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}
function digits(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

// isAllowedContact(contact, allowedName) — true when the message's contact matches
// the allowed test contact. `contact` is a provider-agnostic shape:
//   { name, pushname, shortName, number }
// Matches by any saved-name field (case-insensitive) OR, when the allowed value
// looks like a phone number, by digits-suffix on the number.
function isAllowedContact(contact = {}, allowedName = DEFAULT_TEST_CONTACT) {
  const allowed = String(allowedName || '').trim();
  if (!allowed) return false;

  const names = [contact.name, contact.pushname, contact.shortName].map(norm).filter(Boolean);
  if (names.includes(norm(allowed))) return true;

  // If the allowed value is itself a number, compare digit suffixes (>= 7 digits).
  const allowedDigits = digits(allowed);
  if (allowedDigits.length >= 7) {
    const numDigits = digits(contact.number);
    if (numDigits && (numDigits.endsWith(allowedDigits) || allowedDigits.endsWith(numDigits))) {
      return true;
    }
  }
  return false;
}

// decideHandling({ fromMe, testMode, allowed }) → handling decision:
//   'skip_self'    — our own outbound; ignore entirely
//   'process'      — full read-only analysis pipeline (allowed contact, or TEST_MODE off)
//   'observe_only' — TEST_MODE on and contact NOT allowed: log only, no actions
// Pure — the single source of truth for routing, exported for testing.
function decideHandling({ fromMe = false, testMode = false, allowed = false } = {}) {
  if (fromMe) return 'skip_self';
  if (!testMode) return 'process';      // normal operation processes all inbound
  return allowed ? 'process' : 'observe_only';
}

module.exports = {
  DEFAULT_TEST_CONTACT,
  isTestMode,
  allowedContactName,
  isAllowedContact,
  decideHandling,
};
