'use strict';

// services/whatsappLidDiagnosticsService.js — DIAGNOSTICS ONLY.
//
// WhatsApp now addresses some contacts by a "LID" (Linked Identity, "<digits>@lid")
// instead of a phone number ("<digits>@c.us"). The LID's digits are NOT a phone
// number. This module builds a structured diagnostic report from the identifiers a
// whatsapp-web.js message/contact/chat expose, and from the library's own LID→phone
// resolver result, so we can see exactly what is resolvable.
//
// It changes NO matching logic and performs NO I/O — it only shapes already-extracted
// values into a report. The live runner (scripts/whatsapp-lid-diagnostics.js) gathers
// the raw values and the resolver output, then calls buildReport().

// parseWid('37087478829063@lid') → { user:'37087478829063', server:'lid', is_lid:true }
function parseWid(serialized) {
  const s = String(serialized || '');
  const at = s.lastIndexOf('@');
  if (at === -1) return { user: s, server: null, is_lid: false };
  const user   = s.slice(0, at);
  const server = s.slice(at + 1);
  return { user, server, is_lid: server === 'lid' };
}

// buildReport(input) — input carries the raw values pulled off the message/contact/
// chat plus the resolver result `{ lid, pn }` from client.getContactLidAndPhone().
// All fields are optional; anything missing is reported as null/unknown.
function buildReport({
  message = {},     // { id, from, author, to, fromMe, type, notifyName }
  contact = {},     // whatsapp-web.js Contact (subset of fields)
  chat    = {},     // whatsapp-web.js Chat (subset of fields)
  resolved = {},    // { lid, pn } from client.getContactLidAndPhone([from])
} = {}){
  const fromWid    = parseWid(message.from);
  const contactWid = parseWid(contact.id && (contact.id._serialized || contact.id));

  // Candidate phone, in order of trust:
  //   1) resolver pn (authoritative),
  //   2) contact.id if it is already a c.us wid (getContactModel substitutes the
  //      phone into id when the Store has it),
  //   3) null. NOTE: contact.number is derived from the LID userid for LID contacts
  //      and is therefore NOT trusted as a phone here (reported separately, raw).
  let phone_number = null;
  if (resolved.pn) phone_number = resolved.pn;
  else if (contactWid.server === 'c.us') phone_number = contact.id._serialized || contact.id;

  const lid =
    fromWid.is_lid ? message.from :
    contactWid.is_lid ? (contact.id._serialized || contact.id) :
    (resolved.lid || null);

  const business_name = contact.verifiedName
    || (contact.businessProfile && contact.businessProfile.name)
    || null;

  return {
    // ── all available identifiers ──
    identifiers: {
      message_id: message.id || null,
      from:       message.from || null,
      author:     message.author || null,
      to:         message.to || null,
      from_me:    !!message.fromMe,
      message_type: message.type || null,
    },
    addressing: {
      from_user:   fromWid.user || null,
      from_server: fromWid.server || null,   // 'lid' | 'c.us' | 'g.us' | …
      is_lid:      fromWid.is_lid || contactWid.is_lid,
    },
    // ── phone vs LID ──
    phone_number,                            // resolved real phone wid, or null
    phone_available: !!phone_number,
    lid,                                     // the @lid wid, or null
    // ── names ──
    pushName:      message.notifyName || contact.pushname || null,
    contact_name:  contact.name || contact.shortName || null,
    business_name,
    // ── raw objects (verbatim, for the report) ──
    raw_contact: contact,
    raw_chat: {
      id:       chat.id && (chat.id._serialized || chat.id) || null,
      name:     chat.name || null,
      is_group: !!chat.isGroup,
    },
    raw_resolved: resolved,
    // ── interpretation ──
    analysis: phone_number
      ? `Phone resolved (${phone_number}). LID=${lid || 'n/a'}. Matching by phone_key is viable for this contact.`
      : `NO phone resolvable from this ${fromWid.is_lid ? 'LID' : 'contact'} via the WA Store. Only the LID (${lid || message.from || 'unknown'}) is available; contact.number ("${contact.number || ''}") is the LID userid, not a phone.`,
  };
}

module.exports = { parseWid, buildReport };
