'use strict';

// config/labRecipients.js — laboratory / issuing-body email recipients (single source of truth).
//
// All recipients are env-overridable so addresses change WITHOUT code edits.
//
// СС (сертификат) → Kyrgyz Test - Бермет <mng-1@kyrgyz-test.kg>.
//
// ДС (декларация) routing depends on whether the client has ДОКУМЕНТЫ НА ШВЕЙНЫЙ ЦЕХ —
// this picks BOTH the price/validity (see piCalculationService) AND the issuing body:
//   • ЕСТЬ документы на цех  → Айсулуу <servisstan@internet.ru> (срок 1 год, база 17 000).
//   • НЕТ документов на цех → Айгерим <svnsert7@gmail.com> (срок 3 года, база 18 000).
//   • Неизвестно (ещё не уточнили у клиента) → получателя нет, письмо не отправляется.
// Дастану БОЛЬШЕ НЕ ПИШЕМ. The agent MUST ask the client about цех-documents before launching.

const SS = {
  lab:            process.env.LAB_BERMET_LAB   || 'Бермет',
  recipient_name: process.env.LAB_BERMET_NAME  || 'Kyrgyz Test - Бермет',
  email:          process.env.LAB_BERMET_EMAIL || 'mng-1@kyrgyz-test.kg',
};

// ДС, нет документов на цех — Айгерим <svnsert7@gmail.com>, 3 года, база 18 000.
const DS_NO_WORKSHOP = {
  variant:        'no_workshop',
  lab:            process.env.LAB_DS_NO_WORKSHOP_LAB  || '',
  recipient_name: process.env.LAB_DS_NO_WORKSHOP_NAME || 'Айгерим',
  email:          process.env.LAB_DS_NO_WORKSHOP_EMAIL || 'svnsert7@gmail.com',
};

// ДС, есть документы на цех — Айсулуу <servisstan@internet.ru>, 1 год, база 17 000.
const DS_WITH_WORKSHOP = {
  variant:        'with_workshop',
  lab:            process.env.LAB_DS_WITH_WORKSHOP_LAB  || '',
  recipient_name: process.env.LAB_DS_WITH_WORKSHOP_NAME || 'Айсулуу',
  email:          process.env.LAB_DS_WITH_WORKSHOP_EMAIL || 'servisstan@internet.ru',
};

// ДС, статус цех-документов ещё не уточнён → получателя нет (gated).
const DS_UNKNOWN = { variant: 'unknown', lab: '', recipient_name: '', email: '' };

// LAB_RECIPIENTS['ДС'] is the DEFAULT (unknown) entry; use routeLab(docType, opts) to
// resolve the ДС variant by цех-documents. СС has no variants.
const LAB_RECIPIENTS = { 'ДС': DS_UNKNOWN, 'СС': SS };

// routeLab(docType, { hasWorkshopDocs }) → recipient object (or null for unknown docType).
//   hasWorkshopDocs: true → with_workshop, false → no_workshop, undefined → unknown (gated).
function routeLab(docType, opts = {}) {
  if (docType === 'СС') return SS;
  if (docType === 'ДС') {
    if (opts.hasWorkshopDocs === true)  return DS_WITH_WORKSHOP;
    if (opts.hasWorkshopDocs === false) return DS_NO_WORKSHOP;
    return DS_UNKNOWN;
  }
  return null;
}

// "Имя <email>" — To: header, or null when no email is configured (broken "<>" never built).
function recipientHeader(docType, opts) {
  const r = routeLab(docType, opts);
  if (!r || !r.email || !String(r.email).trim()) return null;
  const name = r.recipient_name ? `${r.recipient_name} ` : '';
  return `${name}<${r.email}>`;
}

// isConfigured(docType, opts) — true when a sendable recipient email exists.
function isConfigured(docType, opts) {
  const r = routeLab(docType, opts);
  return !!(r && r.email && String(r.email).trim());
}

module.exports = { LAB_RECIPIENTS, SS, DS_NO_WORKSHOP, DS_WITH_WORKSHOP, DS_UNKNOWN, routeLab, recipientHeader, isConfigured };
