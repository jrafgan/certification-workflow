'use strict';

// Tests for the Unified Operator Workspace assembler (services/orderWorkspaceService.
// assembleWorkspace — pure). No DB. Run: node tests/order-workspace.test.js

const assert = require('assert');
const { assembleWorkspace } = require('../src/services/orderWorkspaceService');

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (err) { fail++; failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const ORDER = {
  _id: 'ord1',
  status: 'На согласовании',
  balance_due: 6000,
  client: { name: 'Иван', companyName: 'ОсОО Мегуми', phone: '+996700111222', email: 'a@b.kg' },
  payments: [{ date: new Date('2026-06-01'), amount: 15000, method: 'transfer', voided: false }],
  layouts: [{ version: 1, file_name: 'макет_ОсОО Мегуми.docx', received_at: new Date('2026-06-10'), sent_to_client_at: new Date('2026-06-11'), client_decision: null }],
  original: {},
};

console.log('\n[assembleWorkspace]');

test('aggregates the core sections from one order', () => {
  const w = assembleWorkspace({ order: ORDER });
  assert.strictEqual(w.order_id, 'ord1');
  assert.strictEqual(w.status, 'На согласовании');
  assert.strictEqual(w.balance_due, 6000);
  assert.strictEqual(w.client.company, 'ОсОО Мегуми');
  assert.strictEqual(w.payments.length, 1);
  assert.strictEqual(w.mockups.length, 1);
  assert.strictEqual(w.recommend_only, true);
});

test('declaration absent → present:false', () => {
  const w = assembleWorkspace({ order: ORDER });
  assert.strictEqual(w.declaration.present, false);
});

test('declaration present → mirrored fields', () => {
  const w = assembleWorkspace({ order: ORDER, declaration: { status: 'На согласовании', phone: '+996700111222', payment_amount: 15000, client_name: 'ОсОО Мегуми', sheet_row_id: 'r12' } });
  assert.strictEqual(w.declaration.present, true);
  assert.strictEqual(w.declaration.sheet_row_id, 'r12');
});

test('WhatsApp history capped and normalized (latest 25)', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ direction: 'in', from_phone: '+996700111222', body: `m${i}`, received_at: new Date() }));
  const w = assembleWorkspace({ order: ORDER, whatsapp: msgs });
  assert.strictEqual(w.whatsapp.length, 25);
  assert.strictEqual(w.counts.whatsapp, 30);
});

test('attachments aggregated from layouts + whatsapp media + lab replies', () => {
  const w = assembleWorkspace({
    order: ORDER,
    whatsapp: [{ from_phone: 'x', file_name: 'cert.pdf', media_ref: 'r', mime_type: 'application/pdf', received_at: new Date() }],
    emails: [{ thread_id: 't1', reply_has_attachment: true }],
  });
  const sources = w.attachments.map(a => a.source).sort();
  assert.deepStrictEqual(sources, ['email', 'mockup', 'whatsapp']);
});

test('status verification surfaced when provided', () => {
  const w = assembleWorkspace({ order: ORDER, statusVerification: { current_status: 'На согласовании', proposed_status: 'Ждем оригинал', confidence: 85, confidence_band: 'HIGH', recommend: true, findings: [], reasoning: 'x' } });
  assert.strictEqual(w.status_verification.proposed_status, 'Ждем оригинал');
  assert.strictEqual(w.status_verification.recommend, true);
});

test('recommendations normalize audits + email drafts', () => {
  const w = assembleWorkspace({
    order: ORDER,
    audits: [{ _id: 'a1', state: 'pending', current_status: 'На согласовании', proposed_status: 'Ждем оригинал', confidence_band: 'HIGH', recommend: true }],
    emailDrafts: [{ _id: 'e1', state: 'pending_approval', subject: 'Заявка — ОсОО Мегуми', to_email: 'lab@x.kg', draft_type: 'lab_request' }],
  });
  assert.strictEqual(w.recommendations.length, 2);
  assert.ok(w.recommendations.some(r => r.type === 'status_audit'));
  assert.ok(w.recommendations.some(r => r.type === 'email_draft'));
});

test('dangers passed through; counts reflect everything', () => {
  const w = assembleWorkspace({ order: ORDER, dangers: [{ type: 'completed_with_debt', severity: 'HIGH' }] });
  assert.strictEqual(w.dangers.length, 1);
  assert.strictEqual(w.counts.dangers, 1);
  assert.strictEqual(w.counts.payments, 1);
});

test('empty order does not throw', () => {
  const w = assembleWorkspace({ order: {} });
  assert.strictEqual(w.status, null);
  assert.strictEqual(w.payments.length, 0);
  assert.strictEqual(w.recommend_only, true);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`)); process.exit(1); }
process.exit(0);
