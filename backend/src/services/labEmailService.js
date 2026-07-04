'use strict';

// services/labEmailService.js — lab email PREPARATION (Функция №4). DRAFT ONLY.
//
// Builds the laboratory email for an order: recipient by document type — СС→Бермет, and ДС
// routed by швейный-цех documents (Дастану БОЛЬШЕ НЕ ПИШЕМ; see config/labRecipients.js).
// Subject = client ИП/ОсОО name with a sequential
// number when that name already appears in «Декларация», a duplicate flag, a KB-grounded
// body, and the attachment list. It NEVER sends — auto_send:false, operator approves and
// sends manually. Uses only operator-confirmed «Декларация» column D for the prior-name count.

const generation = require('./mockupGenerationService');
const workQueue  = require('./workQueueService');
const { LAB_RECIPIENTS, recipientHeader, isConfigured, routeLab } = require('../config/labRecipients');

const DECL_CLIENT_COL = 3;  // «Декларация» D — Клиент (operator-confirmed link / subject name)

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
// hasWorkshopDocs: true/false/undefined — for ДС it picks the issuing body (есть/нет
// документов на швейный цех). undefined → recipient unresolved until the agent asks the client.
function buildLabEmail({ clientName, docType, piCount = 1, additionalPi = 0, mockupFileName, attachmentFileName, priorCount = 0, hasWorkshopDocs } = {}) {
  const opts = { hasWorkshopDocs };
  const route = routeLab(docType, opts);
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

  // Recipient may be intentionally unresolved. Build the draft anyway for operator review,
  // but flag it as NOT sendable with a precise reason (ask цех-docs / fill the missing email).
  const recipient_configured = isConfigured(docType, opts);
  let recipient_warning = null;
  if (!recipient_configured) {
    if (docType === 'ДС' && hasWorkshopDocs === undefined) {
      recipient_warning = 'Сначала уточните у клиента: есть ли документы на швейный цех? От этого зависят орган выдачи, цена и срок декларации. Затем укажите вариант — отправлять пока нельзя.';
    } else if (docType === 'ДС' && hasWorkshopDocs === true) {
      recipient_warning = 'Почта органа для ДС «есть документы на цех» ещё не задана (LAB_DS_WITH_WORKSHOP_EMAIL). Отправлять пока нельзя.';
    } else {
      recipient_warning = `Почта получателя для ${docType} не задана. Впишите адрес перед отправкой — пока отправлять нельзя.`;
    }
  }

  return {
    ok: true,
    lab: route.lab || null,
    recipient_name: route.recipient_name || null,
    to_email: route.email || null,
    to: recipientHeader(docType, opts),                       // «Имя <email>» либо null
    declaration_variant: docType === 'ДС' ? route.variant : null,
    recipient_configured,
    recipient_warning,
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
