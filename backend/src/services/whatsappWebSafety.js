'use strict';

// services/whatsappWebSafety.js — anti-ban SAFETY LAYER for the unofficial whatsapp-web.js
// channel (integrations/whatsappWebClient.js + wa-web-server.js).
//
// ⚠️ HONEST FRAMING: nothing hides the whatsapp-web.js protocol fingerprint — Meta can detect
// the unofficial client regardless of timing tricks. There is NO "ban bypass". The ONLY thing
// that actually lowers ban risk is BEHAVING LIKE A LEGITIMATE HUMAN BUSINESS, which is exactly
// what this layer enforces. It does not evade detection; it prevents tripping the spam
// heuristics that cause bans (real triggers per all sources: messaging people who didn't write
// you, high block/report ratio, bulk/identical bursts, robotic fixed-interval sending).
//
// Tuned for THIS operator's profile: mostly REACTIVE (reply to clients who wrote first), with
// RARE cold first-contact. So:
//   • Reactive replies (open conversation) → allowed within human-paced rate caps.
//   • Cold sends (no recent inbound) → NOT blocked, but kept RARE: a strict small daily cap +
//     extra spacing (cold outreach is the #1 ban trigger, so it stays bounded).
//   • Bulk/identical fan-out → blocked.
// All thresholds are env-tunable. Rate math is PURE and exported for testing.

const { matchKey } = require('../utils/phoneUtils');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v == null ? d : String(v).toLowerCase() !== 'false');

function cfg() {
  return {
    // Strict mode: block ALL cold sends (only reply to people who wrote first). Default OFF
    // because the operator occasionally messages first — we cap that instead of blocking.
    reactiveOnly: bool(process.env.SAFE_REACTIVE_ONLY, false),
    windowHours:  num(process.env.SAFE_WINDOW_HOURS, 24),   // inbound recency = "open conversation"
    minDelayMs:   num(process.env.SAFE_MIN_DELAY_MS, 4000),
    maxDelayMs:   num(process.env.SAFE_MAX_DELAY_MS, 9000),
    perHour:      num(process.env.SAFE_MAX_PER_HOUR, 40),
    perDay:       num(process.env.SAFE_MAX_PER_DAY, 200),
    coldPerDay:   num(process.env.SAFE_COLD_MAX_PER_DAY, 10), // rare cold first-contacts only
    coldDelayMult: num(process.env.SAFE_COLD_DELAY_MULT, 3),  // cold sends get extra spacing
    pauseEvery:   num(process.env.SAFE_PAUSE_EVERY, 20),
    pauseMs:      num(process.env.SAFE_PAUSE_MS, 300000),     // 5 min breather
    dupFanout:    num(process.env.SAFE_DUP_FANOUT, 5),        // same text → max distinct recipients / window
    dupWindowMs:  num(process.env.SAFE_DUP_WINDOW_MS, 600000),// 10 min
  };
}

// In-memory rolling state (per process). Reset on restart — fine, caps are about bursts.
const state = { sends: [], cold: [], lastSendAt: 0, recentByText: new Map() };

// ─── Pure: randomized human-like pacing delay ─────────────────────────────────
function pacingDelay(c = cfg(), rnd = Math.random) {
  return Math.round(c.minDelayMs + rnd() * Math.max(0, c.maxDelayMs - c.minDelayMs));
}

// ─── Pure: rate-cap decision over the rolling send log ────────────────────────
// checkRate(sends, now, c, lastSendAt) → { allowed, reason?, waitMs? }.
function checkRate(sends, now, c = cfg(), lastSendAt = 0) {
  const hourAgo = now - 3600_000, dayAgo = now - 86_400_000;
  const inHour = sends.filter(t => t >= hourAgo).length;
  const inDay  = sends.filter(t => t >= dayAgo).length;
  if (inDay  >= c.perDay)  return { allowed: false, reason: 'daily_cap',  waitMs: null };
  if (inHour >= c.perHour) return { allowed: false, reason: 'hourly_cap', waitMs: hourAgo + 3600_000 - now };
  if (c.pauseEvery > 0 && sends.length > 0 && sends.length % c.pauseEvery === 0 && (now - lastSendAt) < c.pauseMs) {
    return { allowed: false, reason: 'breather', waitMs: c.pauseMs - (now - lastSendAt) };
  }
  if (lastSendAt && (now - lastSendAt) < c.minDelayMs) {
    return { allowed: false, reason: 'min_gap', waitMs: c.minDelayMs - (now - lastSendAt) };
  }
  return { allowed: true };
}

// ─── DB-backed gate: should this outbound be allowed right now? ────────────────
// gate({ to, body }, deps) → { allow, delayMs?, cold?, reason? }. deps: { WhatsAppMessage?, now?, rnd? }.
async function gate({ to, body } = {}, deps = {}) {
  const c = cfg();
  const now = deps.now || Date.now();
  const rnd = deps.rnd || Math.random;
  const key = matchKey(to);
  const dayAgo = now - 86_400_000;

  // Is this a COLD send (no recent inbound from this contact)?
  let cold = true;
  if (key) {
    const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
    const since = new Date(now - c.windowHours * 3600_000);
    const open = await WhatsAppMessage.exists({ direction: 'inbound', phone_key: key, received_at: { $gte: since } });
    cold = !open;
  }

  if (cold) {
    if (c.reactiveOnly) return { allow: false, reason: 'no_open_conversation' }; // strict mode
    const coldInDay = state.cold.filter(t => t >= dayAgo).length;
    if (coldInDay >= c.coldPerDay) return { allow: false, reason: 'cold_daily_cap', cold: true };
  }

  // No bulk/identical fan-out in a short window.
  const sig = String(body || '').trim().slice(0, 200);
  const rec = state.recentByText.get(sig);
  if (rec) {
    const fresh = rec.filter(r => r.at >= now - c.dupWindowMs);
    const distinct = new Set(fresh.map(r => r.key));
    if (!distinct.has(key) && distinct.size >= c.dupFanout) return { allow: false, reason: 'bulk_identical_blocked' };
  }

  // Rate caps + min gap.
  const r = checkRate(state.sends, now, c, state.lastSendAt);
  if (!r.allowed) return { allow: false, reason: r.reason, waitMs: r.waitMs, cold };

  const delayMs = pacingDelay(c, rnd) * (cold ? Math.max(1, c.coldDelayMult) : 1);
  return { allow: true, delayMs, cold };
}

// recordSend(to, body, { now, cold }) — call AFTER a successful send to update rolling state.
function recordSend(to, body, opts = {}) {
  const now = opts.now || Date.now();
  const c = cfg();
  const key = matchKey(to);
  const dayAgo = now - 86_400_000;
  state.sends.push(now);
  state.lastSendAt = now;
  state.sends = state.sends.filter(t => t >= dayAgo);
  if (opts.cold) { state.cold.push(now); state.cold = state.cold.filter(t => t >= dayAgo); }
  const sig = String(body || '').trim().slice(0, 200);
  const arr = (state.recentByText.get(sig) || []).filter(r => r.at >= now - c.dupWindowMs);
  arr.push({ key, at: now });
  state.recentByText.set(sig, arr);
}

function _resetState() { state.sends = []; state.cold = []; state.lastSendAt = 0; state.recentByText = new Map(); }

module.exports = { gate, recordSend, checkRate, pacingDelay, cfg, _resetState };
