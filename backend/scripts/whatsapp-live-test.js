#!/usr/bin/env node
'use strict';

// scripts/whatsapp-live-test.js — connect the Dokumenty.pro WhatsApp Business number
// in TEST_MODE and run the READ-ONLY live-test pipeline for the single allowed
// contact ("Мой Билайн"). Every other contact is OBSERVE-ONLY (logged, nothing else).
//
// SAFETY: receive-only. No sends, no Declaration/sheet/Order writes, no Gmail, no
// WhatsApp state changes. The client never marks chats read or alters unread counters
// (markOnlineOnConnect:false; sendSeen is never called). Draft Packages are built in
// DRY-RUN mode (not persisted).
//
// Usage:
//   TEST_MODE=true node scripts/whatsapp-live-test.js
//        → first run prints a QR to scan on the Dokumenty.pro phone; then listens.
//   node scripts/whatsapp-live-test.js --simulate
//        → no WhatsApp/QR: feeds synthetic messages through the same pipeline so the
//          nine goals can be exercised offline (DB/Sheets steps degrade to blockers
//          when unavailable). Useful for verifying wiring before the live scan.

require('dotenv').config();
const mongoose = require('mongoose');
const testMode      = require('../src/services/whatsappTestModeService');
const liveTest      = require('../src/services/whatsappLiveTestService');

const SIMULATE = process.argv.includes('--simulate');

function hr() { console.log('─'.repeat(60)); }

function printReport(r) {
  hr();
  console.log(`MESSAGE from ${r.contact} (${r.phone || 'no-phone'})  id=${r.id || '-'}`);
  const g = r.goals;
  console.log(`  1. text                : "${g.text.body}" (${g.text.length} chars)`);
  if (g.attachments.length === 0) {
    console.log('  2-4. attachments       : (none)');
  } else {
    g.attachments.forEach((a, i) => {
      console.log(`  2-4. attachment[${i}]    : ${a.file_name} [${a.mime_type}] kind=${a.kind} supported=${a.supported}`);
      console.log(`  5. classify            : category=${a.category} confidence=${a.confidence}`);
      console.log(`  6. explain             : ${a.explanation}`);
    });
  }
  const ds = g.declaration_search;
  console.log(`  7. search Declaration  : ${ds.blocker ? 'BLOCKER: ' + ds.blocker : `${ds.match_status} (${ds.match_count} match(es))`}`);
  const nf = g.new_form_search;
  console.log(`  8. search New Form     : ${nf.blocker ? 'BLOCKER: ' + nf.blocker : `${nf.status} (${(nf.candidates || []).length} candidate(s))`}`);
  const dp = g.draft_package;
  console.log(`  9. draft package (dry) : ${dp.blocker ? 'BLOCKER: ' + dp.blocker : (dp.generated ? `would propose ${dp.proposed_action} @${dp.confidence}%` : `not generated (${dp.reason})`)}`);
}

// Synthetic inbound messages for --simulate (mirror the whatsapp-web.js raw shape).
function syntheticMessages() {
  const contact = { name: testMode.allowedContactName(), number: '996700112233' };
  const now = Math.floor(Date.now() / 1000);
  const from = '996700112233@c.us';
  return [
    { id: 'sim-1', from, contact, body: 'Здравствуйте! Отправляю документы по заявке ОсОО Ромашка', timestamp: now, fromMe: false, attachments: [] },
    { id: 'sim-2', from, contact, body: '', timestamp: now, fromMe: false, attachments: [{ file_name: 'чек_оплаты.pdf', mime_type: 'application/pdf', size: 51234, media_ref: '/tmp/sim/чек.pdf' }] },
    { id: 'sim-3', from, contact, body: '', timestamp: now, fromMe: false, attachments: [{ file_name: 'свидетельство_ИП.jpg', mime_type: 'image/jpeg', size: 204800, media_ref: '/tmp/sim/ip.jpg' }] },
    { id: 'sim-4', from, contact, body: '', timestamp: now, fromMe: false, attachments: [{ file_name: 'устав_компании.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 33012, media_ref: '/tmp/sim/ustav.docx' }] },
    { id: 'sim-5', from, contact, body: '', timestamp: now, fromMe: false, attachments: [{ file_name: 'позиции.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 12000, media_ref: '/tmp/sim/pos.xlsx' }] },
  ];
}

async function runSimulate() {
  console.log('── WhatsApp live-test (SIMULATE — no WhatsApp connection) ──');
  console.log(`TEST_MODE=${testMode.isTestMode()}  allowed_contact="${testMode.allowedContactName()}"`);
  // Best-effort DB connect so goals 7 can run against the replica when available.
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
      console.log('[live-test] mongo connected (Declaration search enabled)');
    } catch (e) {
      console.log('[live-test] mongo unavailable — Declaration search will report a blocker:', e.message);
    }
  }
  for (const raw of syntheticMessages()) {
    const r = await liveTest.analyzeMessage(raw);
    printReport(r);
  }
  hr();
  console.log('SIMULATE complete. No writes, no messages, no state changes were performed.');
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

async function runLive() {
  console.log('── WhatsApp live-test (receive-only) ──');
  if (!testMode.isTestMode()) {
    console.log('WARNING: TEST_MODE is OFF — every contact would be processed. Set TEST_MODE=true for restricted testing.');
  }
  console.log(`TEST_MODE=${testMode.isTestMode()}  allowed_contact="${testMode.allowedContactName()}"`);

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('[live-test] mongo connected:', process.env.MONGODB_URI);
  } catch (err) {
    console.error('[live-test] MongoDB connection failed — Declaration search will be a blocker:', err.message);
  }

  const { startClient } = require('../src/integrations/whatsappWebClient');
  let observedCount = 0;

  await startClient({
    onIncoming: async (raw) => {
      try {
        const r = await liveTest.analyzeMessage(raw);
        printReport(r);
      } catch (err) {
        console.error('[live-test] analyze error:', err.message);
      }
    },
    onObserved: async () => { observedCount++; },
  });

  console.log('[live-test] listening (allowed contact = active; all others observe-only). Ctrl+C to stop.');
  process.on('SIGINT', async () => {
    console.log(`\n[live-test] observed-only messages seen: ${observedCount}`);
    console.log('[live-test] shutting down...');
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
}

(SIMULATE ? runSimulate() : runLive()).catch(err => {
  console.error('[live-test] fatal:', err.message);
  process.exit(1);
});
