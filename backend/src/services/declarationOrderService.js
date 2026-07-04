'use strict';

// services/declarationOrderService.js — материализация ЗАКАЗОВ из листа «Декларация».
//
// Лист «Декларация» — источник истины (sheet wins). Здесь мы читаем его строки и приводим к
// нормализованному «кандидату заказа»: клиент, тип документа (ДС/СС), телефон, СТАТУС (к 7
// каноническим), сумма/долг, исполнитель. Идемпотентно по номеру строки листа.
//
// Данные грязные (опечатки в статусах, телефоны в разных форматах, «долг» в сумме, пустые
// строки) — всё нормализуется здесь. Персист/письма — отдельно и после проверки (dry-run).

// ── Определение колонок по НАЗВАНИЮ заголовка (устойчиво к сдвигам) ────────────
const COLS = {
  client:   ['клиент'],
  document: ['документ'],
  amount:   ['сумма'],
  item:     ['слой'],
  country:  ['страна'],
  phone:    ['номер тел', 'телефон', 'тел'],
  assignee: ['исполнитель'],
  created:  ['дата создания'],
  modified: ['дата последнего', 'изменения'],
  status:   ['статус'],
};
function norm(s) { return String(s || '').toLowerCase().trim(); }
function detectColumns(header = []) {
  const idx = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [key, syns] of Object.entries(COLS)) {
      if (idx[key] == null && syns.some(s => n.includes(s))) idx[key] = i;
    }
  });
  return idx;
}

// ── Нормализация статуса к 7 каноническим (config/constants ORDER_STATUSES) ────
// Порядок проверок важен: «оригинал получен» до «ждем оригинал».
function normStatus(raw) {
  const s = norm(raw);
  if (!s) return null;
  if (/получен/.test(s)) return 'Оригинал получен';
  if (/оригинал/.test(s)) return 'Ждем оригинал';
  if (/макет/.test(s)) return 'Ждем макет';
  if (/согласован/.test(s)) return 'На согласовании';
  if (/запуст/.test(s)) return 'Запустить';           // запустить, запуститть, «запустить без оплаты…»
  if (/заверш|вершен/.test(s)) return 'Завершен';     // завершен, зввершен, завершен, зввершен
  if (/отказ|отмен/.test(s)) return 'Отменен';
  return null;                                        // неизвестный/служебный («А», «ЕАЭС») → null
}

// ── Тип документа → ДС/СС ─────────────────────────────────────────────────────
function normDoc(raw) {
  const s = norm(raw);
  if (!s) return { doc_type: null, mixed: false };
  if (/отказн/.test(s)) return { doc_type: null, refusal: true };
  const hasDs = /деклар|(^|\W)дс(\W|$)/.test(s);
  const hasSs = /сертиф|(^|\W)сс(\W|$)/.test(s);
  if (hasDs && hasSs) return { doc_type: 'ДС', mixed: true };  // «дс+сс» — берём ДС, помечаем
  if (hasDs) return { doc_type: 'ДС', mixed: false };
  if (hasSs) return { doc_type: 'СС', mixed: false };
  return { doc_type: null, mixed: false };
}

// ── Телефон → ключ (последние 9 цифр) + валидность ────────────────────────────
function phoneInfo(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const key = digits ? digits.slice(-9) : '';
  return { phone_raw: String(raw || '').trim(), digits, phone_key: key, valid: digits.length >= 9 };
}

// ── Сумма + долг из свободного текста «22000(14000долг)» ───────────────────────
function amountInfo(raw) {
  const s = String(raw || '');
  const amtMatch = s.match(/\d[\d\s]*/);
  const amount = amtMatch ? parseInt(amtMatch[0].replace(/\s/g, ''), 10) : null;
  const debtMatch = s.match(/(\d[\d\s]*)\s*долг/i);
  const debt = debtMatch ? parseInt(debtMatch[1].replace(/\s/g, ''), 10) : null;
  return { amount: Number.isFinite(amount) ? amount : null, debt: Number.isFinite(debt) ? debt : null, raw: s.trim() };
}

// mapRow(cols, row, rowIndex0) → кандидат заказа | null (пустая/мусорная строка).
// sheet_row_id — фактический номер строки листа (заголовок = 1, данные с 2).
function mapRow(cols, row = [], rowIndex0 = 0) {
  const g = (k) => (cols[k] != null ? row[cols[k]] : undefined);
  const client = String(g('client') || '').trim();
  const ph = phoneInfo(g('phone'));
  if (!client && !ph.digits) return null;                 // ни клиента, ни телефона → мусор
  if (/^это кто|^\?+$/i.test(client)) return null;        // явный мусор

  const doc = normDoc(g('document'));
  const amt = amountInfo(g('amount'));
  const status = normStatus(g('status'));

  return {
    sheet_row_id: String(rowIndex0 + 2),
    client_name: client || null,
    doc_type: doc.doc_type,
    doc_mixed: !!doc.mixed,
    refusal_letter: !!doc.refusal,
    phone: ph.phone_raw || null,
    phone_key: ph.phone_key || null,
    phone_valid: ph.valid,
    amount: amt.amount,
    debt: amt.debt,
    item: String(g('item') || '').trim() || null,
    assignee: String(g('assignee') || '').trim() || null,
    status,
    status_raw: String(g('status') || '').trim() || null,
  };
}

