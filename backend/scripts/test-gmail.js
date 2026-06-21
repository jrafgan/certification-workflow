#!/usr/bin/env node
'use strict';

/**
 * test-gmail.js — Gmail connectivity test.
 *
 * Verifies that the configured Google OAuth credentials can authenticate
 * against the Gmail API and read inbox threads. This is a read-only smoke
 * test: it reuses the existing gmailClient integration (gmail.readonly scope)
 * and never sends, modifies, or deletes mail.
 *
 * It does NOT implement polling — it makes a single, on-demand set of calls
 * and exits.
 *
 * What it checks:
 *   1. Required Google env vars are present.
 *   2. getProfile succeeds  → OAuth refresh token is valid (authentication).
 *   3. inbox threads list    → the API can read inbox threads (authorization).
 *
 * Usage:
 *   node scripts/test-gmail.js
 *   node scripts/test-gmail.js "in:inbox newer_than:7d"   # custom query
 *
 * Exit codes:
 *   0 — authenticated and able to read inbox threads
 *   1 — missing config, auth failure, or API error
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_REFRESH_TOKEN',
];

async function main() {
  // ─── 1. Config check ────────────────────────────────────────────────────────
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('ERROR: missing required environment variable(s):');
    missing.forEach(key => console.error(`       - ${key}`));
    console.error('\n       Set them in backend/.env (see backend/.env.example).');
    process.exit(1);
  }

  // Loaded after the env check so missing credentials produce a clear message
  // rather than a downstream auth error.
  const gmailClient = require('../src/integrations/gmailClient');

  // ─── 2. Authentication ──────────────────────────────────────────────────────
  console.log('Authenticating with Gmail (getProfile)...');
  const operatorEmail = await gmailClient.getOperatorEmail();
  console.log(`  [OK]   Authenticated as: ${operatorEmail}\n`);

  // ─── 3. Read inbox threads ──────────────────────────────────────────────────
  const query = process.argv[2] || 'in:inbox';
  console.log(`Reading inbox threads (query: "${query}")...`);
  const threads = await gmailClient.searchThreads(query, 5);

  if (threads.length === 0) {
    console.log('  [OK]   API reachable — no threads matched the query.\n');
  } else {
    console.log(`  [OK]   Read ${threads.length} thread(s):\n`);
    threads.forEach((t, i) => {
      const date = t.date ? t.date.toISOString().slice(0, 10) : '----------';
      console.log(`    ${i + 1}. [${date}] ${t.subject}`);
      console.log(`       from: ${t.from || '(unknown)'}  ·  messages: ${t.messageCount}` +
                  `${t.hasAttachment ? '  ·  has attachment' : ''}`);
    });
    console.log('');
  }

  console.log('Gmail connectivity test passed: API can read inbox threads.');
}

main().catch(err => {
  console.error('\nGmail connectivity test FAILED.');
  console.error(`  ${err.code || err.name || 'Error'}: ${err.message}`);
  if (err.code === 'GMAIL_AUTH_ERROR' || err?.response?.status === 401 || err?.response?.status === 403) {
    console.error('  Hint: the OAuth refresh token may be expired or revoked — re-authorize the Google account.');
  }
  process.exit(1);
});
