'use strict';
require('dotenv').config();
const { google } = require('googleapis');
const mongoose = require('mongoose');
const { authClient } = require('../src/integrations/googleAuth');
const gmailClient = require('../src/integrations/gmailClient');
const {
  LAB_KNOWN_SENDERS, LAYOUT_BODY_KEYWORDS, LAYOUT_FILENAME_KEYWORDS,
  ORIGINAL_BODY_KEYWORDS, ORIGINAL_FILENAME_KEYWORDS, WORKFLOW_STATUS_MAP,
} = require('../src/config/constants');

const norm = s => String(s||'').toLowerCase().replace(/^(re|fwd|fw)\s*:\s*/gi,'').replace(/[«»"'.,()\/\\]/g,' ').replace(/\s+/g,' ').trim();
const stripSeq = s => { const m = String(s||'').match(/^(.*?)(?:\s+(\d+))?\s*$/); return { name: (m?m[1]:s).trim(), seq: m&&m[2]?parseInt(m[2],10):null }; };
const ORG = new Set(['ип','осоо','оао','тоо','ооо','зао','llc','ооо','чп']);
const tokens = s => norm(s).split(' ').filter(t => t.length>=3 && !ORG.has(t));
const canon = s => { const t=String(s||'').trim().toLowerCase(); if(t==='отказ'||t==='отказное') return 'отменен'; return t; };

(async () => {
  const R = { stages: {} };
  // ---------- Stage 1: read Declaration ----------
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes:['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version:'v4', auth });
  const id = process.env.DECLARATION_SHEET_ID, tab = process.env.DECLARATION_SHEET_NAME;
  const q = /^[A-Za-z0-9_]+$/.test(tab)?tab:`'${tab.replace(/'/g,"''")}'`;
  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId:id, range:`${q}!A1:N` })).data.values || [];
  const decls = [];
  for (let i=1;i<rows.length;i++){ const r=rows[i]; const client=(r[3]||'').trim(); if(!client) continue;
    decls.push({ sheet_row_id:i+1, client_name:client, document_type:(r[5]||'').trim(), phone:(r[9]||'').trim(), status:(r[13]||'').trim(), created:(r[11]||'').trim(), source:'google_sheets', _test:true }); }
  R.stages.declaration = { rows_total: rows.length-1, loaded: decls.length };

  // ---------- Stage 2: populate Mongo (replica) ----------
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS:4000 });
  const db = mongoose.connection.db;
  await db.collection('declarations').deleteMany({ _test:true });
  if (decls.length) await db.collection('declarations').insertMany(decls);
  R.stages.mongo_declarations = await db.collection('declarations').countDocuments({ _test:true });
  // precompute candidate index
  decls.forEach(d => d._tok = tokens(d.client_name));

  // ---------- Stage 3: read Gmail May 2026 lab messages ----------
  const gmail = google.gmail({ version:'v1', auth: authClient });
  const labQ = LAB_KNOWN_SENDERS.map(e=>`from:${e} OR to:${e}`).join(' OR ');
  const query = `after:2026/05/01 before:2026/06/01 (${labQ})`;
  let ids=[], pageToken=null;
  do { const l = await gmail.users.messages.list({ userId:'me', q:query, maxResults:100, pageToken }); (l.data.messages||[]).forEach(m=>ids.push(m.id)); pageToken=l.data.nextPageToken; } while(pageToken && ids.length<300);
  R.stages.gmail_messages = ids.length;

  // ---------- Stage 4: classify + store evidence ----------
  const evidence = [];
  for (const mid of ids) {
    const m = (await gmail.users.messages.get({ userId:'me', id:mid, format:'full' })).data;
    const hs={}; (m.payload.headers||[]).forEach(h=>hs[h.name.toLowerCase()]=h.value);
    const from = hs.from||'', subject = hs.subject||'', date = hs.date||'';
    const inbound = LAB_KNOWN_SENDERS.some(l => from.toLowerCase().includes(l));
    const body = (gmailClient.getMessageBody(m)||'');
    const files = gmailClient.getAttachmentFilenames(m)||[];
    const hay = (subject+' '+body).toLowerCase(); const fhay = files.join(' ').toLowerCase();
    const isLayout = LAYOUT_BODY_KEYWORDS.some(k=>hay.includes(k.toLowerCase())) || LAYOUT_FILENAME_KEYWORDS.some(k=>fhay.includes(k.toLowerCase()));
    const isOrig = ORIGINAL_BODY_KEYWORDS.some(k=>hay.includes(k.toLowerCase())) || ORIGINAL_FILENAME_KEYWORDS.some(k=>fhay.includes(k.toLowerCase()));
    let event = 'none'; if (isLayout && isOrig) event='conflict'; else if (isLayout) event='LAYOUT_RECEIVED'; else if (isOrig) event='ORIGINAL_RECEIVED';
    const { name, seq } = stripSeq(norm(subject));
    evidence.push({ message_id:mid, thread_id:m.threadId, subject, from, date:new Date(date), inbound, event, has_attachment: files.length>0, entity:name, seq, _test:true });
  }
  await db.collection('gmail_evidence').deleteMany({ _test:true });
  if (evidence.length) await db.collection('gmail_evidence').insertMany(evidence);
  R.stages.evidence_stored = evidence.length;
  R.stages.inbound_lab = evidence.filter(e=>e.inbound).length;
  R.stages.events = { layout: evidence.filter(e=>e.event==='LAYOUT_RECEIVED').length, original: evidence.filter(e=>e.event==='ORIGINAL_RECEIVED').length, conflict: evidence.filter(e=>e.event==='conflict').length, none: evidence.filter(e=>e.event==='none').length };

  // ---------- Stage 5: match evidence -> declaration order ----------
  function match(entityName){
    const et = tokens(entityName); if(!et.length) return { conf:'LOW', cands:[], reason:'empty entity' };
    const scored = decls.map(d=>{ const dt=d._tok; const inter=et.filter(t=>dt.includes(t)).length; const union=new Set([...et,...dt]).size; const ratio=union?inter/union:0;
      const contained = norm(d.client_name)&&(norm(entityName).includes(norm(d.client_name))||norm(d.client_name).includes(norm(entityName))); return { d, inter, ratio, contained }; })
      .filter(s=>s.inter>0||s.contained).sort((a,b)=>(b.ratio-a.ratio)||(b.inter-a.inter));
    if(!scored.length) return { conf:'LOW', cands:[], reason:'no candidate' };
    const top=scored[0], second=scored[1];
    const strong = top.contained || top.ratio>=0.8;
    const unique = !second || (top.ratio-second.ratio)>=0.2;
    let conf='LOW'; if(strong&&unique) conf='HIGH'; else if((top.ratio>=0.5||top.contained)) conf='MEDIUM';
    return { conf, best: top.d, score:+top.ratio.toFixed(2), cand_count: scored.filter(s=>s.ratio>=0.5||s.contained).length };
  }

  // Build order-level audit: latest INBOUND lab event per matched declaration row
  const byRow = new Map();
  for (const e of evidence) {
    if (!e.inbound || (e.event!=='LAYOUT_RECEIVED' && e.event!=='ORIGINAL_RECEIVED')) continue;
    const mr = match(e.entity);
    if (!mr.best) continue;
    const key = mr.best.sheet_row_id;
    const prev = byRow.get(key);
    if (!prev || e.date > prev.date) byRow.set(key, { e, mr });
  }

  const report = [];
  for (const [row, { e, mr }] of byRow) {
    const d = mr.best;
    const suggested = WORKFLOW_STATUS_MAP[e.event]?.to || '';
    const cur = canon(d.status), sug = canon(suggested);
    const match_ok = cur === sug;
    report.push({ row, client:d.client_name, decl_status:d.status.trim(), evidence:`${e.event} (${e.subject.slice(0,40)})`, suggested, match: match_ok?'YES':'NO', confidence:mr.conf, notes: mr.cand_count>1?`${mr.cand_count} candidate rows; score ${mr.score}`:`score ${mr.score}` });
  }
  // Order: mismatches first, by confidence
  const crank={HIGH:0,MEDIUM:1,LOW:2};
  report.sort((a,b)=> (a.match===b.match?0:(a.match==='NO'?-1:1)) || crank[a.confidence]-crank[b.confidence]);

  R.summary = {
    declaration_rows_loaded: decls.length,
    gmail_lab_messages: evidence.length,
    inbound_lab_messages: R.stages.inbound_lab,
    layout_events: R.stages.events.layout, original_events: R.stages.events.original, conflict_events: R.stages.events.conflict,
    orders_with_lab_evidence_matched: report.length,
    mismatches: report.filter(r=>r.match==='NO').length,
    in_sync: report.filter(r=>r.match==='YES').length,
    confidence: { HIGH: report.filter(r=>r.confidence==='HIGH').length, MEDIUM: report.filter(r=>r.confidence==='MEDIUM').length, LOW: report.filter(r=>r.confidence==='LOW').length },
  };
  console.log('SUMMARY='+JSON.stringify(R.stages));
  console.log('AUDIT_SUMMARY='+JSON.stringify(R.summary));
  console.log('TOP_ROWS_START');
  report.slice(0,25).forEach(r => console.log(JSON.stringify(r)));
  console.log('TOP_ROWS_END');
  await mongoose.disconnect();
})().catch(e => { console.log('FATAL', e.message, e.stack? e.stack.split('\n')[1]:''); process.exit(1); });
