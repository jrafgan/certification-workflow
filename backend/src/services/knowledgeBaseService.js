'use strict';

// services/knowledgeBaseService.js — DB-backed Knowledge Base builder + review gating.
//
// Pipeline: enumerate channel videos (read-only) → fetch transcript → extract (pure)
// → PERSIST as pending, needs_review entries. Nothing is ever auto-activated.
//
// GATING (hard):
//   • ingest writes only the KB replica (kb_videos, kb_entries) — never the
//     Declaration, Gmail, or WhatsApp.
//   • every entry lands status:'pending', needs_review:true.
//   • only decideEntry('approve') flips an entry to 'approved'; getApprovedKnowledge
//     returns approved-only — the sole knowledge the WhatsApp agent may use.
//   • operator knowledge overrides: reject / supersede are always available, and
//     unapproved YouTube knowledge can never reach the agent.

const extraction = require('./knowledgeExtractionService');

function normKey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200); }
function dedupeKey(category, type, videoId, text) { return `${category}|${type}|${videoId || 'novid'}|${normKey(text)}`; }

// ─── Ingest one video (read-only toward the world) ─────────────────────────────
// ingestVideo(video, transcript, deps) → { video, extraction, created, skipped }.
async function ingestVideo(video, transcript, deps = {}) {
  const KbVideo = deps.KbVideo || require('../models/KbVideo').KbVideo;
  const KbEntry = deps.KbEntry || require('../models/KbEntry').KbEntry;

  const ex = extraction.buildVideoExtraction({ video, transcript: transcript || {} });
  const hasTranscript = !!(transcript && transcript.text && transcript.text.trim());

  await KbVideo.findOneAndUpdate(
    { video_id: video.video_id },
    {
      channel: video.channel || process.env.KB_CHANNEL_HANDLE || '@dokumenty_pro',
      video_id: video.video_id,
      title: video.title,
      url: video.url,
      published_at: video.published_at || undefined,
      transcript_status: hasTranscript ? 'available' : 'missing',
      language: transcript && transcript.language,
      summary: ex.summary,
      confidence: ex.confidence,
      questions: ex.questions,
      entry_count: ex.entries.length,
      possibly_outdated_count: ex.entries.filter(e => e.possibly_outdated).length,
      extracted_at: new Date(),
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  let created = 0, skipped = 0;
  for (const e of ex.entries) {
    const dedupe_key = dedupeKey(e.category, e.type, video.video_id, e.text);
    if (await KbEntry.exists({ dedupe_key })) { skipped++; continue; }
    try {
      await KbEntry.create({
        category: e.category,
        type: e.type,
        text: e.text,
        value: e.value,
        source_video_id: video.video_id,
        source_video_title: video.title,
        source_date: video.published_at || undefined,
        confidence: e.confidence,
        needs_review: true,
        possibly_outdated: !!e.possibly_outdated,
        status: 'pending',
        dedupe_key,
      });
      created++;
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'E11000')) skipped++;
      else throw err;
    }
  }

  return { video_id: video.video_id, extraction: ex, created, skipped };
}

// ingestChannel(deps) — enumerate + ingest the whole channel. deps may carry the
// youtubeChannelClient seams (videos/transcripts/apiKey/transcriptFetcher).
async function ingestChannel(deps = {}) {
  const yt = deps.youtubeChannelClient || require('../integrations/youtubeChannelClient');
  const enumRes = await yt.enumerateVideos(deps);
  if (!enumRes.ok) return { ok: false, reason: enumRes.reason, channel: enumRes.channel, ingested: 0 };

  const results = [];
  for (const v of enumRes.videos) {
    const t = await yt.fetchTranscript(v.video_id, deps);
    const transcript = t.ok ? { text: t.text, language: t.language } : { text: '' };
    results.push(await ingestVideo({ ...v, channel: enumRes.channel }, transcript, deps));
  }
  return { ok: true, channel: enumRes.channel, ingested: results.length, results };
}

