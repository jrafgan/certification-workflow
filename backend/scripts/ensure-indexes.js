#!/usr/bin/env node
'use strict';

/**
 * ensure-indexes.js — Production-safe index creation for all collections.
 *
 * Uses createIndexes() which is additive — never drops existing indexes.
 * Safe to run multiple times on every deploy or after schema changes.
 *
 * Do NOT use syncIndexes() in production: it drops indexes not in the schema,
 * which would destroy any manually-created performance indexes.
 *
 * Usage:
 *   node scripts/ensure-indexes.js
 *   MONGODB_URI=mongodb://... node scripts/ensure-indexes.js
 *
 * Exit codes:
 *   0 — all indexes created or already existed
 *   1 — one or more models failed (E11000 duplicate data, auth error, etc.)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI environment variable is not set.');
    console.error('       Set it in backend/.env or pass it directly:');
    console.error('       MONGODB_URI=mongodb://... node scripts/ensure-indexes.js');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri, { autoIndex: false });
  console.log('Connected.\n');

  // ─── Replica set check ──────────────────────────────────────────────────────
  // Transactions (linkThread atomic write — Future Consistency Improvement) require
  // a replica set. This is informational only; index creation proceeds regardless.
  try {
    const status = await mongoose.connection.db.admin().command({ isMaster: 1 });
    if (status.setName) {
      console.log(`Replica set: ${status.setName}`);
    } else {
      console.warn('WARN: MongoDB is not running as a replica set.');
      console.warn('      Transactions (linkThread Future Consistency Improvement) will not be available.');
      console.warn('      See: labCommService.js — TODO: Future Consistency Improvement\n');
    }
  } catch (_) {
    // Non-fatal — index creation proceeds regardless of replica set status
  }

  // ─── Register all models ────────────────────────────────────────────────────
  // Require each model file explicitly so this script is self-contained and does
  // not depend on models/index.js implementation details.
  require('../src/models/Order');
  require('../src/models/Task');
  require('../src/models/Declaration');
  require('../src/models/LabCommThread');

  const modelNames = mongoose.modelNames();
  console.log(`Creating indexes for ${modelNames.length} model(s)...\n`);

  let exitCode = 0;

  for (const name of modelNames) {
    const model = mongoose.model(name);
    try {
      await model.createIndexes();
      console.log(`  [OK]   ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      if (err.code === 11000) {
        console.error(
          `         Duplicate key error — the collection has data that violates a unique index.\n` +
          `         Run the deduplication diagnostic before retrying:\n` +
          `         See: docs/DATABASE_DESIGN.md — Indexes on lab_comm_threads`
        );
      }
      exitCode = 1;
    }
  }

  console.log('');
  await mongoose.disconnect();

  if (exitCode === 0) {
    console.log('All indexes created/verified successfully.');
  } else {
    console.error('One or more models failed. Review output above before deploying.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
