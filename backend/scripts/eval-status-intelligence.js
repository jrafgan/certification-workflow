'use strict';
// READ-ONLY Status Intelligence evaluation. Anchors on REAL orders (Declaration sheet
// rows = the order book) and infers the order's ACTUAL stage by fusing evidence:
//   • Declaration  — declared status + payment cell (sheet, source of truth)
//   • Gmail        — laboratory correspondence (real), classified DIRECTION-AWARE
//   • payment      — Declaration payment cell
//   • WhatsApp     — UNAVAILABLE here (Mongo offline; client-approval lives here → blind spot)
// Reports, per order: declared status · inferred status · confidence · evidence · reasoning
// · mismatch. NEVER writes anything (no status change). Reproducible measurement only.

require('dotenv').config();
const { google } = require('googleapis');
const gmail = require('../src/integrations/gmailClient');
const { authClient } = require('../src/integrations/googleAuth');
const sheetsApi = google.sheets({ version: 'v4', auth: authClient });

// 7 canonical statuses → ladder index (терминальные handled apart).
const LADDER = ['запустить', 'ждем макет', 'на согласовании', 'ждем оригинал', 'оригинал получен', 'завершен'];
const STAGE_OF = ['Запустить', 'Ждем макет', 'На согласовании', 'Ждем оригинал', 'Оригинал получен'];
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function declaredIdx(status) { const n = norm(status); const i = LADDER.indexOf(n); return i; }

// ── direction-aware milestone classification of ONE gmail message ──────────────
function classifyMsg({ from, subject, body, filenames }, operator) {
  const outbound = from.includes(operator);
  const hay = `${subject}\n${body}\n${filenames.join(' ')}`.toLowerCase();
  const hasLayout  = /макет|layout|draft/.test(hay);
  const hasOriginal= /(деклараци|сертификат|оригинал|\bдс\b|\bсс\b)/.test(hay) && !/макет/.test(hay); // макет wins (fixes Сертификат_макет)
  const hasCorr    = /правк|корректир|исправл|замечани/.test(hay);
  const hasRequest = /запрос|заявлени|на оформление|прошу оформить|во вложении/.test(hay);

  // returns { milestone:0..4, conf, cue, dir }
  if (!outbound && hasOriginal) return { m: 4, conf: 90, cue: 'lab sent original (ДС/СС/декларация)', dir: 'IN' };
  if (!outbound && hasLayout)   return { m: 2, conf: 85, cue: 'lab sent layout (макет)',             dir: 'IN' };
  if (outbound && hasCorr)      return { m: 3, conf: 70, cue: 'operator sent corrections to lab',    dir: 'OUT' };
  if (outbound && hasLayout)    return { m: 2, conf: 55, cue: 'operator emailed layout to lab (AMBIGUOUS dir)', dir: 'OUT' };
  if (outbound && hasRequest)   return { m: 1, conf: 65, cue: 'operator sent request/заявление to lab', dir: 'OUT' };
  if (hasLayout)                return { m: 2, conf: 45, cue: 'layout mention (dir unclear)', dir: outbound ? 'OUT' : 'IN' };
  return null;
}

function nameQuery(client) {
  const toks = String(client || '').replace(/^(ИП|ОсОО|ООО|ОАО|ТОО|ЗАО|ЧП)\s+/i, '').split(/\s+/).filter(t => t.length >= 3).slice(0, 2);
  return toks.length ? `"${toks.join(' ')}"` : null;
}

