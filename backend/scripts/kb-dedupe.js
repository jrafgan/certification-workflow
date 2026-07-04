#!/usr/bin/env node
'use strict';

// scripts/kb-dedupe.js — find and remove OLD entries in the Knowledge Base that
// DUPLICATE newer ones by meaning ("старые записи, дублирующие по смыслу").
//
// The operator Master-KB seeder already supersedes old operator versions on each run
// (knowledgeBaseService.seedOperatorKnowledge). What it does NOT catch is semantic overlap
// across sources — e.g. a YouTube-extracted approved entry that says the same thing as an
// operator entry, or two approved entries left over from different ingests. This tool finds
// those near-duplicate groups and keeps the best one.
//
// SAFETY (gated by design):
//   • default            → DRY RUN. Prints every duplicate group; changes NOTHING.
//   • --apply            → act on the candidates (still keeps one entry per group).
//   • --hard             → with --apply, DELETE the old duplicates (irreversible).
//                          Without --hard, --apply marks them status:'superseded' (reversible;
//                          the agent already ignores non-approved entries).
//   • --include-pending  → also consider pending entries (default: approved only).
//   • --threshold=0.85   → token-overlap similarity cutoff for "duplicate by meaning".
//
// KEEPER within a group (the one we keep) is chosen by authority, then freshness:
//   source 'operator' > others  →  status 'approved' > 'pending'  →  newest date.
//
// Reads/writes ONLY the kb_entries replica. No WhatsApp / Declaration / Gmail side effects.
//
// Usage (run where the DB lives, e.g. the VPS):
//   node scripts/kb-dedupe.js                    # dry run — see what would go
//   node scripts/kb-dedupe.js --apply            # supersede old duplicates (reversible)
//   node scripts/kb-dedupe.js --apply --hard     # delete old duplicates (irreversible)

require('dotenv').config();
const mongoose = require('mongoose');
const { KbEntry } = require('../src/models/KbEntry');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const APPLY   = has('--apply');
const HARD    = has('--hard');
const PENDING = has('--include-pending');
const THRESHOLD = (() => {
  const a = args.find(x => x.startsWith('--threshold='));
  const v = a ? parseFloat(a.split('=')[1]) : 0.85;
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.85;
})();

// ─── similarity helpers ───────────────────────────────────────────────────────
// Normalize for comparison: lowercase, drop punctuation, collapse whitespace. Digits are
// KEPT (prices/timelines differ by number), so "15000" vs "18000" won't merge.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokenSet(s) { return new Set(normalize(s).split(' ').filter(Boolean)); }
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// "Duplicate by meaning": identical normalized text, OR high token overlap, OR one text's
// tokens are (almost) fully contained in the other (a shorter restatement of the same fact).
function isDup(x, y) {
  if (x.norm && x.norm === y.norm) return true;
  const j = jaccard(x.tokens, y.tokens);
  if (j >= THRESHOLD) return true;
  const [small, big] = x.tokens.size <= y.tokens.size ? [x.tokens, y.tokens] : [y.tokens, x.tokens];
  let inter = 0; for (const t of small) if (big.has(t)) inter++;
  const containment = inter / small.size;
  return containment >= 0.9 && small.size >= 4;
}

// Authority/freshness ranking — higher wins (is kept).
function rank(e) {
  const src = e.source === 'operator' ? 2 : 1;
  const st  = e.status === 'approved' ? 2 : 1;
  const when = new Date(e.source_date || e.updated_at || e.created_at || 0).getTime() || 0;
  return { src, st, when };
}
function keeperFirst(a, b) {
  const ra = rank(a), rb = rank(b);
  return (rb.src - ra.src) || (rb.st - ra.st) || (rb.when - ra.when);
}

function excerpt(s, n = 90) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

(async () => {
  if (!process.env.MONGODB_URI) { console.error('[kb-dedupe] MONGODB_URI not set.'); process.exit(1); }
  try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }); }
  catch (e) { console.error('[kb-dedupe] mongo connection failed:', e.message); process.exit(1); }

  const statuses = PENDING ? ['approved', 'pending'] : ['approved'];
  const docs = await KbEntry.find({ status: { $in: statuses } })
    .select('category type text source source_video_id status source_date created_at updated_at')
    .lean();

  // Precompute normalized text + token sets once.
  const items = docs.map(d => ({ ...d, norm: normalize(d.text), tokens: tokenSet(d.text) }));

  // Group near-duplicates, ONLY within the same category (duplicates by meaning are same topic;
  // this avoids cross-topic false merges). Simple union-find over pairwise isDup.
  const parent = new Map(items.map(i => [String(i._id), String(i._id)]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { parent.set(find(a), find(b)); };

  const byCat = new Map();
  for (const it of items) { const k = it.category || '?'; (byCat.get(k) || byCat.set(k, []).get(k)).push(it); }
  for (const list of byCat.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (isDup(list[i], list[j])) union(String(list[i]._id), String(list[j]._id));
      }
    }
  }

  // Collect groups with >1 member.
  const groups = new Map();
  for (const it of items) { const r = find(String(it._id)); (groups.get(r) || groups.set(r, []).get(r)).push(it); }
  const dupGroups = [...groups.values()].filter(g => g.length > 1);

  if (!dupGroups.length) {
    console.log(`[kb-dedupe] No duplicate-by-meaning groups found among ${items.length} ${statuses.join('/')} entries (threshold=${THRESHOLD}). Nothing to do.`);
    await mongoose.disconnect().catch(() => {});
    return;
  }

  const toRemove = [];
  console.log(`\n[kb-dedupe] ${dupGroups.length} duplicate group(s) among ${items.length} ${statuses.join('/')} entries (threshold=${THRESHOLD}):\n`);
  dupGroups.forEach((g, n) => {
    g.sort(keeperFirst);
    const keep = g[0]; const drop = g.slice(1);
    console.log(`── Group ${n + 1} [${keep.category}] ───────────────────────────────`);
    console.log(`  KEEP  (${keep.source}/${keep.status})  ${excerpt(keep.text)}`);
    for (const d of drop) {
      console.log(`  OLD   (${d.source}/${d.status})  ${excerpt(d.text)}   id=${d._id}`);
      toRemove.push(d);
    }
    console.log('');
  });

  console.log(`[kb-dedupe] Keepers: ${dupGroups.length} · Old duplicates: ${toRemove.length}`);

  if (!APPLY) {
    console.log('\n[kb-dedupe] DRY RUN — nothing changed. Re-run with:');
    console.log('   --apply           → mark old duplicates as superseded (reversible)');
    console.log('   --apply --hard    → DELETE old duplicates (irreversible)');
    await mongoose.disconnect().catch(() => {});
    return;
  }

  const ids = toRemove.map(d => d._id);
  if (HARD) {
    const res = await KbEntry.deleteMany({ _id: { $in: ids } });
    console.log(`\n[kb-dedupe] DELETED ${res.deletedCount} old duplicate entrie(s).`);
  } else {
    const res = await KbEntry.updateMany({ _id: { $in: ids } }, { $set: { status: 'superseded' } });
    console.log(`\n[kb-dedupe] SUPERSEDED ${res.modifiedCount} old duplicate entrie(s) (reversible — agent now ignores them).`);
  }

  await mongoose.disconnect().catch(() => {});
})().catch(err => { console.error('[kb-dedupe] fatal:', err.message); process.exit(1); });
