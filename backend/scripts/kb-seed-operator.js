#!/usr/bin/env node
'use strict';

// scripts/kb-seed-operator.js — load the operator Master Knowledge Base (V2) into the
// KB as APPROVED, source:'operator' entries (the highest-priority knowledge source).
// Supersedes older operator versions. Entries that conflict with canonical operational
// data are seeded PENDING (held for an operator decision), not activated.
//
// No WhatsApp/Declaration/Gmail writes — only the kb_entries replica.
//
// Usage: node scripts/kb-seed-operator.js

require('dotenv').config();
const mongoose = require('mongoose');
const kb        = require('../src/knowledge/operatorMasterKbV2');
const kbService = require('../src/services/knowledgeBaseService');

(async () => {
  try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }); }
  catch (e) { console.error('[kb-seed] mongo connection failed — cannot persist:', e.message); process.exit(1); }

  const res = await kbService.seedOperatorKnowledge(kb);
  console.log(`[kb-seed] ${res.version} (${res.source}) → approved=${res.approved}, held=${res.held}, total=${res.total}`);
  if (res.held > 0) console.log('[kb-seed] NOTE: held entries are PENDING (conflict awaiting operator decision) — see review_note.');

  await mongoose.disconnect().catch(() => {});
})().catch(err => { console.error('[kb-seed] fatal:', err.message); process.exit(1); });
