'use strict';

// services/whatsappLidService.js — WhatsApp LID phone resolution for ingest.
//
// Implements the contact-identity resolution used at ingest time, with the priority:
//
//     phone number  (sender already @c.us)
//          ↓
//     resolved LID phone  (live client.getContactLidAndPhone())
//          ↓
//     stored LID mapping  (a prior successful resolution in lid_mappings)
//          ↓
//     LID-only fallback   (no phone; use the LID as the contact identity)
//
// Successful resolutions are persisted (LidMapping) so a known LID keeps matching even
// when a later live resolve returns nothing. Resolution NEVER drops a message — on
// failure it returns a LID-only identity and ingest stores the message regardless.
//
// READ-ONLY toward the world: it calls the injected resolver (a thin wrapper around
// whatsapp-web.js) and writes only the lid_mappings replica. No sends, no Declaration
// writes, no Gmail.

const { digitsOnly, matchKey } = require('../utils/phoneUtils');

const RESOLUTIONS = ['phone', 'resolved_lid', 'stored_lid', 'lid_only'];

// ─── Pure helpers ────────────────────────────────────────────────────────────
function isLid(id) { return /@lid$/i.test(String(id || '')); }

// lidKey('37087478829063@lid') → '37087478829063' (the user part; '' if not a LID).
function lidKey(id) {
  const s = String(id || '');
  return isLid(s) ? s.slice(0, s.lastIndexOf('@')) : '';
}

// phoneFromWid('996700112233@c.us') → '996700112233' (digits before '@').
function phoneFromWid(wid) { return digitsOnly(String(wid || '').split('@')[0]); }

// deriveIdentity(raw) — PURE, no resolver, no DB. Used by mapIncomingMessage when no
// resolved identity is supplied. A LID sender yields a LID-only identity (its digits
// are NOT a phone); a @c.us sender yields a phone identity.
function deriveIdentity(raw = {}) {
  const from = raw.from || '';
  if (isLid(from)) {
    return { from_phone: '', phone_key: '', lid: from, lid_key: lidKey(from), resolution: 'lid_only', resolved_at: null };
  }
  const fp = phoneFromWid(from);
  return {
    from_phone: fp,
    phone_key:  matchKey(fp),
    lid:        null,
    lid_key:    null,
    resolution: from ? 'phone' : null,
    resolved_at: null,
  };
}

// ─── DB-backed resolution ──────────────────────────────────────────────────────
// resolveIdentity(raw, deps) → identity object (same shape as deriveIdentity).
// deps.lidResolver(ids) — async, returns [{ lid, pn }] (whatsapp-web.js getContactLidAndPhone).
// deps.LidMapping       — model (defaults to models/LidMapping).
async function resolveIdentity(raw = {}, deps = {}) {
  const from = raw.from || '';

  // 1) phone number — sender is already a real phone.
  if (!isLid(from)) {
    return deriveIdentity(raw);
  }

  const lid = from;
  const lk  = lidKey(from);
  const LidMapping = deps.LidMapping || require('../models/LidMapping').LidMapping;

  // 2) resolved LID phone — live resolution takes priority (freshest), and is persisted.
  if (typeof deps.lidResolver === 'function') {
    try {
      const arr = await deps.lidResolver([lid]);
      const r   = Array.isArray(arr) ? arr[0] : arr;
      const pn  = r && r.pn;
      if (pn) {
        const phone = phoneFromWid(pn);
        const key   = matchKey(phone);
        const now   = new Date();
        try {
          await LidMapping.findOneAndUpdate(
            { lid },
            { lid, lid_key: lk, phone, phone_key: key, source: 'getContactLidAndPhone', resolved_at: now, last_seen_at: now },
            { upsert: true, setDefaultsOnInsert: true }
          );
        } catch (_) { /* persistence failure must not drop the message */ }
        return { from_phone: phone, phone_key: key, lid, lid_key: lk, resolution: 'resolved_lid', resolved_at: now };
      }
    } catch (_) {
      // live resolution failed — fall through to the stored mapping
    }
  }

  // 3) stored LID mapping — reuse a prior successful resolution.
  try {
    const stored = await LidMapping.findOne({ lid }).lean();
    if (stored && stored.phone) {
      return {
        from_phone: stored.phone,
        phone_key:  stored.phone_key || matchKey(stored.phone),
        lid, lid_key: lk,
        resolution: 'stored_lid',
        resolved_at: stored.resolved_at || null,
      };
    }
  } catch (_) { /* fall through to LID-only */ }

  // 4) LID-only fallback — no phone; keep the LID as the contact identity.
  return { from_phone: '', phone_key: '', lid, lid_key: lk, resolution: 'lid_only', resolved_at: null };
}

// ─── Self-healing sweep: apply already-known mappings to stuck lid-only messages ──────
// A message can arrive via the GOWA webhook BEFORE web.js has resolved that LID → it is stored
// lid-only (empty phone_key) and the panel shows a raw LID. Later web.js resolves the LID into
// lid_mappings, but nothing rewrites the earlier message. This finds inbound messages that still
// carry a LID with no phone_key and, if a mapping now EXISTS, rewrites from_phone/phone_key —
// exactly what web.js resolve-lids does, but driven from the backend so the panel is always
// correct. Idempotent, bounded, safe to run on every inbox load. Returns { scanned, fixed }.
async function applyStoredMappings(deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models');
  const { LidMapping } = deps.LidMapping ? deps : require('../models/LidMapping');
  const limit = deps.limit || 2000;

  const stuck = await WhatsAppMessage.find({
    lid: { $exists: true, $nin: [null, ''] },
    $or: [{ phone_key: { $in: [null, ''] } }, { phone_key: { $exists: false } }],
  }).select('_id lid').limit(limit).lean();
  if (!stuck.length) return { scanned: 0, fixed: 0 };

  const lids = [...new Set(stuck.map(m => m.lid))];
  const maps = await LidMapping.find({ lid: { $in: lids } }).lean();
  const byLid = new Map();
  for (const m of maps) if (m.phone_key || m.phone) byLid.set(m.lid, m);

  const ops = [];
  for (const m of stuck) {
    const map = byLid.get(m.lid);
    if (!map) continue;
    const phone = map.phone || '';
    const key = map.phone_key || matchKey(phone);
    if (!key) continue;
    ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: {
      from_phone: phone, phone_key: key, phone_resolution: 'stored_lid',
    } } } });
  }
  if (ops.length) await WhatsAppMessage.bulkWrite(ops, { ordered: false });
  return { scanned: stuck.length, fixed: ops.length };
}

module.exports = {
  RESOLUTIONS,
  isLid,
  lidKey,
  phoneFromWid,
  deriveIdentity,
  resolveIdentity,
  applyStoredMappings,
};
