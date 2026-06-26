'use strict';

// tests/whatsapp-readstate-guard.test.js — CI INVARIANT GUARD.
//
// Unread-state preservation is an ENFORCED invariant, not a convention. The WhatsApp
// integration must NEVER mark chats read / unread or send read receipts: doing so on the
// operator's shared WhatsApp account would clear unread on the operator's own phone.
//
// This guard fails CI if any read-state-mutation API appears in PRODUCTION code
// (src/ + scripts/). It strips comments AND string/template literals first, so the
// documented SAFETY COMMENTS that mention these APIs (e.g. whatsappWebClient.js: "it
// never calls chat.sendSeen() / msg.markUnread()") do NOT trip the guard — only real
// code usage does.
//
// To intentionally allow a new API name, edit DENYLIST below (with review). To reference
// these names in prose, put them in a comment or string — those are not scanned.
//
// Run: node tests/whatsapp-readstate-guard.test.js

const fs   = require('fs');
const path = require('path');

// The enforced denylist of read-state-mutation APIs (whatsapp-web.js + equivalents).
// Matched as whole-word identifiers in code (after comment/string stripping).
const DENYLIST = [
  'sendSeen',         // Chat.sendSeen() / Client.sendSeen() — marks a chat READ (blue ticks)
  'markUnread',       // Chat.markUnread() — flips read→unread
  'markChatUnread',   // equivalent unread mutation
  'sendReadReceipt',  // explicit read receipt
  'markSeen',         // equivalent "seen" mutation
  'markChatRead',     // equivalent read mutation
];

// Production trees to scan (NOT tests/ — this guard and safety tests legitimately name them).
const SCAN_ROOTS = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'scripts')];

// stripCommentsAndStrings — replace the contents of // line comments, /* */ block comments,
// and ' " ` string/template literals with spaces, preserving newlines so line numbers stay
// accurate. A small character-level state machine (no parser dependency).
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    // string/template literals: honor backslash escapes; keep newlines
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += ' '; i++; continue; }
    out += (c === '\n' ? '\n' : ' '); i++; continue;
  }
  return out;
}

function listJsFiles(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...listJsFiles(full));
    } else if (entry.isFile() && full.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

const patterns = DENYLIST.map(name => ({ name, re: new RegExp('\\b' + name + '\\b') }));
const violations = [];
let filesScanned = 0;

for (const root of SCAN_ROOTS) {
  for (const file of listJsFiles(root)) {
    filesScanned++;
    const code = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, idx) => {
      for (const { name, re } of patterns) {
        if (re.test(line)) {
          violations.push({ file: path.relative(path.join(__dirname, '..'), file), line: idx + 1, api: name, text: line.trim().slice(0, 120) });
        }
      }
    });
  }
}

console.log(`\n[whatsapp read-state guard] scanned ${filesScanned} file(s) in src/ + scripts/`);
console.log(`[whatsapp read-state guard] denylist: ${DENYLIST.join(', ')}`);

if (violations.length) {
  console.log(`\n  FAIL  ${violations.length} read-state-mutation usage(s) found in PRODUCTION code:`);
  for (const v of violations) {
    console.log(`        ${v.file}:${v.line}  →  ${v.api}()`);
    console.log(`          ${v.text}`);
  }
  console.log('\nUnread-state preservation is an enforced invariant. These APIs must not be called.');
  console.log('If you mean to reference the name in prose, move it into a comment or string.');
  process.exit(1);
}

console.log('  PASS  no read-state-mutation APIs in production code — unread invariant holds.\n');
process.exit(0);
