'use strict';

// services/emailLinkService.js — build & serve the persistent link between Gmail lab letters and
// clients' WhatsApp numbers, bridged through «Декларация» (see model EmailLink).
//
// The matching engine is the deep-match already in taskInboxService.clientEmails (name / phone /
// lab-counterparty / body → confidence). This service turns those per-phone results into durable
// links, deciding — per the operator-approved rule — what to auto-confirm vs. hand to the operator:
//
//   • confidence HIGH and the thread maps to EXACTLY ONE phone → auto-confirm (source=auto),
//   • HIGH but the same thread is strong for >1 phones        → propose all (which client?),
//   • MEDIUM with no strong owner                             → propose,
//   • MEDIUM when the thread is already high-unique to ANOTHER phone → skip (that's the owner; noise),
//   • LOW                                                     → skip.
//
// The operator is authoritative: a re-scan never overwrites a link whose source is 'operator'.
// Everything here is READ-ONLY toward Gmail and the sheet; it only writes its own email_links.

const { matchKey } = require('../utils/phoneUtils');

// ─── PURE: turn per-phone deep-match results into link decisions ──────────────────────────────
// input: [{ phone_key, client_name, sheet_rows, order_id, emails: [{ thread_id, subject, from, to,
//           at, confidence, signals }] }]  (one entry per scanned phone)
// output: [{ gmail_thread_id, phone_key, client_name, sheet_rows, order_id, subject, from_addr,
//            to_addr, last_message_at, confidence, signals, ambiguous_phones, status, source }]
function decideLinks(input = []) {
  // Which phones each thread matched at HIGH confidence (the ownership signal).
  const threadHigh = new Map();                     // thread_id → Set(phone_key)
  for (const p of input) {
    for (const e of p.emails || []) {
      if (e.confidence === 'high' && e.thread_id) {
        if (!threadHigh.has(e.thread_id)) threadHigh.set(e.thread_id, new Set());
        threadHigh.get(e.thread_id).add(p.phone_key);
      }
    }
  }

  const decisions = [];
  for (const p of input) {
    for (const e of p.emails || []) {
      if (!e.thread_id || e.confidence === 'low' || !e.confidence) continue;   // skip low / unscored
      const highSet = threadHigh.get(e.thread_id) || new Set();
      let status, ambiguous_phones = [];

      if (e.confidence === 'high') {
        if (highSet.size === 1) {
          status = 'confirmed';                     // unique high owner → no doubt
        } else {
          status = 'proposed';                      // several phones strong for one thread → which client?
          ambiguous_phones = [...highSet].filter(k => k !== p.phone_key);
        }
      } else {                                       // medium
        if (highSet.size >= 1 && !highSet.has(p.phone_key)) continue; // thread owned by a high phone → noise
        status = 'proposed';                         // medium, no strong owner → ask operator
      }

      decisions.push({
        gmail_thread_id: e.thread_id,
        phone_key:       p.phone_key,
        client_name:     p.client_name || null,          // номер's primary юр.лицо
        subject_name:    e.subject_name || null,          // юр.лицо из ТЕМЫ этого письма (может отличаться)
        sheet_rows:      p.sheet_rows || [],
        order_id:        p.order_id || null,
        subject:         e.subject || null,
        from_addr:       e.from || null,
        to_addr:         e.to || null,
        last_message_at: e.at ? new Date(e.at) : null,
        confidence:      e.confidence,
        signals:         e.signals || [],
        ambiguous_phones,
        status,
        source:          'auto',
      });
    }
  }
  return decisions;
}

// ─── DB: idempotent upsert of one link — NEVER overwrites an operator's decision ──────────────
async function upsertLink(d, deps = {}) {
  const { EmailLink } = deps.models || require('../models');
  const existing = await EmailLink.findOne({ gmail_thread_id: d.gmail_thread_id, phone_key: d.phone_key }).lean();
  if (existing && existing.source === 'operator') return { outcome: 'operator_locked' };
  await EmailLink.updateOne(
    { gmail_thread_id: d.gmail_thread_id, phone_key: d.phone_key },
    { $set: { ...d, reverified_at: new Date() } },
    { upsert: true },
  );
  return { outcome: existing ? 'updated' : 'created', status: d.status };
}

