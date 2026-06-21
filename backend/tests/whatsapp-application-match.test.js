'use strict';

// Pure unit tests for Sprint 3 — match WhatsApp conversation ↔ New Application
// submission using phone + legal entity + timestamp. No sheet I/O, no DB.
//
// Run: node tests/whatsapp-application-match.test.js (npm run test:whatsapp-application)

const assert = require('assert');
const {
  matchConversationToApplications, entityScore, timeScore,
  detectFilledFormIntent, classifyContact, findSilentApplications,
} = require('../src/services/applicationMatchService');
const { mapHeader, rowsToApplications } = require('../src/integrations/newApplicationsClient');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const T0 = '2026-05-20T10:00:00Z';
const APPS = [
  { row: 2, phone: '+996777240858', legal_entity: 'ИП Парманова Кенжегул', submitted_at: '2026-05-20T09:30:00Z' },
  { row: 3, phone: '0700111222',    legal_entity: 'ОсОО BACCI',            submitted_at: '2026-05-19T08:00:00Z' },
  { row: 4, phone: '+996777240858', legal_entity: 'ИП Иманова Жылдыз',     submitted_at: '2026-04-01T08:00:00Z' },
];

// ─── signal helpers ──────────────────────────────────────────────────────────
test('entityScore: fraction of entity tokens present in conversation text', () => {
  assert.strictEqual(entityScore('здравствуйте, это парманова кенжегул', 'ИП Парманова Кенжегул'), 1);
  assert.ok(entityScore('парманова', 'ИП Парманова Кенжегул') > 0 && entityScore('парманова', 'ИП Парманова Кенжегул') < 1);
  assert.strictEqual(entityScore('', 'ИП X'), 0);
});

test('timeScore: 1 when simultaneous, 0 outside window', () => {
  assert.strictEqual(timeScore(T0, T0), 1);
  assert.strictEqual(timeScore(T0, '2026-01-01T00:00:00Z'), 0); // far outside 72h
  assert.ok(timeScore(T0, '2026-05-20T09:30:00Z') > 0.9);       // 30 min apart
});

// ─── matching ────────────────────────────────────────────────────────────────
test('unique phone + entity + close time → matched / HIGH', () => {
  const conv = { phone: '777240858', text: 'это парманова кенжегул, по декларации', timestamp: T0 };
  // restrict to apps where phone is unique: rows 2 and 4 share the phone, so use a single-phone set
  const r = matchConversationToApplications(conv, [APPS[1], { ...APPS[0], phone: '0701234567' }]);
  // here only the BACCI app would phone-match nobody; craft a clean unique case instead:
  const clean = matchConversationToApplications(
    { phone: '700111222', text: 'добрый день, осоо bacci', timestamp: '2026-05-19T08:10:00Z' },
    [APPS[1], APPS[2]],
  );
  assert.strictEqual(clean.status, 'matched');
  assert.strictEqual(clean.confidence, 'HIGH');
  assert.strictEqual(clean.candidates[0].row, 3);
});

test('phone shared by multiple applications → needs_review (filter, not resolver)', () => {
  const conv = { phone: '+996777240858', text: 'парманова', timestamp: T0 };
  const r = matchConversationToApplications(conv, APPS); // rows 2 and 4 share the phone
  assert.strictEqual(r.status, 'needs_review');
  assert.ok(r.candidates.filter(c => c.signals.phone).length === 2);
  // entity + timestamp still RANK them — Парманова (row 2) should outrank Иманова (row 4)
  assert.strictEqual(r.candidates[0].row, 2);
});

test('no phone but strong entity + time → needs_review candidate (not auto-matched)', () => {
  const conv = { phone: '700999999', text: 'это осоо bacci', timestamp: '2026-05-19T08:05:00Z' };
  const r = matchConversationToApplications(conv, APPS);
  assert.notStrictEqual(r.status, 'matched'); // never auto-match without strong combined evidence
  assert.ok(r.candidates.some(c => c.row === 3));
});

test('nothing matches → unmatched', () => {
  const r = matchConversationToApplications({ phone: '700000000', text: 'привет', timestamp: T0 }, APPS);
  assert.strictEqual(r.status, 'unmatched');
  assert.strictEqual(r.candidates.length, 0);
});

