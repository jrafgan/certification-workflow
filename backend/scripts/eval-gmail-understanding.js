'use strict';
// One-off evaluation harness (READ-ONLY): measures how well the system understands
// REAL laboratory emails. Reads Gmail (real) + the Declaration sheet (source of truth),
// runs the ACTUAL system logic (workflowDetectionService.classifyMessage / isKnownLabSender,
// documentUnderstandingService entity parse) and reports per-email detection + confidence.
// No writes, no status changes, nothing marked read beyond Gmail's own read semantics on
// threads.get (metadata/full fetch does not mark messages read).

require('dotenv').config();
const { google } = require('googleapis');
const gmail = require('../src/integrations/gmailClient');
const wf    = require('../src/services/workflowDetectionService');
const { authClient } = require('../src/integrations/googleAuth');
const { normEntity } = require('../src/services/draftPackageService');
const sheetsApi = google.sheets({ version: 'v4', auth: authClient });

// ── entity parsing from subject/body ────────────────────────────────────────
const ENTITY_RE = /(ОсОО|ООО|ОАО|ЗАО|ТОО|ЧП|ИП)\s+([«"']?[А-ЯA-Zа-яё][^\n,;«»"'\/|]{1,60})/i;
function parseEntity(text) {
  const t = String(text || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim();
  const m = ENTITY_RE.exec(t);
  if (!m) return null;
  return `${m[1]} ${m[2].trim()}`.replace(/\s+/g, ' ').trim();
}

// ── stage inference from email content → one of the 7 RU statuses ───────────
function inferStage({ subject, body, filenames, known }) {
  const hay = `${subject}\n${body}\n${filenames.join(' ')}`.toLowerCase();
  const { matchedByEvent } = wf.classifyMessage({ body: `${subject}\n${body}`, filenames });
  if (matchedByEvent.ORIGINAL_RECEIVED) return { stage: 'Оригинал получен', basis: 'original/ДС/СС keywords', strong: known };
  if (matchedByEvent.LAYOUT_RECEIVED)   return { stage: 'На согласовании', basis: 'макет/layout keywords', strong: known };
  if (/заявлени|запрос|во вложении.*заявк|прошу оформить|на оформление/.test(hay)) return { stage: 'Ждем макет', basis: 'request/заявление phrasing (lab request sent)', strong: false };
  if (/оплат|квитанц|чек/.test(hay)) return { stage: 'Запустить', basis: 'payment mention', strong: false };
  return { stage: null, basis: 'no stage cue', strong: false };
}

function band(b) { return b ? 'HIGH' : 'MEDIUM'; }

(async () => {
  const me = (await gmail.getOperatorEmail()).toLowerCase();
  console.log('# GMAIL UNDERSTANDING EVAL  (operator:', me, ')\n');

  // ── 1) Declaration sheet → entity index (source of truth) ──────────────────
  let entityIndex = [];
  let headerInfo = '';
  const STOP = new Set(['ип', 'осоо', 'ооо', 'оао', 'тоо', 'зао', 'чп', 'кызы', 'уулу', 'срочно', 're', 'fwd', 'fw']);
  const nameTokens = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9 ]+/gi, ' ').split(/\s+/).filter(t => t.length >= 4 && !STOP.has(t));
  function matchOrder(entity) {
    const toks = nameTokens(entity);
    if (!toks.length) return null;
    let best = null;
    for (const row of entityIndex) {
      const hay = (row.client + ' ' + row.sender).toLowerCase();
      const hits = toks.filter(t => hay.includes(t)).length;
      if (hits > 0 && (!best || hits > best.hits)) best = { ...row, hits, of: toks.length };
    }
    return best;
  }
  const normStatus = (s) => String(s || '').trim().toLowerCase();
  try {
    const spreadsheetId = process.env.DECLARATION_SHEET_ID;
    const sheetName = process.env.DECLARATION_SHEET_NAME || 'Лист1';
    const statusCol = (process.env.DECLARATION_STATUS_COLUMN || 'N');
    const grid = await sheetsApi.spreadsheets.values.get({
      spreadsheetId, range: `'${sheetName}'!A1:Z`,
    });
    const rows = grid.data.values || [];
    const header = rows[0] || [];
    const sIdx = statusCol.split('').reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1; // N → 13
    const D = 3, E = 4, J = 9; // Клиент, Имя отправителя чека, Номер тел
    headerInfo = `rows=${rows.length - 1}, client_col=${header[D]}, sender_col=${header[E]}, status_col=${header[sIdx]}`;
    // Build a row list (not a strict index — names won't match exactly).
    entityIndex = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      entityIndex.push({
        row: r + 1,
        client: (row[D] || '').trim(),
        sender: (row[E] || '').trim(),
        phone:  (row[J] || '').trim(),
        status: (row[sIdx] || '').trim(),
      });
    }
  } catch (e) {
    headerInfo = 'SHEET_READ_FAILED: ' + e.message;
  }
  console.log('Declaration sheet:', headerInfo, '| indexed entities:', entityIndex.size, '\n');

  // ── 2) collect ~20 recent laboratory threads ───────────────────────────────
  const queries = [
    'from:(mng-1@kyrgyz-test.kg OR standartpro98@gmail.com OR test@test.kg)',
    'to:(mng-1@kyrgyz-test.kg OR standartpro98@gmail.com OR sertifikatplus2004@mail.ru)',
    '(макет OR декларация OR сертификат OR заявление OR ДС OR СС) newer_than:1y',
  ];
  const seen = new Set(); const threads = [];
  for (const q of queries) {
    const ts = await gmail.searchThreads(q, 15);
    for (const t of ts) { if (!seen.has(t.threadId)) { seen.add(t.threadId); threads.push(t); } }
  }
  threads.sort((a, b) => (b.date || 0) - (a.date || 0));
  const sample = threads.slice(0, 20);

  // ── 3) evaluate each ───────────────────────────────────────────────────────
  const acc = { entity: 0, stage: 0, order: 0, stageMatchesOrder: 0, stageConflicts: 0, noEntity: 0, unknownSender: 0 };
  let i = 0;
  for (const t of sample) {
    i++;
    let full; try { full = await gmail.getThread(t.threadId, 'full'); } catch { continue; }
    const msgs = full.messages || [];
    const last = msgs[msgs.length - 1];
    const headers = last?.payload?.headers || [];
    const from = (gmail.extractHeader(headers, 'from') || '').toLowerCase();
    const subject = gmail.extractHeader(headers, 'subject') || t.subject || '';
    const body = (gmail.getMessageBody(last) || '').replace(/\s+/g, ' ').slice(0, 400);
    const filenames = gmail.getAttachmentFilenames(last) || [];
    const known = wf.isKnownLabSender(gmail.extractHeader(headers, 'from'));
    const direction = from.includes(me) ? 'OUTBOUND→lab' : 'INBOUND←lab';

    const entity = parseEntity(subject) || parseEntity(body);
    const stage = inferStage({ subject, body, filenames, known });

    // order match against sheet (fuzzy name-token overlap on Клиент + Имя отправителя)
    let order = null, orderConf = 'NONE';
    if (entity) {
      order = matchOrder(entity);
      if (order) orderConf = order.hits >= 2 ? `MEDIUM(${order.hits}/${order.of} tokens)` : `LOW(${order.hits}/${order.of} token)`;
    }

    if (entity) acc.entity++; else acc.noEntity++;
    if (stage.stage) acc.stage++;
    if (order) acc.order++;
    if (!known && direction === 'INBOUND←lab') acc.unknownSender++;
    if (order && stage.stage) {
      if (normStatus(order.status) === normStatus(stage.stage)) acc.stageMatchesOrder++;
      else acc.stageConflicts++;
    }

    console.log(`────────────────────────────────────────────────────────`);
    console.log(`#${i} [${direction}] ${t.date ? new Date(t.date).toISOString().slice(0, 10) : '????'}  msgs=${msgs.length} att=${filenames.length}`);
    console.log(`   from:    ${from.slice(0, 48)}  known_lab=${known}`);
    console.log(`   subject: ${subject.slice(0, 70)}`);
    console.log(`   detected_entity/client: ${entity || '— (none)'}  [${entity ? band(/^(ИП|ОсОО)/i.test(entity)) : 'LOW'}]`);
    console.log(`   detected_stage:         ${stage.stage || '— (unknown)'}  [${stage.stage ? (stage.strong ? 'HIGH' : 'MEDIUM') : 'LOW'}]  why: ${stage.basis}`);
    console.log(`   detected_order:         ${order ? `row ${order.row} client=«${order.client}» sender=«${order.sender}» phone=${order.phone} status=«${order.status}»` : '— (no sheet match)'}  [${orderConf}]`);
    if (order && stage.stage) console.log(`   stage_vs_order_status:  ${normStatus(order.status) === normStatus(stage.stage) ? 'CONSISTENT' : 'DISCREPANCY (email→«' + stage.stage + '» vs sheet→«' + order.status + '»)'}`);
    if (filenames.length) console.log(`   attachments: ${filenames.join(', ').slice(0, 80)}`);
  }

  console.log(`\n══════════ AGGREGATE over ${sample.length} emails ══════════`);
  console.log(JSON.stringify(acc, null, 2));
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
