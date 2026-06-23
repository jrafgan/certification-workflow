'use strict';

// config/labRecipients.js — laboratory email recipients (single source of truth).
//
// The ONLY two lab recipients today:
//   • ДС (декларация)  → Дастан Акматов <standartpro98@gmail.com>
//   • СС (сертификат)  → Kyrgyz Test - Бермет <mng-1@kyrgyz-test.kg>
//
// Values are env-overridable so addresses can change without code edits.

const LAB_RECIPIENTS = {
  'ДС': {
    lab:            'Дастан',
    recipient_name: process.env.LAB_DASTAN_NAME  || 'Дастан Акматов',
    email:          process.env.LAB_DASTAN_EMAIL || 'standartpro98@gmail.com',
  },
  'СС': {
    lab:            'Бермет',
    recipient_name: process.env.LAB_BERMET_NAME  || 'Kyrgyz Test - Бермет',
    email:          process.env.LAB_BERMET_EMAIL || 'mng-1@kyrgyz-test.kg',
  },
};

// "Имя <email>" — ready-to-use To: header value.
function recipientHeader(docType) {
  const r = LAB_RECIPIENTS[docType];
  return r ? `${r.recipient_name} <${r.email}>` : null;
}

module.exports = { LAB_RECIPIENTS, recipientHeader };