// ─── Operator-authored knowledge seed (highest-priority source) ─────────────────
// Persists an operator master KB (e.g. knowledge/operatorMasterKbV2.js) as APPROVED,
// source:'operator' entries — directly usable by the WhatsApp agent. Entries flagged
// hold_for_review are seeded PENDING instead (a known conflict awaiting an operator
// decision). Idempotent + refreshing on dedupe_key. Supersedes prior operator versions.
async function seedOperatorKnowledge(kb, deps = {}) {
  const KbEntry = deps.KbEntry || require('../models/KbEntry').KbEntry;

  // Supersede entries from older operator versions (different source tag) so the
  // active set always reflects the latest approved version.
  await KbEntry.updateMany(
    { source: 'operator', source_video_id: { $ne: kb.SOURCE }, status: 'approved' },
    { $set: { status: 'superseded' } }
  );

  let approved = 0, held = 0;
  const keys = [];
  for (const e of kb.entries) {
    const status = e.hold_for_review ? 'pending' : 'approved';
    const dedupe_key = `${e.category}|${e.type}|${kb.SOURCE}|${normKey(e.text)}`;
    keys.push(dedupe_key);
    await KbEntry.findOneAndUpdate(
      { dedupe_key },
      {
        category: e.category, type: e.type, text: e.text, value: e.value,
        source: 'operator', source_video_id: kb.SOURCE, source_video_title: kb.TITLE, source_date: new Date(),
        confidence: e.confidence || 'HIGH',
        needs_review: status !== 'approved',
        possibly_outdated: !!e.possibly_outdated,
        status, review_note: e.note, dedupe_key,
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    if (status === 'approved') approved++; else held++;
  }

  // Reconcile: supersede any same-version operator entries no longer in the seed
  // (e.g. an entry whose text was edited → new dedupe_key) so the live set matches
  // the module exactly and stale pending/approved rows don't linger.
  const recon = await KbEntry.updateMany(
    { source: 'operator', source_video_id: kb.SOURCE, dedupe_key: { $nin: keys }, status: { $ne: 'superseded' } },
    { $set: { status: 'superseded' } }
  );

  return { version: kb.VERSION, source: kb.SOURCE, approved, held, total: kb.entries.length, superseded: recon.modifiedCount || 0 };
}

// ─── Review gating ──────────────────────────────────────────────────────────────
async function listForReview({ category, limit = 100 } = {}, deps = {}) {
  const KbEntry = deps.KbEntry || require('../models/KbEntry').KbEntry;
  const q = { status: 'pending' };
  if (category) q.category = category;
  return KbEntry.find(q).sort({ possibly_outdated: -1, created_at: 1 }).limit(limit).lean();
}

// decideEntry(id, decision, opts) — approve | reject | supersede. Only 'approve'
// activates an entry (status 'approved', needs_review false). Operator override.
async function decideEntry(entryId, decision, { decidedBy = 'operator', note } = {}, deps = {}) {
  const KbEntry    = deps.KbEntry || require('../models/KbEntry').KbEntry;
  const errorUtils = require('../utils/errorUtils');

  const entry = await KbEntry.findById(entryId);
  if (!entry) throw errorUtils.notFoundError('KB entry not found');

  if (decision === 'approve') {
    if (entry.status !== 'pending') throw errorUtils.conflictError(`Entry is "${entry.status}", only pending can be approved`);
    entry.status = 'approved'; entry.needs_review = false;
  } else if (decision === 'reject') {
    if (!['pending', 'approved'].includes(entry.status)) throw errorUtils.conflictError(`Entry "${entry.status}" cannot be rejected`);
    entry.status = 'rejected';
  } else if (decision === 'supersede') {
    entry.status = 'superseded';
  } else {
    throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject|supersede)`);
  }
  entry.decided_by = decidedBy;
  entry.decided_at = new Date();
  if (note) entry.review_note = note;
  await entry.save();
  return entry;
}

// getApprovedKnowledge(category?) — the ONLY knowledge the WhatsApp agent may use.
// Returns approved-only entries. (Wiring it into the WhatsApp response path is a
// separate, future, gated step — not done here.)
async function getApprovedKnowledge(category, deps = {}) {
  const KbEntry = deps.KbEntry || require('../models/KbEntry').KbEntry;
  const q = { status: 'approved' };
  if (category) q.category = category;
  return KbEntry.find(q).sort({ category: 1 }).lean();
}

// getBusinessSetting(key) — operator-editable business config stored in the KB as an
// APPROVED entry with value.kind==='business_setting'. Returns the value object (e.g.
// { kind, key, url }) or null when unset. The single source of truth for operator-tunable
// values like application_form_url — never hardcoded in code.
async function getBusinessSetting(key, deps = {}) {
  const KbEntry = deps.KbEntry || require('../models/KbEntry').KbEntry;
  const e = await KbEntry.findOne({ status: 'approved', 'value.kind': 'business_setting', 'value.key': key }).lean();
  return e ? e.value : null;
}

// ─── Reports (the four deliverables) ──────────────────────────────────────────
async function buildReports(deps = {}) {
  const KbVideo = deps.KbVideo || require('../models/KbVideo').KbVideo;
  const KbEntry = deps.KbEntry || require('../models/KbEntry').KbEntry;
  const { KB_CATEGORIES } = require('../models/KbEntry');

  const videos  = await KbVideo.find({}).sort({ published_at: -1 }).lean();
  const entries = await KbEntry.find({}).lean();
  const byVideo = {};
  for (const e of entries) (byVideo[e.source_video_id] = byVideo[e.source_video_id] || []).push(e);

  // 1) Video inventory
  const inventory = videos.map(v => ({
    video_id: v.video_id, title: v.title, published_at: v.published_at, url: v.url,
    transcript_status: v.transcript_status, entry_count: v.entry_count,
    possibly_outdated_count: v.possibly_outdated_count,
  }));

  // 2) Knowledge extraction report (per video)
  const pick = (arr, type) => arr.filter(e => e.type === type).map(e => ({
    text: e.text, value: e.value, confidence: e.confidence, status: e.status,
    needs_review: e.needs_review, possibly_outdated: e.possibly_outdated,
  }));
  const extractionReport = videos.map(v => {
    const es = byVideo[v.video_id] || [];
    return {
      video_id: v.video_id, title: v.title, published_at: v.published_at,
      summary: v.summary, confidence: v.confidence,
      facts: pick(es, 'fact'), rules: pick(es, 'rule'),
      prices: pick(es, 'price'), timelines: pick(es, 'timeline'),
      possibly_outdated: (v.possibly_outdated_count || 0) > 0,
      questions: v.questions || [],
    };
  });

  // 3) Outdated-information report
  const outdatedEntries = entries.filter(e => e.possibly_outdated);
  const outdatedByVideo = {};
  for (const e of outdatedEntries) {
    const k = e.source_video_id || 'unknown';
    (outdatedByVideo[k] = outdatedByVideo[k] || { video_id: k, video_title: e.source_video_title, items: [] })
      .items.push({ category: e.category, type: e.type, text: e.text, status: e.status });
  }
  const outdatedReport = {
    total_outdated_entries: outdatedEntries.length,
    by_video: Object.values(outdatedByVideo),
  };

  // 4) Proposed Knowledge Base structure (taxonomy + live counts + per-rule schema)
  const counts = {};
  for (const c of KB_CATEGORIES) counts[c] = { pending: 0, approved: 0, rejected: 0, superseded: 0, total: 0 };
  for (const e of entries) {
    const c = counts[e.category]; if (!c) continue;
    c[e.status] = (c[e.status] || 0) + 1; c.total++;
  }
  const structure = {
    categories: KB_CATEGORIES,
    per_rule_fields: ['source_video', 'source_date', 'rule_text', 'confidence', 'needs_review', 'status'],
    activation_rule: 'Only status:approved entries are usable by the WhatsApp agent. Operator knowledge overrides; nothing auto-activates.',
    counts,
  };

  return { inventory, extractionReport, outdatedReport, structure };
}

module.exports = {
  dedupeKey,
  ingestVideo,
  ingestChannel,
  seedOperatorKnowledge,
  listForReview,
  decideEntry,
  getApprovedKnowledge,
  getBusinessSetting,
  buildReports,
};
