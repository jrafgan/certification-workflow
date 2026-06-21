#!/usr/bin/env node
'use strict';

// scripts/kb-build.js — Certification Knowledge Base builder (READ-ONLY research).
//
// Enumerates the Dokumenty.pro YouTube channel, extracts candidate knowledge, and
// produces the four deliverables: (1) video inventory, (2) knowledge extraction
// report, (3) outdated-information report, (4) proposed KB structure. NOTHING is
// activated: every entry is pending + needs_review. No WhatsApp/Declaration/Gmail writes.
//
// Usage:
//   node scripts/kb-build.js --simulate   # offline: runs the pipeline on built-in
//                                          # fixtures and prints all four deliverables.
//   YOUTUBE_API_KEY=... node scripts/kb-build.js
//        # live enumeration via the YouTube Data API. Transcripts require a
//        # transcriptFetcher (yt-dlp/timedtext) — wire one in deps; without it videos
//        # are still inventoried (transcript_status: missing).

require('dotenv').config();
const mongoose  = require('mongoose');
const extraction = require('../src/services/knowledgeExtractionService');
const kbService  = require('../src/services/knowledgeBaseService');

const SIMULATE = process.argv.includes('--simulate');

// ── Built-in fixtures (synthetic Dokumenty.pro-style transcripts, RU) ──
const FIXTURES = {
  videos: [
    { video_id: 'vid0000001', title: 'Чем отличается сертификат от декларации соответствия', published_at: '2021-03-10' },
    { video_id: 'vid0000002', title: 'Как рассчитать количество позиций (ПИ) для декларации', published_at: '2024-09-01' },
    { video_id: 'vid0000003', title: 'Частые вопросы по сертификации', published_at: '2020-06-15' },
  ],
  transcripts: {
    vid0000001: 'Здравствуйте! Сегодня разберём чем отличается сертификат соответствия от декларации о соответствии. Декларация о соответствии оформляется на продукцию, которая входит в технический регламент. Сертификат соответствия требуется для более рискованной продукции. Чтобы определить нужен ли сертификат или декларация, нужно знать код ТН ВЭД вашего товара. Код ТН ВЭД 1905 90 определяет кондитерские изделия. Стоимость декларации составляет 15000 сом. Оформление занимает 5 рабочих дней. Для испытаний нужно предоставить образцы продукции в лабораторию.',
    vid0000002: 'В этом видео расскажу как рассчитать количество позиций, или ПИ, для декларации. Каждое наименование продукции это отдельная позиция. Если у вас три вида продукции, то это три позиции. Стоимость зависит от количества позиций, одна позиция стоит 8000 рублей. Лаборатория проводит испытания образцов в течение 10 дней. Клиенту нужно объяснить что предоплата составляет 50 процентов.',
    vid0000003: 'Отвечаю на часто задаваемые вопросы по сертификации. Вопрос: сколько действует декларация? Декларация действует до 5 лет. Вопрос: можно ли оформить без образцов? Нет, образцы обязательны для испытаний. Раньше правила были другие, сейчас всё изменилось. Цена сертификата сейчас 25000 сом.',
  },
};

function hr(c = '─') { console.log(c.repeat(70)); }

function printReports({ inventory, extractionReport, outdatedReport, structure }) {
  hr('=');
  console.log('DELIVERABLE 1 — VIDEO INVENTORY');
  hr('=');
  for (const v of inventory) {
    console.log(`• ${v.title}`);
    console.log(`    id=${v.video_id}  published=${v.published_at ? new Date(v.published_at).toISOString().slice(0,10) : '?'}  transcript=${v.transcript_status}  entries=${v.entry_count}  outdated=${v.possibly_outdated_count}`);
  }

  console.log('\n');
  hr('=');
  console.log('DELIVERABLE 2 — KNOWLEDGE EXTRACTION REPORT');
  hr('=');
  for (const r of extractionReport) {
    hr();
    console.log(`VIDEO: ${r.title}  (${r.published_at ? new Date(r.published_at).toISOString().slice(0,10) : '?'})  confidence=${r.confidence}`);
    console.log(`SUMMARY: ${r.summary}`);
    const show = (label, arr) => { if (arr.length) { console.log(`  ${label}:`); arr.forEach(e => console.log(`    - [${e.confidence}${e.possibly_outdated ? '/outdated' : ''}] ${e.value ? JSON.stringify(e.value) + ' :: ' : ''}${e.text}`)); } };
    show('FACTS', r.facts);
    show('BUSINESS RULES', r.rules);
    show('PRICES', r.prices);
    show('TIMELINES', r.timelines);
    if (r.questions.length) { console.log('  QUESTIONS FOR OPERATOR:'); r.questions.forEach(q => console.log(`    ? ${q}`)); }
  }

  console.log('\n');
  hr('=');
  console.log('DELIVERABLE 3 — OUTDATED-INFORMATION REPORT');
  hr('=');
  console.log(`Total possibly-outdated entries: ${outdatedReport.total_outdated_entries}`);
  for (const v of outdatedReport.by_video) {
    console.log(`• ${v.video_title || v.video_id}`);
    v.items.forEach(i => console.log(`    - [${i.category}] ${i.text}`));
  }

  console.log('\n');
  hr('=');
  console.log('DELIVERABLE 4 — PROPOSED KNOWLEDGE BASE STRUCTURE');
  hr('=');
  console.log('Categories:', structure.categories.join(', '));
  console.log('Per-rule fields:', structure.per_rule_fields.join(', '));
  console.log('Activation rule:', structure.activation_rule);
  console.log('Counts by category (pending/approved/rejected/total):');
  for (const [cat, c] of Object.entries(structure.counts)) {
    console.log(`    ${cat.padEnd(22)} ${c.pending}/${c.approved}/${c.rejected}/${c.total}`);
  }
}

