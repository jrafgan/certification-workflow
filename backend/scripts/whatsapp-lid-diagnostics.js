#!/usr/bin/env node
'use strict';

// scripts/whatsapp-lid-diagnostics.js — DIAGNOSTICS ONLY.
//
// For every incoming WhatsApp event, dumps the raw contact object, raw chat object,
// all identifiers, the LID, and the phone number IF whatsapp-web.js can resolve one
// (via client.getContactLidAndPhone — the library's LID↔PN resolver). It changes NO
// matching logic, sends nothing, downloads no media, and (critically) never marks
// chats read / alters unread counters (markOnlineOnConnect:false; sendSeen never
// called). Pure observation.
//
// Usage:
//   node scripts/whatsapp-lid-diagnostics.js            # live (reuses saved session)
//   node scripts/whatsapp-lid-diagnostics.js --simulate # show the report shape using
//                                                        # the observed LID, no WhatsApp

require('dotenv').config();
const util = require('util');
const path = require('path');
const diag = require('../src/services/whatsappLidDiagnosticsService');

const SIMULATE = process.argv.includes('--simulate');
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, '..', '.wwebjs_auth');

function dump(label, obj) {
  console.log(`\n### ${label}`);
  console.log(util.inspect(obj, { depth: 5, colors: false, maxStringLength: 300, breakLength: 100 }));
}

function printReport(report) {
  console.log('\n' + '='.repeat(64));
  console.log('WHATSAPP LID DIAGNOSTIC');
  console.log('='.repeat(64));
  console.log('Identifiers      :', JSON.stringify(report.identifiers));
  console.log('Addressing       :', JSON.stringify(report.addressing));
  console.log('Phone number     :', report.phone_number || '(none resolvable)');
  console.log('Phone available  :', report.phone_available);
  console.log('LID              :', report.lid || '(none)');
  console.log('pushName         :', report.pushName || '(none)');
  console.log('Contact name     :', report.contact_name || '(none)');
  console.log('Business name    :', report.business_name || '(none)');
  console.log('Analysis         :', report.analysis);
  dump('raw contact object', report.raw_contact);
  dump('raw chat object', report.raw_chat);
  dump('raw resolver { lid, pn }', report.raw_resolved);
}

// Pull a JSON-safe subset from a whatsapp-web.js Contact.
function contactSubset(c) {
  if (!c) return {};
  return {
    id: c.id, number: c.number, name: c.name, shortName: c.shortName, pushname: c.pushname,
    verifiedName: c.verifiedName, isBusiness: c.isBusiness, isEnterprise: c.isEnterprise,
    isWAContact: c.isWAContact, isMyContact: c.isMyContact, isUser: c.isUser, isGroup: c.isGroup,
    type: c.type, businessProfile: c.businessProfile,
  };
}

async function runLive() {
  console.log('── WhatsApp LID diagnostics (receive-only, no matching, no read-marking) ──');
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const qrcode = require('qrcode-terminal');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    markOnlineOnConnect: false, // SAFETY: do not appear online / no presence side effects
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', (qr) => { console.log('[diag] scan QR on the Dokumenty.pro phone:'); qrcode.generate(qr, { small: true }); });
  client.on('authenticated', () => console.log('[diag] authenticated'));
  client.on('ready', () => console.log('[diag] ready — send a message FROM the LID contact to inspect it'));
  client.on('disconnected', (r) => console.log('[diag] disconnected:', String(r)));

  client.on('message', async (msg) => {
    try {
      // SAFETY: we never call msg.getChat().sendSeen()/markUnread(); reading the
      // event does not send a read receipt. No media is downloaded.
      let contact = {}, chat = {}, resolved = {};
      try { contact = contactSubset(await msg.getContact()); } catch (e) { contact = { _error: e.message }; }
      try { const c = await msg.getChat(); chat = { id: c.id, name: c.name, isGroup: c.isGroup }; } catch (e) { chat = { _error: e.message }; }

      // The library's authoritative LID↔PN resolver (1.34.7: getContactLidAndPhone).
      try {
        if (typeof client.getContactLidAndPhone === 'function') {
          const arr = await client.getContactLidAndPhone([msg.from]);
          resolved = (Array.isArray(arr) ? arr[0] : arr) || {};
        } else {
          resolved = { _error: 'getContactLidAndPhone not available in this wwebjs version' };
        }
      } catch (e) { resolved = { _error: e.message }; }

      const report = diag.buildReport({
        message: { id: msg.id && msg.id._serialized, from: msg.from, author: msg.author, to: msg.to, fromMe: msg.fromMe, type: msg.type, notifyName: msg._data && msg._data.notifyName },
        contact, chat, resolved,
      });
      printReport(report);
    } catch (err) {
      console.error('[diag] handler error:', err.message);
    }
  });

  await client.initialize();
  process.on('SIGINT', async () => { console.log('\n[diag] stopping'); try { await client.destroy(); } catch (_) {} process.exit(0); });
}

function runSimulate() {
  console.log('── WhatsApp LID diagnostics (SIMULATE — report shape only) ──');
  // Case A: LID with NO phone resolvable (what the operator observed).
  printReport(diag.buildReport({
    message: { id: 'false_37087478829063@lid_ABC', from: '37087478829063@lid', author: '37087478829063@lid', to: 'me@c.us', fromMe: false, type: 'chat', notifyName: 'Мой Билайн' },
    contact: { id: { _serialized: '37087478829063@lid', server: 'lid', user: '37087478829063' }, number: '37087478829063', name: 'Мой Билайн', pushname: 'Мой Билайн', isBusiness: false, isWAContact: true, isMyContact: true, type: 'in' },
    chat:    { id: { _serialized: '37087478829063@lid' }, name: 'Мой Билайн', isGroup: false },
    resolved: {}, // resolver returned nothing → no phone
  }));
  // Case B: same event but the resolver DID return a phone (Store had the mapping).
  printReport(diag.buildReport({
    message: { id: 'false_37087478829063@lid_DEF', from: '37087478829063@lid', author: '37087478829063@lid', to: 'me@c.us', fromMe: false, type: 'chat', notifyName: 'Мой Билайн' },
    contact: { id: { _serialized: '37087478829063@lid', server: 'lid', user: '37087478829063' }, number: '37087478829063', name: 'Мой Билайн', pushname: 'Мой Билайн', isBusiness: false, isWAContact: true, isMyContact: true, type: 'in' },
    chat:    { id: { _serialized: '37087478829063@lid' }, name: 'Мой Билайн', isGroup: false },
    resolved: { lid: '37087478829063@lid', pn: '996700112233@c.us' }, // resolved!
  }));
  console.log('\nSIMULATE complete (no WhatsApp connection, no writes).');
}

(async () => { if (SIMULATE) runSimulate(); else await runLive(); })().catch(err => { console.error('[diag] fatal:', err.message); process.exit(1); });