// ─── DB+network: scan phones' lab correspondence and record links ─────────────────────────────
// deps.phones lets a caller / test pass the phone set; otherwise we take launched «Декларация»
// orders (a lab email only exists once the order was sent). limit caps phones per run.
async function scan({ limit = 15, deps = {} } = {}) {
  const clientEmails = deps.clientEmails || require('./taskInboxService').clientEmails;
  const lookupOrders = deps.lookupOrdersByPhone || require('./whatsappMatchService').lookupOrdersByPhone;

  let phones = deps.phones;
  if (!phones) phones = await launchedPhones(deps);
  phones = [...new Set(phones.map(p => String(p)).filter(Boolean))].slice(0, limit);

  const input = [];
  for (const phone of phones) {
    let deep, orders;
    try { deep = await clientEmails(phone, deps); } catch (_) { deep = { emails: [] }; }
    try { orders = await lookupOrders(phone, deps); } catch (_) { orders = { results: [], last_declaration_row: null }; }
    const last = orders.last_declaration_row || null;
    input.push({
      phone_key:   matchKey(phone),
      client_name: (last && last.client) || (orders.results[0] && orders.results[0].client) || (deep.searched_names || [])[0] || null,
      sheet_rows:  (orders.results || []).map(r => r.row).filter(Boolean),
      order_id:    (last && last.order_id) || null,
      emails:      (deep.emails || []).map(e => ({
        thread_id: e.thread_id, subject: e.subject, from: e.from, to: e.to,
        at: e.at, confidence: e.confidence, signals: e.signals, subject_name: e.subject_name,
      })),
    });
  }

  const decisions = decideLinks(input);
  const out = { scanned_phones: phones.length, confirmed: 0, proposed: 0, operator_locked: 0 };
  for (const d of decisions) {
    const r = await upsertLink(d, deps);
    if (r.outcome === 'operator_locked') out.operator_locked++;
    else if (d.status === 'confirmed') out.confirmed++;
    else if (d.status === 'proposed') out.proposed++;
  }
  return out;
}

// Launched «Декларация» phones (status set and ≠ «Запустить») — the orders that могли уйти в лабораторию.
async function launchedPhones(deps = {}) {
  const readDecl = deps.readDeclaration || require('./workQueueService').defaultReadDeclaration;
  const DECL_PHONE_COL = 9, DECL_STATUS_COL = 13;
  const rows = await readDecl();
  const out = [];
  for (const r of rows || []) {
    const status = String((r || [])[DECL_STATUS_COL] || '').trim();
    const phone = (r || [])[DECL_PHONE_COL];
    if (phone && status && status !== 'Запустить') out.push(String(phone));
  }
  return out;
}

// ─── DB: fast lookups (both directions) ───────────────────────────────────────────────────────
async function linksForPhone(phone, { status = 'confirmed', deps = {} } = {}) {
  const { EmailLink } = deps.models || require('../models');
  const key = matchKey(phone);
  if (!key) return [];
  const q = { phone_key: key };
  if (status) q.status = status;
  return EmailLink.find(q).sort({ last_message_at: -1 }).lean();
}
async function linksForThread(gmail_thread_id, deps = {}) {
  const { EmailLink } = deps.models || require('../models');
  if (!gmail_thread_id) return [];
  return EmailLink.find({ gmail_thread_id }).sort({ updated_at: -1 }).lean();
}
async function proposals({ limit = 50, deps = {} } = {}) {
  const { EmailLink } = deps.models || require('../models');
  return EmailLink.find({ status: 'proposed' }).sort({ updated_at: -1 }).limit(Math.min(Number(limit) || 50, 300)).lean();
}