// Build the four deliverables purely from in-memory extractions (no DB) — used by
// --simulate so it runs with no external dependencies.
function reportsFromExtractions(videos, extractions) {
  const { KB_CATEGORIES } = require('../src/models/KbEntry');
  const inventory = videos.map((v, i) => ({
    video_id: v.video_id, title: v.title, published_at: v.published_at ? new Date(v.published_at) : null,
    transcript_status: FIXTURES.transcripts[v.video_id] ? 'available' : 'missing',
    entry_count: extractions[i].entries.length,
    possibly_outdated_count: extractions[i].entries.filter(e => e.possibly_outdated).length,
  }));
  const mapE = (e) => ({ text: e.text, value: e.value, confidence: e.confidence, possibly_outdated: e.possibly_outdated, status: 'pending' });
  const extractionReport = extractions.map(ex => ({
    video_id: ex.video_id, title: ex.title, published_at: ex.published_at, summary: ex.summary, confidence: ex.confidence,
    facts: ex.facts.map(mapE), rules: ex.rules.map(mapE), prices: ex.prices.map(mapE), timelines: ex.timelines.map(mapE),
    possibly_outdated: ex.possibly_outdated, questions: ex.questions,
  }));
  const outItems = [];
  for (const ex of extractions) {
    const items = ex.entries.filter(e => e.possibly_outdated).map(e => ({ category: e.category, text: e.text }));
    if (items.length) outItems.push({ video_id: ex.video_id, video_title: ex.title, items });
  }
  const counts = {};
  for (const c of KB_CATEGORIES) counts[c] = { pending: 0, approved: 0, rejected: 0, total: 0 };
  for (const ex of extractions) for (const e of ex.entries) { counts[e.category].pending++; counts[e.category].total++; }
  return {
    inventory, extractionReport,
    outdatedReport: { total_outdated_entries: outItems.reduce((n, v) => n + v.items.length, 0), by_video: outItems },
    structure: {
      categories: KB_CATEGORIES,
      per_rule_fields: ['source_video', 'source_date', 'rule_text', 'confidence', 'needs_review', 'status'],
      activation_rule: 'Only status:approved entries are usable by the WhatsApp agent. Operator knowledge overrides; nothing auto-activates.',
      counts,
    },
  };
}

async function runSimulate() {
  console.log('── KB build (SIMULATE — built-in fixtures, no network, no DB) ──\n');
  const extractions = FIXTURES.videos.map(v =>
    extraction.buildVideoExtraction({ video: { ...v, published_at: new Date(v.published_at) }, transcript: { text: FIXTURES.transcripts[v.video_id] } })
  );
  printReports(reportsFromExtractions(FIXTURES.videos, extractions));
  const pkg = extraction.buildReviewPackage(extractions);
  console.log('\nREVIEW PACKAGE SUMMARY:', JSON.stringify({ videos: pkg.video_count, entries: pkg.entry_count, outdated: pkg.possibly_outdated_count, questions: pkg.questions_count, by_category: pkg.by_category }));
  console.log('\nSIMULATE complete. All entries are pending + needs_review. Nothing activated. No writes.');
}

async function runLive() {
  console.log('── KB build (LIVE) ──');
  try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }); console.log('[kb] mongo connected'); }
  catch (e) { console.error('[kb] mongo connection failed — cannot persist KB:', e.message); process.exit(1); }
  const res = await kbService.ingestChannel({});
  if (!res.ok) { console.error('[kb] enumeration failed:', res.reason, '(set YOUTUBE_API_KEY, or run --simulate)'); await mongoose.disconnect(); process.exit(1); }
  console.log(`[kb] ingested ${res.ingested} videos from ${res.channel}`);
  printReports(await kbService.buildReports());
  console.log('\n[kb] done. All entries pending + needs_review. Approve via knowledgeBaseService.decideEntry.');
  await mongoose.disconnect().catch(() => {});
}

(SIMULATE ? runSimulate() : runLive()).catch(err => { console.error('[kb] fatal:', err.message); process.exit(1); });
