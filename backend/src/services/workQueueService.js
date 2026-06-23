'use strict';

// services/workQueueService.js — agent-built operational WORK QUEUE (replaces "latest row").
//
// Answers "what requires my attention today?" by composing EXISTING sources (no new
// architecture): «Новая форма» (sheet) cross-referenced against «Декларация» for NEW
// applications, plus the order-based lanes from attentionCenterService (Phase 6).
//
// Eight sections, each with a count + items the operator clicks into:
//   new_applications · waiting_payment · waiting_samples · waiting_mockup ·
//   on_approval · waiting_original · status_conflicts · forgotten
//
// NEW application = found in «Новая форма» with NO launched workflow. "Launched" is detected
// from «Декларация»: a matching phone whose status has moved PAST «Запустить». No match, or a
// row still at «Запустить», → still NEW. Read-only / recommend-only — nothing is written.

const { matchKey } = require('../utils/phoneUtils');
const attentionCenter = require('./attentionCenterService');

// ─── Pure: is an application already launched, given the launched-phone index? ──
function applicationState(application = {}, launchedPhones = new Set()) {
  const phone = application.applicant && application.applicant.phone;
  const pk = phone ? matchKey(phone) : '';
  return pk && launchedPhones.has(pk) ? 'launched' : 'new';
}

// «Декларация» (tab Лист1) — operator-confirmed columns. Only J (phone) and N (status) drive
// logic; everything else is RESERVE. See memory declaration-schema-status.
const DECL_PHONE_COL  = 9;   // J — Номер тел: (primary client ID)
const DECL_STATUS_COL = 13;  // N — Статус

// defaultReadDeclaration — live, read-only Google Sheets read of «Декларация» data rows.
async function defaultReadDeclaration() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = process.env.DECLARATION_SHEET_NAME || 'Лист1';
  const a1 = /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.DECLARATION_SHEET_ID, range: `${a1}!A1:V2000` });
  return (res.data.values || []).slice(1);                    // data rows (skip header)
}

// ─── Phones present in «Декларация» with a real status (= launched) ─────────────
// A «Новая форма» application is NOT new once its phone (J) appears in «Декларация» with a
// non-empty status (N) that is not «запустить». Read-only; uses ONLY J + N.
async function buildLaunchedIndex(deps = {}) {
  const read = deps.readDeclaration || defaultReadDeclaration;
  const set = new Set();
  try {
    for (const r of await read()) {
      const phone = r[DECL_PHONE_COL];
      const status = String(r[DECL_STATUS_COL] || '').trim().toLowerCase();
      if (phone && status && status !== 'запустить') {
        const k = matchKey(String(phone));
        if (k) set.add(k);
      }
    }
  } catch (_) { /* no access → everything stays new */ }
  return set;
}

// ─── «Новая форма» rows not yet launched, deduped by phone (newest row wins) ────
async function newApplications(deps = {}) {
  const mapper = deps.mapper || require('./formFieldMapper');
  const readRows = deps.readRows || require('./mockupGenerationService').defaultReadRows;
  const launched = deps.launchedPhones || await buildLaunchedIndex(deps);

  let header = [], rows = [];
  try { ({ header, rows } = await readRows()); } catch (_) { return []; }

  const seen = new Set();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {              // newest → oldest
    const app = mapper.mapRow(header, rows[i], { docType: null });
    const name = app.applicant && app.applicant.name;
    if (!name) continue;
    if (applicationState(app, launched) === 'launched') continue;
    const pk = app.applicant.phone ? matchKey(app.applicant.phone) : '';
    if (pk && seen.has(pk)) continue;                        // dedupe re-submissions
    if (pk) seen.add(pk);
    out.push({
      sheet_row: i + 2,
      applicant: name,
      legal_entity: app.legal_entity || null,
      phone: app.applicant.phone || null,
      age: app.age || null,
      action: 'create_mockup',
    });
  }
  return out;
}

// ─── DB: orders past payment but still early (proxy for "samples pending") ──────
async function waitingSamples(deps = {}) {
  const models = deps.models || require('../models');
  const Order = models.Order;
  try {
    const orders = await Order.find({ status: { $in: ['Запустить', 'Ждем макет'] } })
      .select('status client payments sheet_row_id').limit(2000).lean();
    return orders
      .filter(o => (o.payments || []).some(p => !p.voided && (p.amount || 0) > 0))
      .map(o => ({ order_id: String(o._id), client: o.client?.companyName || o.client?.name || '—', status: o.status }));
  } catch (_) { return []; }
}

// ─── Build the 8-section work queue ────────────────────────────────────────────
async function build(deps = {}) {
  const [apps, samples, ac] = await Promise.all([
    newApplications(deps),
    waitingSamples(deps),
    attentionCenter.build(deps).catch(() => ({ categories: [] })),
  ]);
  const byKey = Object.fromEntries((ac.categories || []).map(c => [c.key, c]));
  const lane = (key, label) => ({ key, label, count: (byKey[key]?.items || []).length, items: byKey[key]?.items || [] });

  const sections = [
    { key: 'new_applications', label: 'Новые заявки', count: apps.length, items: apps, action: 'create_mockup' },
    lane('waiting_payment', 'Ожидают оплату'),
    { key: 'waiting_samples', label: 'Ожидают образцы', count: samples.length, items: samples },
    lane('waiting_mockup', 'Ожидают макет'),
    { key: 'on_approval', label: 'На согласовании', count: (byKey['waiting_approval']?.items || []).length, items: byKey['waiting_approval']?.items || [] },
    lane('waiting_original', 'Ожидают оригинал'),
    lane('status_conflicts', 'Конфликты статуса'),
    lane('forgotten', 'Забытые заказы'),
  ];
  return { sections, total: sections.reduce((n, s) => n + s.count, 0), recommend_only: true };
}

module.exports = { applicationState, buildLaunchedIndex, defaultReadDeclaration, newApplications, waitingSamples, build, DECL_PHONE_COL, DECL_STATUS_COL };