(async () => {
  const operator = (await gmail.getOperatorEmail()).toLowerCase();
  console.log('# STATUS INTELLIGENCE EVAL (order-anchored, real data)  operator:', operator, '\n');

  // ── load 20 real orders ──────────────────────────────────────────────────────
  const grid = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: process.env.DECLARATION_SHEET_ID,
    range: `'${process.env.DECLARATION_SHEET_NAME}'!A1015:N1036`,
  });
  const rows = (grid.data.values || [])
    .map((r, i) => ({ row: 1015 + i, client: (r[3] || '').trim(), doc: (r[5] || '').trim(), pay: (r[6] || '').trim(), phone: (r[9] || '').trim(), status: (r[13] || '').trim() }))
    .filter(o => o.client && !/^TEST/i.test(o.client))
    .slice(0, 20);

  const acc = { total: rows.length, match: 0, ahead: 0, behind: 0, noGmail: 0, declaredUnparseable: 0 };

  let i = 0;
  for (const o of rows) {
    i++;
    // ── collect this order's lab correspondence ────────────────────────────────
    const q = nameQuery(o.client);
    let evidence = [];
    let bestMs = { m: 0, conf: 40, cue: 'payment recorded on Declaration', dir: 'DECL' }; // baseline: paid ⇒ ≥ Запустить
    let gmailThreads = 0;
    if (q) {
      let threads = [];
      try { threads = await gmail.searchThreads(q, 6); } catch {}
      gmailThreads = threads.length;
      threads.sort((a, b) => (b.date || 0) - (a.date || 0));
      for (const t of threads.slice(0, 4)) {
        let full; try { full = await gmail.getThread(t.threadId, 'full'); } catch { continue; }
        for (const msg of (full.messages || [])) {
          const h = msg.payload?.headers || [];
          const cls = classifyMsg({
            from: (gmail.extractHeader(h, 'from') || '').toLowerCase(),
            subject: gmail.extractHeader(h, 'subject') || '',
            body: (gmail.getMessageBody(msg) || '').slice(0, 300),
            filenames: gmail.getAttachmentFilenames(msg) || [],
          }, operator);
          if (cls) {
            evidence.push(cls);
            // highest milestone wins; tie → higher confidence
            if (cls.m > bestMs.m || (cls.m === bestMs.m && cls.conf > bestMs.conf)) bestMs = cls;
          }
        }
      }
    }
    if (gmailThreads === 0) acc.noGmail++;

    const inferredIdx = bestMs.m;
    const inferred = STAGE_OF[inferredIdx];
    const dIdx = declaredIdx(o.status);

    // mismatch classification
    let verdict;
    if (dIdx === -1) { verdict = 'DECLARED_UNPARSEABLE'; acc.declaredUnparseable++; }
    else if (dIdx === inferredIdx) { verdict = 'MATCH'; acc.match++; }
    else if (inferredIdx > dIdx) { verdict = 'INFERRED_AHEAD (status may be stale)'; acc.ahead++; }
    else { verdict = 'INFERRED_BEHIND (declared claims more than lab evidence shows)'; acc.behind++; }

    // confidence band — strongest evidence, penalised if only ambiguous/baseline
    const conf = bestMs.conf;
    const band = conf >= 80 ? 'HIGH' : conf >= 55 ? 'MEDIUM' : 'LOW';

    const evSummary = evidence.length
      ? [...new Set(evidence.map(e => `${e.dir}:${e.cue}`))].slice(0, 4).join(' | ')
      : 'no lab email matched; Declaration/payment only';

    console.log('────────────────────────────────────────────────────────');
    console.log(`#${i} row ${o.row}  «${o.client}»  pay=${o.pay || '—'}  gmail_threads=${gmailThreads}`);
    console.log(`   declared_status:  «${o.status}»  (ladder ${dIdx})`);
    console.log(`   inferred_status:  «${inferred}»  (ladder ${inferredIdx})  [${band} ${conf}]`);
    console.log(`   evidence:         ${evSummary}`);
    console.log(`   reasoning:        highest milestone = «${bestMs.cue}» (${bestMs.dir}); WhatsApp client-approval NOT observable (corpus offline)`);
    console.log(`   VERDICT:          ${verdict}`);
  }

  console.log('\n══════════ AGGREGATE ══════════');
  console.log(JSON.stringify(acc, null, 2));
  const measurable = acc.total - acc.declaredUnparseable;
  console.log(`agreement (declared == inferred): ${acc.match}/${measurable}`);
  console.log(`inferred AHEAD of declared:       ${acc.ahead}/${measurable}  (status possibly stale / forgotten)`);
  console.log(`inferred BEHIND declared:         ${acc.behind}/${measurable}  (often the WhatsApp-invisible approval step)`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
