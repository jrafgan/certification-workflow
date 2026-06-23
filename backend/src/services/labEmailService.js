'use strict';

// services/labEmailService.js — lab email PREPARATION (Функция №4). DRAFT ONLY.
//
// Builds the laboratory email for an order: recipient by document type (ДС→Дастан,
// СС→Бермет — the only two recipients), subject = client ИП/ОсОО name with a sequential
// number when that name already appears in «Декларация», a duplicate flag, a KB-grounded
// body, and the attachment list. It NEVER sends — auto_send:false, operator approves and
// sends manually. Uses only operator-confirmed «Декларация» column D for the prior-name count.

const generation = require('./mockupGenerationService');
const workQueue  = require('./workQueueService');
const { LAB_RECIPIENTS, recipientHeader } = require('../config/labRecipients');

const DECL_CLIENT_COL = 3;  // «Декларация» D — Клиент (operator-confirmed link / subject name)

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function routeLab(docType) { return LAB_RECIPIENTS[docType] || null; }

// normalizeName — case/space-insensitive key for matching the same ИП/ОсОО name.
function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^0-9a-zа-яё]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// subjectFor — base name when first time; «<name> <N+1>» when N prior orders exist (KB §13).
function subjectFor(name, priorCount = 0) {
  const n = String(name || '').trim();
  return priorCount > 0 ? `${n} ${priorCount + 1}` : n;
}

// buildLabEmail — assemble the gated draft. priorCount = prior occurrences of the name.
function buildLabEmail({ clientName, docType, piCount = 1, additionalPi = 0, mockupFileName, attachmentFileName, priorCount = 0 } = {}) {
  const route = routeLab(docType);
  if (!route) return { ok: false, reason: 'unknown_doc_type', docType };
  if (!clientName || !String(clientName).trim()) return { ok: false, reason: 'no_client_name' };

  const subject = subjectFor(clientName, priorCount);
  const attachments = [];
  if (mockupFileName) attachments.push({ kind: 'mockup', name: mockupFileName });
  if (attachmentFileName) attachments.push({ kind: 'application', name: attachmentFileName });
  attachments.push({ kind: 'client_certificate', name: '<свидетельство ИП/ОсОО клиента — приложить>' });

  const body =
    `Здравствуйте!\n\n` +
    `Просим оформить ${docType === 'СС' ? 'сертификат соответствия (СС)' : 'декларацию соответствия (ДС)'} для «${String(clientName).trim()}».\n` +
    `Количество дополнительных ПИ: ${additionalPi} (всего составов/протоколов: ${piCount}).\n` +
    `Приложения: ${attachments.map(a => a.name).join(', ')}.\n\n` +
    `Просьба подтвердить получение и ориентировочные сроки.`;

  const duplicate_warning = priorCount > 0
    ? `Имя «${String(clientName).trim()}» уже встречается ${priorCount} раз(а) в «Декларации». Тема получила номер ${priorCount + 1}. Проверьте получателя/лабораторию — если получатель тот же, возможен дубль/ошибка (уточните у оператора).`
    : null;

  return {
    ok: true,
    lab: route.lab,
    recipient_name: route.recipient_name,
    to_email: route.email,
    to: recipientHeader(docType),                             // «Имя <email>»
    subject,
    body,
    attachments,
    prior_count: priorCount,
    duplicate_warning,
    auto_send: false,
    operator_approval_required: true,
  };
}

// ─── Sheet-backed: count prior orders for a name in «Декларация» (col D) ─────────
async function countPriorByName(clientName, deps = {}) {
  const read = deps.readDeclaration || workQueue.defaultReadDeclaration;
  const key = normalizeName(clientName);
  if (!key) return 0;
  try {
    let n = 0;
    for (const r of await read()) {
      if (normalizeName(r[DECL_CLIENT_COL]) === key) n++;
    }
    return n;
  } catch (_) { return 0; }
}

// ─── Orchestrator: «Новая форма» row → classify → mockup → prepared lab email ────
async function prepareFromForm(sheetRow, opts = {}, deps = {}) {
  const gen = await generation.generateFromForm(sheetRow, opts, deps);
  if (!gen.generated) return { prepared: false, blocked: gen.blocked, sheet_row: gen.sheet_row };

  const c = gen.classification || {};
  const clientName = gen.client_name || gen.mockup_file_name.replace(/^макет_/, '').replace(/\.docx$/, '');
  const additionalPi = Math.max(0, (c.protocol_groups || 1) - 1);
  const priorCount = await countPriorByName(clientName, deps);

  const email = buildLabEmail({
    clientName,
    docType: gen.doc_type,
    piCount: c.protocol_groups || 1,
    additionalPi,
    mockupFileName: gen.mockup_file_name,
    attachmentFileName: gen.attachment_file_name,
    priorCount,
  });

  return { prepared: email.ok, sheet_row: gen.sheet_row, generation: gen, lab_email: email };
}

module.exports = { LAB_RECIPIENTS, DECL_CLIENT_COL, routeLab, normalizeName, subjectFor, buildLabEmail, countPriorByName, prepareFromForm };