// ─── DB: operator decisions (authoritative — locks the link against re-scans) ─────────────────
async function setByOperator(gmail_thread_id, phone_key, status, operator, deps = {}) {
  const { EmailLink } = deps.models || require('../models');
  if (!gmail_thread_id || !phone_key) return { ok: false, reason: 'need_thread_and_phone' };
  const res = await EmailLink.updateOne(
    { gmail_thread_id, phone_key },
    { $set: { status, source: 'operator', set_by: operator || 'operator', reverified_at: new Date() } },
    { upsert: true },
  );
  return { ok: true, status, matched: res.matchedCount, upserted: !!res.upsertedCount };
}
const confirm = (gmail_thread_id, phone_key, operator, deps) => setByOperator(gmail_thread_id, phone_key, 'confirmed', operator, deps);
const reject  = (gmail_thread_id, phone_key, operator, deps) => setByOperator(gmail_thread_id, phone_key, 'rejected',  operator, deps);

// ─── DB: operator CORRECTS a wrong link — reassign the letter to the right WhatsApp number ─────
// «Это письмо не клиента A, а клиента B». Rejects (T, from_phone) as operator (locked → a re-scan
// never re-proposes the wrong pair), and confirms (T, to_phone) as operator, carrying the letter
// snapshot over and resolving the correct client/rows from «Декларация». from_phone is optional
// (may be reassigning a bare proposal). Both writes are operator-authoritative.
async function relink({ gmail_thread_id, from_phone, to_phone, operator } = {}, deps = {}) {
  const { EmailLink } = deps.models || require('../models');
  const toKey = to_phone ? matchKey(to_phone) : null;
  if (!gmail_thread_id || !toKey) return { ok: false, reason: 'need_thread_and_to_phone' };
  const fromKey = from_phone ? matchKey(from_phone) : null;

  // Snapshot the letter from the wrong link (if given) and reject that pair.
  let snap = null;
  if (fromKey && fromKey !== toKey) {
    snap = await EmailLink.findOne({ gmail_thread_id, phone_key: fromKey }).lean();
    await EmailLink.updateOne(
      { gmail_thread_id, phone_key: fromKey },
      { $set: { status: 'rejected', source: 'operator', set_by: operator || 'operator', reverified_at: new Date() } },
      { upsert: true },
    );
  }
  if (!snap) snap = await EmailLink.findOne({ gmail_thread_id }).lean();   // any existing snapshot of this letter

  // Resolve the correct number's client/rows (best-effort — the link stands even if this fails).
  let client_name = null, sheet_rows = [], order_id = null;
  try {
    const lookup = deps.lookupOrdersByPhone || require('./whatsappMatchService').lookupOrdersByPhone;
    const o = await lookup(to_phone, deps);
    const last = o.last_declaration_row || null;
    client_name = (last && last.client) || (o.results[0] && o.results[0].client) || null;
    sheet_rows  = (o.results || []).map(r => r.row).filter(Boolean);
    order_id    = (last && last.order_id) || null;
  } catch (_) { /* keep the reassignment even without a Declaration lookup */ }

  const set = {
    gmail_thread_id, phone_key: toKey, status: 'confirmed', source: 'operator',
    set_by: operator || 'operator', client_name, sheet_rows, order_id, reverified_at: new Date(),
  };
  if (snap) { set.subject = snap.subject; set.subject_name = snap.subject_name; set.from_addr = snap.from_addr; set.to_addr = snap.to_addr; set.last_message_at = snap.last_message_at; }
  await EmailLink.updateOne({ gmail_thread_id, phone_key: toKey }, { $set: set }, { upsert: true });
  return { ok: true, rejected: fromKey || null, confirmed: toKey };
}

module.exports = {
  decideLinks, upsertLink, scan, launchedPhones,
  linksForPhone, linksForThread, proposals,
  setByOperator, confirm, reject, relink,
};
