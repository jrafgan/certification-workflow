#!/usr/bin/env node
'use strict';

/**
 * scan-lab-attention.js — Unanswered laboratory communication scan.
 *
 * First business-value feature, phase: "Unanswered laboratory communication".
 *
 * Finds linked lab threads that are still waiting on a reply and whose SLA
 * deadline has passed, then raises a `remind_lab` attention task for each
 * through the existing task system (taskService — with built-in deduplication).
 *
 * This is a pure database scan. It does NOT poll Gmail, send email, auto-reply,
 * or use AI. It reads the persisted LabCommThread state and reuses the existing
 * labCommService deadline/SLA logic.
 *
 * Usage:
 *   node scripts/scan-lab-attention.js
 *   MONGODB_URI=mongodb://... node scripts/scan-lab-attention.js
 *
 * Exit codes:
 *   0 — scan completed
 *   1 — missing config or runtime error
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mongoose       = require('mongoose');
const labCommService = require('../src/services/labCommService');

// Register models referenced by the scan (Order, Task, LabCommThread are required
// transitively by the services, but require them explicitly so the script is
// self-contained and does not depend on models/index.js load order).
require('../src/models/Order');
require('../src/models/Task');
require('../src/models/LabCommThread');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI environment variable is not set.');
    console.error('       Set it in backend/.env or pass it directly:');
    console.error('       MONGODB_URI=mongodb://... node scripts/scan-lab-attention.js');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected.\n');

  console.log('Scanning for unanswered lab threads beyond SLA...');
  const result = await labCommService.scanUnansweredThreads();

  console.log('');
  console.log(`  waiting threads scanned : ${result.scanned}`);
  console.log(`  beyond SLA (overdue)    : ${result.overdue}`);
  console.log(`  attention tasks created : ${result.tasksCreated}`);
  console.log('');

  if (result.overdue > 0 && result.tasksCreated < result.overdue) {
    console.log('Note: some overdue threads already had an open remind_lab task ' +
                '(deduplicated by the task system).');
  }

  await mongoose.disconnect();
  console.log('Scan complete.');
}

main().catch(async err => {
  console.error('\nLab attention scan FAILED.');
  console.error(`  ${err.code || err.name || 'Error'}: ${err.message}`);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
