#!/usr/bin/env node
'use strict';

// scripts/whatsapp-listen.js — start the WhatsApp Web client, log in via QR
// (first run), persist the session, and ingest INBOUND messages + attachments
// into MongoDB (whatsapp_messages), running phone→order matching on each.
//
// It NEVER sends a message, NEVER modifies the Declaration, NEVER touches Gmail.
//
// Usage:
//   node scripts/whatsapp-listen.js      # first run prints a QR to scan on the
//                                         # Dokumenty.pro WhatsApp Business phone
//   (subsequent runs reuse the saved session — no QR)

require('dotenv').config();
const mongoose = require('mongoose');
const { startClient } = require('../src/integrations/whatsappWebClient');
const ingestService = require('../src/services/whatsappIngestService');

(async () => {
  console.log('── WhatsApp listener (receive-only) ──');

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('[whatsapp] mongo connected:', process.env.MONGODB_URI);
  } catch (err) {
    console.error('[whatsapp] MongoDB connection failed — incoming messages cannot be stored:', err.message);
    process.exit(1);
  }

  // `client` is assigned by the await below; by the time messages arrive it is set,
  // so the resolver closure can call the live LID↔phone resolver.
  let client;
  const lidResolver = (ids) =>
    (client && typeof client.getContactLidAndPhone === 'function')
      ? client.getContactLidAndPhone(ids)
      : Promise.resolve([]);

  client = await startClient({
    onIncoming: async (raw) => {
      try {
        const res = await ingestService.ingestIncoming(raw, { lidResolver });
        if (res.skipped) {
          console.log('[whatsapp] ingest skipped (duplicate):', String(res.messageId));
          return;
        }
        const m = res.match || {};
        console.log('[whatsapp] ingested:', JSON.stringify({
          id: String(res.message._id),
          from: res.message.from_phone,
          match_status: m.match_status,
          confidence: m.match_confidence,
          candidates: (m.candidates || []).length,
        }));
      } catch (err) {
        console.error('[whatsapp] ingest error:', err.message);
      }
    },
  });

  console.log('[whatsapp] listener running. Press Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    console.log('\n[whatsapp] shutting down...');
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
})().catch(err => {
  console.error('[whatsapp] fatal:', err.message);
  process.exit(1);
});
