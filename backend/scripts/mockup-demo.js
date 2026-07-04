#!/usr/bin/env node
'use strict';

// scripts/mockup-demo.js — end-to-end Mockup Agent demo (no email sending).
// Google-Form row → Mockup Agent → DS DOCX draft → attachment (if multi-TN VED) → lab package
// preview. Renders against the REAL DS template (templates/mockup/declaration.docx).
//
// Run: node scripts/mockup-demo.js

const path = require('path');
const cp = require('child_process');
const m = require('../src/services/mockupAgentService');

// A representative Google-Form row (11 canonical fields). Multi-TN VED → exercises §7 attachment.
const application = {
  doc_type: 'декларация',
  applicant: {
    name: 'ОсОО Мегуми',
    inn: '02408202310123',
    address: 'Кыргызская Республика, г. Бишкек, ул. Чуй 1',
    phone: '+996700112233',
    email: 'megumi@example.kg',
  },
  manufacturer: { name: 'ООО Мегуми Текстиль', country: 'Кыргызстан', address: 'г. Бишкек, ул. Промышленная 5' },
  brand: 'Megumi',
  items: [
    { name: 'Блузка женская', composition: '100% хлопок', tnved: '6206300000' },
    { name: 'Юбка женская',   composition: '100% хлопок', tnved: '6204520000' },
  ],
};

const templateDir = path.join(__dirname, '..', 'templates', 'mockup');
const outDir = path.join(__dirname, '..', 'tmp', 'mockup-demo');

console.log('\n=== STEP 1: Google Form row ===');
console.log(JSON.stringify(application, null, 2));

const proposal = m.proposeMockup(application, { templateDir, outDir });

console.log('\n=== STEP 2: Mockup Agent → draft proposal ===');
console.log('doc_type           :', proposal.doc_type);
console.log('status             :', proposal.status, '| auto_send:', proposal.auto_send);
console.log('requires approvals :', JSON.stringify(proposal.requires));
console.log('warnings (§6)      :', proposal.warnings.length ? proposal.warnings : 'none');
console.log('rendered           :', proposal.rendered, proposal.render_blocked ? `(blocked: ${proposal.render_blocked})` : '');

console.log('\n=== STEP 3: Generated DOCX draft ===');
console.log('file name          :', proposal.mockup_file_name);
console.log('path               :', proposal.document_path);
console.log('unmapped placeholders left intact:', proposal.missing_placeholders);

console.log('\n=== STEP 4: Generated attachment (§7, multi-TN VED) ===');
if (proposal.attachment_path) {
  console.log('file name          :', proposal.attachment_file_name);
  console.log('path               :', proposal.attachment_path);
  console.log('table rows         :', JSON.stringify(proposal.attachment.rows));
} else {
  console.log('no attachment (single TN VED)');
}

console.log('\n=== STEP 5: Laboratory package preview (NO sending) ===');
const standardEmailText =
  `Кому: Дастан Акматов <standartpro98@gmail.com>\nТема: ${application.applicant.name}\n\n` +
  `Здравствуйте! Просьба оформить ДС. Приложены: макет, приложение (таблица товаров), свидетельство клиента. ` +
  `Количество дополнительных ПИ: по составам. Спасибо.`;
const pkg = m.buildLabPackage(proposal, {
  clientCertPath: '/path/to/client_IP_certificate.jpg',
  standardEmailText,
});
console.log(JSON.stringify(pkg, null, 2));

// Proof the real template actually got filled (read back values from the produced docx).
console.log('\n=== VERIFY: values present in generated мокап DOCX ===');
const text = cp.execFileSync('unzip', ['-p', proposal.document_path, 'word/document.xml']).toString().replace(/<[^>]+>/g, '');
for (const probe of ['ОсОО Мегуми', '02408202310123', 'Megumi', 'см. приложение']) {
  console.log(`  ${text.includes(probe) ? '✓' : '✗'} "${probe}"`);
}
const leftAngles = (text.match(/<[A-Z_]+>/g) || []);
console.log('  remaining <FIELD> tokens in output:', leftAngles.length ? leftAngles.join(' ') : 'none of the mapped fields (good)');
console.log('\nDONE — nothing was sent. Artifacts in', outDir, '\n');
