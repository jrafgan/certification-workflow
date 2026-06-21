'use strict';
// READ-ONLY WhatsApp understanding eval over the AVAILABLE test corpus (developer
// fixtures — synthetic but representative RU customer messages; the real stored corpus
// lives in Mongo which is offline, and live WhatsApp is intentionally excluded). Runs the
// ACTUAL available signals: paymentRecognitionService (payment intent), fileClassifierService
// (attachment type). There is NO conversation intent / stage / customer-state classifier in
// the codebase — this eval makes that gap concrete.
const pay = require('../src/services/paymentRecognitionService');
const fc  = require('../src/services/fileClassifierService');

const CORPUS = [
  { id:'C1', body:'Здравствуйте, я оплатил 15000 сом за декларацию', attachments:[{file_name:'чек.jpg', mime_type:'image/jpeg'}] },
  { id:'C2', body:'оплату отправил, проверьте пожалуйста', attachments:[] },
  { id:'C3', body:'сколько стоит сертификат?', attachments:[] },
  { id:'C4', body:'это парманова кенжегул, по декларации', attachments:[] },
  { id:'C5', body:'добрый день, осоо bacci', attachments:[] },
  { id:'C6', body:'Здравствуйте, я заполнил заявку', attachments:[] },
  { id:'C7', body:'макет согласовываю, всё хорошо', attachments:[] },
  { id:'C8', body:'когда будет готово?', attachments:[] },
  { id:'C9', body:'отправляю свидетельство ИП', attachments:[{file_name:'свидетельство_ИП.pdf', mime_type:'application/pdf'}] },
  { id:'C10', body:'нужно внести правки в макет', attachments:[] },
];

// The intents the BUSINESS needs vs. what the system can actually detect.
const BUSINESS_INTENTS = ['payment_made','price_question','identify_self','application_filed','layout_approval','layout_corrections','status_query','document_sent'];
function systemCanDetect(msg){
  const r = pay.recognizeFromMessage(msg);
  const files = (msg.attachments||[]).map(a=>fc.classifyAttachment(a));
  const detected = [];
  if (r.has_payment_signal) detected.push(`payment(${r.confidence}${r.amount?','+r.amount:''})`);
  for (const f of files) if (f.category!=='unknown') detected.push(`file:${f.category}(${f.confidence})`);
  return { detected, payment:r };
}

console.log('# WHATSAPP UNDERSTANDING EVAL (available test corpus — synthetic fixtures)\n');
let intentCovered=0, stateNone=0;
for (const m of CORPUS){
  const d = systemCanDetect(m);
  console.log('────────────────────────────────────────');
  console.log(`${m.id}: "${m.body}"`);
  console.log(`   detected_intent:   ${d.detected.length? d.detected.join(', ') : '— NONE (no classifier fired)'}`);
  console.log(`   detected_stage:    — (no conversation-stage model)`);
  console.log(`   detected_customer_state: — (no customer-state model)`);
  console.log(`   confidence:        ${d.detected.length? (d.payment.has_payment_signal?d.payment.confidence:'see file') : 'NONE'}`);
  if (d.detected.length) intentCovered++; else stateNone++;
}
console.log(`\n══════════ AGGREGATE ══════════`);
console.log(`messages: ${CORPUS.length}`);
console.log(`messages with ANY system detection: ${intentCovered}/${CORPUS.length}`);
console.log(`messages the system is blind to:    ${stateNone}/${CORPUS.length}`);
console.log(`business intents needed: ${BUSINESS_INTENTS.length} | intents with a detector: 2 (payment_made, document_sent via file type)`);
console.log(`stage model: NONE | customer-state model: NONE`);