// ─── header mapping ──────────────────────────────────────────────────────────
test('mapHeader resolves Russian Google-Form headers', () => {
  const cols = mapHeader(['Отметка времени', 'Клиент (ИП/ОсОО)', 'Номер тел:', 'Документ']);
  assert.strictEqual(cols.submitted_at, 0);
  assert.strictEqual(cols.legal_entity, 1);
  assert.strictEqual(cols.phone, 2);
});

test('rowsToApplications maps rows; empty sheet → reason empty', () => {
  assert.strictEqual(rowsToApplications([]).reason, 'empty');
  const out = rowsToApplications([
    ['Отметка времени', 'Клиент', 'Номер тел:'],
    ['2026-05-20 09:30:00', 'ИП Парманова', '0777240858'],
    ['', '', ''],
  ]);
  assert.strictEqual(out.applications.length, 1);
  assert.strictEqual(out.applications[0].legal_entity, 'ИП Парманова');
  assert.strictEqual(out.applications[0].phone, '0777240858');
});

// ─── Scenario classification (Application Matching hardening) ──────────────────
test('detectFilledFormIntent recognizes RU "I filled the form" phrasings', () => {
  assert.strictEqual(detectFilledFormIntent('Я заполнил заявку').claims_filled, true);
  assert.strictEqual(detectFilledFormIntent('заявку заполнила, отправила').claims_filled, true);
  assert.strictEqual(detectFilledFormIntent('отправил форму').claims_filled, true);
  assert.strictEqual(detectFilledFormIntent('сколько стоит декларация?').claims_filled, false);
});

test('scenario MATCHED — phone uniquely maps to one application', () => {
  const r = classifyContact({ phone: '700111222', text: 'добрый день, осоо bacci', timestamp: '2026-05-19T08:10:00Z' }, [APPS[1], APPS[2]]);
  assert.strictEqual(r.scenario, 'MATCHED');
  assert.strictEqual(r.confidence, 'HIGH');
});

test('scenario POSSIBLE_ADDITIONAL_PHONE — entity matches but phone differs (Entity > Phone)', () => {
  // entity "осоо bacci" matches row 3, but WhatsApp phone is different
  const r = classifyContact({ phone: '700999999', text: 'это осоо bacci, по заявке', timestamp: '2026-05-19T08:05:00Z' }, [APPS[1], APPS[2]]);
  assert.strictEqual(r.scenario, 'POSSIBLE_ADDITIONAL_PHONE');
  assert.strictEqual(r.proposals[0].action, 'possible_additional_phone_for_client');
  assert.ok(/additional phone number for existing client/i.test(r.proposals[0].detail));
  assert.strictEqual(r.proposals[0].write, false); // no auto-merge / auto-correct
});

test('scenario CLAIMS_FILLED_NO_APPLICATION — says filled but nothing matches', () => {
  const r = classifyContact({ phone: '700000000', text: 'Здравствуйте, я заполнил заявку', timestamp: T0 }, APPS);
  assert.strictEqual(r.scenario, 'CLAIMS_FILLED_NO_APPLICATION');
  assert.strictEqual(r.claims_filled, true);
  assert.strictEqual(r.proposals[0].action, 'verify_application_submitted');
});

test('scenario NO_APPLICATION — wrote but no application and no claim', () => {
  const r = classifyContact({ phone: '700000000', text: 'привет, сколько стоит?', timestamp: T0 }, APPS);
  assert.strictEqual(r.scenario, 'NO_APPLICATION');
  assert.strictEqual(r.proposals[0].action, 'treat_as_new_lead');
});

test('scenario AMBIGUOUS — phone maps to multiple applications', () => {
  const r = classifyContact({ phone: '+996777240858', text: 'здравствуйте', timestamp: T0 }, APPS);
  assert.strictEqual(r.scenario, 'AMBIGUOUS_MULTIPLE_APPLICATIONS');
  assert.strictEqual(r.proposals[0].action, 'operator_select_application');
});

test('findSilentApplications — application exists but client never wrote', () => {
  // contacted phones include only BACCI (row 3); rows 2 and 4 are silent
  const silent = findSilentApplications(APPS, ['0700111222']);
  const rows = silent.map(s => s.row).sort();
  assert.deepStrictEqual(rows, [2, 4]);
  assert.strictEqual(silent[0].proposal.action, 'operator_outreach');
  assert.strictEqual(silent[0].proposal.write, false);
});

console.log(`\nWhatsApp ↔ Application matching (Sprint 3): ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(` - ${f.name}: ${f.err.message}`)); process.exit(1); }