// Статусы, по которым НУЖНА работа с лабораторией (для писем/задач).
const ACTIONABLE = new Set(['Запустить', 'Ждем макет', 'На согласовании', 'Ждем оригинал']);

// analyze({ dryRun=true }, deps) — прочитать лист, распарсить, вернуть сводку (без записи).
async function analyze(opts = {}, deps = {}) {
  const read = deps.readDeclarationRows || defaultReadDeclarationRows;
  const { header, rows } = await read();
  const cols = detectColumns(header);

  const summary = {
    columns_detected: cols,
    total_rows: rows.length,
    mapped: 0, skipped_empty: 0,
    by_status: {}, by_doc: { 'ДС': 0, 'СС': 0, null: 0 },
    actionable: 0, invalid_phone: 0, with_debt: 0,
    samples: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const c = mapRow(cols, rows[i], i);
    if (!c) { summary.skipped_empty++; continue; }
    summary.mapped++;
    const st = c.status || '—';
    summary.by_status[st] = (summary.by_status[st] || 0) + 1;
    summary.by_doc[c.doc_type || 'null'] = (summary.by_doc[c.doc_type || 'null'] || 0) + 1;
    if (c.status && ACTIONABLE.has(c.status)) summary.actionable++;
    if (c.phone && !c.phone_valid) summary.invalid_phone++;
    if (c.debt) summary.with_debt++;
    if (summary.samples.length < 8 && c.status && ACTIONABLE.has(c.status)) summary.samples.push(c);
  }
  return summary;
}

// sync({ limit, statuses }, deps) — материализовать ЗАКАЗЫ из «Декларации» в Mongo (replica).
//
// Лист — источник истины: СТАТУС берётся из листа ($set, чтобы заказ двигался по воронке
// Запустить→Ждем макет→…). Имя клиента, телефон и МАРШРУТ лаборатории пишутся только при
// первом создании ($setOnInsert), чтобы повторный синк не затирал уточнения оператора
// (например, выбранную ДС-лабораторию по документам на цех). Идемпотентно по sheet_row_id.
//
// ДС без данных о цехе → routeLab даёт получателя без email (gated) — заказ создаётся, но
// draftEmailService НЕ сгенерирует письмо (нет laboratoryEmail). Это by design: сначала надо
// уточнить у клиента документы на цех. СС всегда маршрутизируется (Бермет).
//
// НЕ пишет обратно в лист. НЕ трогает lab_interactions/events/payments. Ничего не отправляет.
async function sync(opts = {}, deps = {}) {
  const Order = deps.Order || require('../models/Order').Order;
  const { routeLab } = deps.labRecipients || require('../config/labRecipients');
  const read = deps.readDeclarationRows || defaultReadDeclarationRows;
  const statuses = opts.statuses ? new Set(opts.statuses) : ACTIONABLE;
  const limit = Number.isFinite(opts.limit) ? opts.limit : null;

  const { header, rows } = await read();
  const cols = detectColumns(header);
  const summary = { scanned: 0, upserted: 0, created: 0, skipped: 0, ds_no_route: 0 };

  for (let i = 0; i < rows.length; i++) {
    if (limit != null && summary.upserted >= limit) break;
    const c = mapRow(cols, rows[i], i);
    if (!c || !c.status || !statuses.has(c.status)) { summary.skipped++; continue; }
    summary.scanned++;

    const r = c.doc_type ? routeLab(c.doc_type, {}) : null;   // ДС без цех-данных → email пустой (gated)
    const labEmail = r && r.email ? String(r.email).trim() : null;
    const labName  = r ? (r.lab || r.recipient_name || null) : null;
    if (c.doc_type === 'ДС' && !labEmail) summary.ds_no_route++;

    const setOnInsert = {};
    const client = {};
    if (c.client_name) client.name = c.client_name;
    if (c.phone) client.phone = c.phone;
    if (Object.keys(client).length) setOnInsert.client = client;
    if (labEmail) setOnInsert.laboratory = { laboratoryEmail: labEmail, laboratoryName: labName || undefined };

    const update = { $set: { status: c.status, sheet_row_id: c.sheet_row_id } };
    if (Object.keys(setOnInsert).length) update.$setOnInsert = setOnInsert;

    try {
      const res = await Order.updateOne({ sheet_row_id: c.sheet_row_id }, update, { upsert: true });
      summary.upserted++;
      if (res.upsertedCount) summary.created++;
    } catch (e) {
      if (e && (e.code === 11000 || e.code === 'E11000')) summary.skipped++; else throw e;
    }
  }
  return summary;
}

// Дефолтный ридер: возвращает { header, rows } активного листа «Декларация» (read-only).
async function defaultReadDeclarationRows() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = process.env.DECLARATION_SHEET_NAME || 'Лист1';
  const a1 = /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.DECLARATION_SHEET_ID, range: `${a1}!A1:V3000` });
  const values = res.data.values || [];
  return { header: values[0] || [], rows: values.slice(1) };
}

module.exports = { detectColumns, normStatus, normDoc, phoneInfo, amountInfo, mapRow, analyze, sync, ACTIONABLE, defaultReadDeclarationRows };
