'use strict';

// services/taskInboxService.js — the Operator Task Inbox (WhatsApp-style To-Do).
//
// The single "what do I do now, and with whom?" list. Fuses WhatsApp threads (grouped by
// client phone) with the non-chat work the operator owns (lab emails to answer, new
// applications without a price calc) into one prioritized list — see
// docs/modules/operator-task-inbox.md.
//
// buildTasks() is PURE (no I/O) and exported for tests. tasks()/thread()/markThread() do the
// defensive DB work. READ-ONLY toward the world: the only write is InboxThreadState (operator
// UI state — read/done/snooze). Nothing here sends, changes status, or writes the Declaration.

const { matchKey } = require('../utils/phoneUtils');

// A WhatsApp thread's canonical grouping key (one client = one row).
function threadKey(m = {}) {
  return m.phone_key || m.lid_key || matchKey(m.from_phone) || m.conversation_ref || m.from_phone || '';
}

// A friendly name for a thread from what the message already carries (no extra sheet read).
function waName(m = {}) {
  const cand = (m.candidates || [])[0];
  return (cand && cand.client_name) || m.from_phone || m.lid || 'неизвестный';
}

const REASON_RU = { direct: 'личка', mention: 'упомянули вас', reply: 'ответ вам', keyword: 'спросили про сертификацию' };

// «Клиент не отвечает» (правило №6): мы написали клиенту, и после НАШЕГО последнего сообщения
// прошло >N дней без ответа. Env: NEW_APP_NORESPONSE_DAYS (по умолч. 30).
const NEW_APP_NORESPONSE_DAYS = parseInt(process.env.NEW_APP_NORESPONSE_DAYS, 10) || 30;

// «Возраст заявки» (правило приоритета №6): если известна ДАТА СОЗДАНИЯ и с неё прошло >N
// календарных дней — заявка считается старой (backstop ПОСЛЕ поведенческих проверок; случай
// «мы ни разу не ответили» защищён отдельным правилом выше). Env: NEW_APP_STALE_DAYS (по умолч. 50).
const NEW_APP_STALE_DAYS = parseInt(process.env.NEW_APP_STALE_DAYS, 10) || 50;

// Защита живого лида: если клиент писал за последние N дней — возрастной backstop его НЕ прячет
// (ложное сокрытие активного клиента = потерянный лид). Env: NEW_APP_ACTIVE_DAYS (по умолч. 14).
const NEW_APP_ACTIVE_DAYS = parseInt(process.env.NEW_APP_ACTIVE_DAYS, 10) || 14;

// weSentCalc(text) — ИСХОДЯЩЕЕ сообщение = коммерческое предложение клиенту: явное КП/счёт
// (без числа) ИЛИ упоминание стоимости/протокола/итога + число (≥3 цифр). Так агент понимает,
// отправляли мы клиенту предложение по стоимости или нет.
const OFFER_TERM_RE = /коммерческ|выставил\w*\s+сч[её]т|сч[её]т\s+на\s+оплат|прайс/i;
const COST_TERM_RE  = /(протокол|прото\b|\bпи\b|итог|общая\s+сумма|к\s+оплате|стоимост|обойд[её]тся|выйдет|цена|сумма)/i;
function weSentCalc(text = '') { const t = String(text || ''); return OFFER_TERM_RE.test(t) || (COST_TERM_RE.test(t) && /\d[\d\s]{2,}/.test(t)); }

// isRefused(text) — клиент по переписке ЯВНО отказался делать документ у нас. Консервативно:
// прячем заявку только на однозначных формулировках отказа (ложное сокрытие = потерянный
// лид, поэтому без догадок). RU/KY. PURE.
const REFUSED_RE = /переду?мал|отказ(ыва|ыва[ю]сь|ался|аться|ное(?!\s*письмо))|не\s+буд[уе]м?\b|не\s+актуальн|в\s+другом\s+месте|(нашл[иа]|сделал[иа]?|оформил[иа]?|заказал[иа]?)\s+(в\s+)?друг|уже\s+(сделал|оформил|получил|заказал)|(спасибо|благодар)\w*[,\s].{0,15}не\s+(над|нуж)|не\s+интересует|не\s+нужн\w*\s+(больше|уже)|башка\s+жерден|кереги\s+жок/i;
function isRefused(text = '') { return REFUSED_RE.test(String(text || '')); }

// clientSaidPaid(text) — клиент по переписке сообщил, что оплатил (мягкий сигнал в дополнение
// к Декларации кол. G). Совпадает с leadIntent.payment_made. PURE.
const CLIENT_PAID_RE = /оплатил|оплачен|перев[её]л|перечислил|чек(?![а-яё])|квитанц|оплату\s+(отправил|скинул|кинул)|тол[её]д[уи]м/i;
function clientSaidPaid(text = '') { return CLIENT_PAID_RE.test(String(text || '')); }

// classifyApplication(sig, decl, opts) → { isNew, reason, recommended_action?, needs_calc_reply? }.
// PURE. Приоритетный порядок: 1) в Декларации 2) оплатил 3) отказ 4) не отвечает >30д
// 6) возраст >50д (СКРЫТЬ даже при «ни разу не ответили» — решение оператора 2026-07-05; гард
// живого лида) 7) ни разу не ответили → показать+КП 5) КП отправлено → показать. Возраст
// применяется ТОЛЬКО когда известна дата создания (opts.ageDays). sig = { lastInboundAt,
// lastOutboundAt, hasOutbound, offerSent, semanticRefused, inboundTexts[] }. decl = запись
// «Декларации» или null. opts.ageDays = возраст заявки в днях от даты создания (null если неизвестна).
function classifyApplication(sig = {}, decl = null, opts = {}) {
  const now = opts.now || Date.now();
  const noResponseDays = opts.noResponseDays || NEW_APP_NORESPONSE_DAYS;
  const staleDays = opts.staleDays || NEW_APP_STALE_DAYS;
  const ageDays = Number.isFinite(opts.ageDays) ? opts.ageDays : null;   // только от даты создания
  const inboundTexts = sig.inboundTexts || [];
  const lastInboundAt = sig.lastInboundAt || null;
  const lastOutboundAt = sig.lastOutboundAt || null;
  const hasOutbound = !!sig.hasOutbound;
  const offerSent = !!sig.offerSent;
  const refused = inboundTexts.some(isRefused) || !!sig.semanticRefused;
  const saidPaid = inboundTexts.some(clientSaidPaid);

  // 1) Клиент уже оформляется (Декларация / сертификаты / заказы)
  if (decl) return { isNew: false, reason: 'Клиент уже оформляется (есть в Декларации)' };
  // 2) Клиент оплатил (по переписке; оплата в Декларации поймана правилом 1)
  if (saidPaid) return { isNew: false, reason: 'Клиент оплатил заказ' };
  // 3) Клиент отказался
  if (refused) return { isNew: false, reason: 'Клиент отказался' };
  // 4) Клиент не отвечает: мы писали, прошло > N дней после НАШЕГО последнего, ответа не было
  if (hasOutbound && lastOutboundAt && (now - lastOutboundAt) / 86400000 > noResponseDays
      && (!lastInboundAt || lastInboundAt <= lastOutboundAt))
    return { isNew: false, reason: `Клиент не отвечает более ${noResponseDays} дней` };
  // 6) ЖЁСТКИЙ отсеч по возрасту (решение оператора 2026-07-05, уточнено вечером): дата создания
  //    старше порога → заявка СТАРАЯ и НЕ показывается как новая, ДАЖЕ если клиент писал недавно.
  //    Прежний «гард живого лида» УБРАН по требованию оператора: активный клиент не теряется —
  //    он всё равно виден как WhatsApp-тред (задача «клиент»), просто без дубля-карточки заявки.
  if (ageDays != null && ageDays > staleDays)
    return { isNew: false, reason: `Заявка старше ${staleDays} дней` };
  // 7) Мы НИ РАЗУ не ответили (и заявка не старше порога) → НЕ скрывать, предложить отправить КП
  if (!hasOutbound)
    return { isNew: true, needs_calc_reply: true, reason: 'Клиенту ни разу не ответили',
             recommended_action: 'Отправить клиенту коммерческое предложение (стоимость услуг)' };
  // 5) КП уже отправлено, клиент ещё в диалоге → остаётся новой, ждём решения
  if (offerSent)
    return { isNew: true, needs_calc_reply: false, reason: 'КП отправлено — ждём решения клиента', recommended_action: null };
  // Иначе: мы писали, но стоимость ещё не отправляли → предложить отправить
  return { isNew: true, needs_calc_reply: true, reason: 'Клиенту ещё не отправляли стоимость услуг',
           recommended_action: 'Предложить оператору отправить клиенту коммерческое предложение' };
}

// «Декларация» columns (0-based) — the LIVE sheet is the source of truth (the Mongo
// Declaration replica is intentionally empty, which is why matching against it always said
// "без заказа"). See memory whatsapp-match-empty-replica-bug + [[declaration-source-of-truth]].
const DECL_CLIENT_COL  = 3;   // D — Клиент
const DECL_PAYMENT_COL = 6;   // G — Сумма (paid; parentheses = remaining debt)
const DECL_PHONE_COL   = 9;   // J — Номер тел
const DECL_STATUS_COL  = 13;  // N — Статус
const { parsePayment } = require('./clientEntityService');

// declIndexFromRows — build phone_key → { client, status, count, paid, debt } from raw
// «Декларация» rows. Payment (col G) is summed across a phone's rows.
function declIndexFromRows(rows = []) {
  const idx = {};
  for (const r of rows) {
    const key = matchKey(r[DECL_PHONE_COL]);
    if (!key) continue;
    const client = String(r[DECL_CLIENT_COL] || '').trim() || null;
    const status = String(r[DECL_STATUS_COL] || '').trim() || null;
    const pay = parsePayment(r[DECL_PAYMENT_COL]);
    const e = idx[key] || (idx[key] = { client: null, status: null, count: 0, paid: 0, debt: 0 });
    e.count += 1;
    e.paid += pay.paid; e.debt += pay.debt;
    if (client && !e.client) e.client = client;
    if (status) e.status = status;               // last non-empty status for this phone
  }
  return idx;
}

// normClientName — нормализованный ключ имени клиента для матча заявки с Декларацией по ИМЕНИ
// (телефон в Декларации ненадёжен — order-identity-model). Возвращает null для слишком общих
// имён (голый орг-префикс «ИП»/«ОсОО» / пусто), чтобы не хватать ложные совпадения.
const ORG_PREFIX_RE = /^(ип|осоо|оосо|ооо|чп|оао|зао|тоо)[\s.]*/i;
function normClientName(s = '') {
  const t = String(s || '').toLowerCase().replace(/[^0-9a-zа-яё\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const core = t.replace(ORG_PREFIX_RE, '').trim();
  if (core.length < 3) return null;               // «ип» / слишком общее → не матчим
  return t;
}

// declNameIndexFromRows — normClientName(col D) → { client, status, count, paid, debt }.
// Параллельно declIndexFromRows (по телефону), но по ИМЕНИ — ловит клиента в Декларации, когда
// его телефон не совпал с заявкой.
function declNameIndexFromRows(rows = []) {
  const idx = {};
  for (const r of rows) {
    const nk = normClientName(r[DECL_CLIENT_COL]);
    if (!nk) continue;
    const status = String(r[DECL_STATUS_COL] || '').trim() || null;
    const pay = parsePayment(r[DECL_PAYMENT_COL]);
    const e = idx[nk] || (idx[nk] = { client: String(r[DECL_CLIENT_COL] || '').trim() || null, status: null, count: 0, paid: 0, debt: 0 });
    e.count += 1; e.paid += pay.paid; e.debt += pay.debt;
    if (status) e.status = status;
  }
  return idx;
}

// fmtSom — thousands separator for money shown to the operator (15000 → "15 000").
function fmtSom(n) { return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

// Short client-facing status updates by advisory stage (for a client with an active order).
const STAGE_REPLY = {
  intake:            'Спасибо за оплату! Запускаем оформление вашего документа — сообщим по мере готовности.',
  awaiting_layout:   'Ваш документ в работе — лаборатория готовит макет. Как будет готов, пришлём вам на согласование.',
  on_approval:       'Мы направили макет на согласование. Подскажите, всё ли верно, чтобы двигаться дальше к оригиналу.',
  approved:          'Макет согласован — лаборатория приступила к изготовлению оригинала. Сообщим, когда будет готов.',
  awaiting_original: 'Оригинал документа изготавливается. Сообщим, как только он будет готов к выдаче.',
  done:              'Ваш документ готов. Спасибо, что выбрали нас!',
};

// proposeReply(entity) → { text, kind, reason } — PURE. The agent's SUGGESTED reply to the
// client, grounded in payment + order status. Recommend-only: the operator edits/sends it.
// Priority: outstanding debt → remind; active order → stage update; else greeting.
function proposeReply(entity) {
  const templates = require('./leadReplyTemplates');
  if (entity && entity.debt_total > 0)
    return { kind: 'payment_debt', reason: `частичная оплата — долг ${entity.debt_total} сом (кол. G)`,
      text: `Спасибо за оплату! По вашему заказу остаётся доплатить ${fmtSom(entity.debt_total)} сом. Подскажите, когда сможете внести остаток — и мы продолжим оформление.` };
  const active = entity && (entity.orders || []).find(o => o.stage !== 'done');
  if (active && STAGE_REPLY[active.stage])
    return { kind: 'status_update', reason: `статус заказа: «${active.status}»`, text: STAGE_REPLY[active.stage] };
  if (entity && entity.is_new_application)
    return { kind: 'application_link', reason: 'новая заявка — нужно начать оформление',
      text: templates.render('application_link') };
  return { kind: 'greeting', reason: 'нет заказа/контекста — приветствие', text: templates.render('greeting') };
}

// ─── PURE: compose the unified task list ────────────────────────────────────────
// input = {
//   waMessages:      [inbound WhatsAppMessage, newest first],
//   threadStates:    { [phone_key]: { last_seen_at, snoozed_until, done } },
//   labEmails:       [{ id, subject, to, client_name, order_id, created_at }],
//   newApplications: [{ sheet_row, applicant, legal_entity }],
//   now:             ms,
// }
function buildTasks(input = {}) {
  const waMessages = Array.isArray(input.waMessages) ? input.waMessages : [];
  const states = input.threadStates || {};
  const labEmails = Array.isArray(input.labEmails) ? input.labEmails : [];
  const newApplications = Array.isArray(input.newApplications) ? input.newApplications : [];
  const declByPhone = input.declByPhone || {};   // phone_key → { client, status, count } (live sheet)
  const declByName = input.declByName || {};     // normClientName → { client, status, count } (name fallback)
  // phone_key'и, которые смысловой классификатор (LLM точечно) распознал как отказ — считаются
  // отдельно и передаются готовыми, чтобы buildTasks оставалась ЧИСТОЙ (без LLM/I-O).
  const semanticRefused = input.semanticRefusedKeys instanceof Set
    ? input.semanticRefusedKeys : new Set(input.semanticRefusedKeys || []);
  const now = input.now || Date.now();
  // Operator overrides for new applications (phone_key or `row:<n>` → { status, reason, ... }).
  const applicationOverrides = input.applicationOverrides instanceof Map
    ? input.applicationOverrides : new Map(Object.entries(input.applicationOverrides || {}));

  const tasks = [];

  // 1) WhatsApp threads — group inbound messages by client, newest per group.
  const groups = new Map();
  for (const m of waMessages) {
    const key = threadKey(m);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = { key, latest: m, count: 0, messages: [] }; groups.set(key, g); }
    g.count += 1;
    g.messages.push(m);
    // waMessages are newest-first, so the first seen is the latest.
  }
  for (const g of groups.values()) {
    const st = states[g.key] || {};
    if (st.done) continue;                                        // cleared by operator
    if (st.snoozed_until && new Date(st.snoozed_until).getTime() > now) continue; // snoozed
    const seen = st.last_seen_at ? new Date(st.last_seen_at).getTime() : 0;
    const unread = g.messages.filter(m => new Date(m.received_at || m.sent_at || 0).getTime() > seen).length;
    const latest = g.latest;
    const at = new Date(latest.received_at || latest.sent_at || latest.created_at || now).getTime();
    const hasMedia = (latest.attachments || []).length > 0;
    // Resolve the order from the LIVE «Декларация» (not the empty Mongo replica).
    const decl = declByPhone[g.key] || null;
    const inDecl = !!decl;
    const status = decl && decl.status ? decl.status : null;
    const paid = decl ? decl.paid : 0;
    const debt = decl ? decl.debt : 0;
    // Payment marker (col G): "оплачено 15 000" (+ "долг 5 000" when partially paid).
    const payLabel = paid > 0 ? `оплачено ${fmtSom(paid)}${debt > 0 ? ` · долг ${fmtSom(debt)}` : ''}` : null;
    // Order label: real status if present; "новый заказ" for a launched-but-blank status;
    // "без заказа" ONLY when the phone is genuinely absent from the sheet.
    const baseLabel = inDecl ? (status ? `в работе: «${status}»${decl.count > 1 ? ` (+${decl.count - 1})` : ''}` : 'заказ без статуса') : 'без заказа';
    const orderLabel = payLabel ? `${baseLabel} · 💰 ${payLabel}` : baseLabel;
    const groupSub = `группа${latest.group_subject ? ' «' + latest.group_subject + '»' : ''} · ${REASON_RU[latest.addressed_reason] || ''}`;
    tasks.push({
      kind: 'whatsapp_reply',
      phone: latest.from_phone || null,
      phone_key: g.key,
      title: (decl && decl.client) || waName(latest),
      subtitle: latest.is_group ? groupSub : orderLabel,
      order_label: orderLabel,
      order_status: status,
      has_order: inDecl,
      paid, debt, is_paid: paid > 0,
      legal_entity: (decl && decl.client) || null,
      last_message: latest.body || (hasMedia ? '[вложение]' : ''),
      channel: 'whatsapp',
      is_group: !!latest.is_group,
      addressed_reason: latest.addressed_reason || null,
      age_ms: Math.max(0, now - at),
      last_at: latest.received_at || latest.sent_at || null,
      unread,
      order_id: latest.matched_order_id ? String(latest.matched_order_id) : null,
      priority: unread > 0 ? 3 : 2,
    });
  }

  // 2) Lab emails awaiting an answer.
  for (const e of labEmails) {
    const at = new Date(e.created_at || now).getTime();
    tasks.push({
      kind: 'lab_email',
      phone: null, phone_key: null,
      title: e.client_name ? `Письмо · ${e.client_name}` : 'Письмо лаборатории',
      subtitle: e.to || 'получатель не задан',
      last_message: e.subject || '',
      channel: 'email',
      age_ms: Math.max(0, now - at),
      last_at: e.created_at || null,
      unread: 0,               // a lab email is not an "unread message" — no false dot
      order_id: e.order_id ? String(e.order_id) : null,
      draft_id: e.id ? String(e.id) : null,
      priority: 2,
    });
  }

  // WhatsApp-сигналы по клиенту (ОБЕ стороны). waSignalsByKey (из tasks()): pk → { lastInboundAt,
  // lastOutboundAt, hasOutbound, offerSent, inboundTexts[] }. Если не передано — fallback по inbound.
  const signalsByKey = input.waSignalsByKey instanceof Map ? input.waSignalsByKey : null;
  const inboundTextByKey = new Map();
  if (!signalsByKey) {
    for (const m of waMessages) {
      if (m.direction && m.direction !== 'inbound') continue;
      const k = threadKey(m); if (!k || !m.body) continue;
      const arr = inboundTextByKey.get(k) || []; arr.push(String(m.body)); inboundTextByKey.set(k, arr);
    }
  }
  const sigFor = (pk) => (signalsByKey && signalsByKey.get(pk)) ||
    { lastInboundAt: null, lastOutboundAt: null, hasOutbound: false, offerSent: false, inboundTexts: inboundTextByKey.get(pk) || [] };

  // 3) NEW applications — решение по приоритетным правилам (classifyApplication, ТЗ 2026-07-04).
  //    isNew:false → скрыть; isNew:true → показать (needs_calc_reply = стоимость ещё не отправляли).
  let hiddenNewApps = 0;
  for (const a of newApplications) {
    const pk = a.phone ? matchKey(a.phone) : '';
    let decl = pk ? (declByPhone[pk] || null) : null;
    if (!decl) {
      // Fallback: match by CLIENT NAME (Declaration phone unreliable — order-identity-model).
      // Ловит клиента, который уже в Декларации, но его телефон не совпал с заявкой → не показываем
      // его ложно как «новую заявку».
      const nk = normClientName(a.legal_entity) || normClientName(a.applicant);
      if (nk) decl = declByName[nk] || null;
    }
    const s = sigFor(pk);
    // Operator override wins over the agent's guess: if a person marked this application
    // «не новая» (already replied / not relevant / …), never show it as new. Highest priority.
    // Keyed by phone (canonical) OR the form row when the phone is missing/unmatchable.
    const rowKey = (a.sheet_row ?? a.row) != null ? `row:${a.sheet_row ?? a.row}` : null;
    const override = (pk && applicationOverrides.get(pk)) || (rowKey && applicationOverrides.get(rowKey)) || null;
    if (override && override.status === 'not_new') { hiddenNewApps++; continue; }

    // Возраст от реальной даты создания заявки (колонка 0 формы) — для backstop-правила №6.
    const subMs = a.submitted_at ? new Date(a.submitted_at).getTime() : null;
    const ageDays = Number.isFinite(subMs) ? Math.floor((now - subMs) / 86400000) : null;
    const verdict = classifyApplication({ ...s, semanticRefused: pk && semanticRefused.has(pk) }, decl, { now, ageDays });
    if (!verdict.isNew) { hiddenNewApps++; continue; }
    const staleDays = parseInt(process.env.NEW_APP_STALE_DAYS, 10) || 50;
    const isStale = ageDays != null && ageDays > staleDays;   // shown only when a live-lead guard kept it

    const idleDays = s.lastInboundAt ? Math.floor((now - s.lastInboundAt) / 86400000) : null;
    const ageMs = subMs ? Math.max(0, now - subMs) : (s.lastInboundAt ? Math.max(0, now - s.lastInboundAt) : 0);
    const dateRu = subMs ? new Date(subMs).toLocaleDateString('ru-RU') : (idleDays != null ? `последнее сообщение ${idleDays} дн. назад` : 'дата неизвестна');
    tasks.push({
      kind: 'new_application',
      phone: a.phone || null, phone_key: pk || null,
      client_name: a.applicant || a.legal_entity || null,
      title: `Новая заявка · ${a.applicant || a.legal_entity || '—'}`,
      subtitle: `${dateRu} · ${verdict.reason}`,
      last_message: verdict.recommended_action || verdict.reason,
      channel: 'application',
      is_new: true,
      new_reason: verdict.reason,
      recommended_action: verdict.recommended_action || null,
      needs_calc_reply: !!verdict.needs_calc_reply,
      stale: isStale,          // >stale-days but a live-lead guard kept it visible → warn operator
      idle_days: idleDays,
      age_ms: ageMs,
      last_at: a.submitted_at || (s.lastInboundAt ? new Date(s.lastInboundAt).toISOString() : null),
      submitted_at: a.submitted_at || null,
      age_days: subMs ? Math.floor((now - subMs) / 86400000) : idleDays,
      unread: 0,               // a new application is not an "unread message"
      sheet_row: a.sheet_row ?? null,
      priority: 1,
    });
  }

  // Priority first (unread WhatsApp on top), then most recent activity within a priority
  // (WhatsApp-style: smaller age_ms = more recent → ascending age).
  tasks.sort((x, y) => (y.priority - x.priority) || (x.age_ms - y.age_ms));

  return { tasks, total: tasks.length, hidden_new_applications: hiddenNewApps, recommend_only: true };
}

// ─── DB: assemble the task list ─────────────────────────────────────────────────
async function tasks(deps = {}) {
  const models = deps.models || require('../models');
  const { WhatsAppMessage, EmailDraft, InboxThreadState, ApplicationOverride } = models;
  const safe = async (p, d) => { try { return await p; } catch (_) { return d; } };

  // Self-heal LID→phone BEFORE reading: rewrite any lid-only inbound whose mapping now exists,
  // so the panel never shows a raw LID once web.js has resolved it (whatsapp-full-archive).
  await safe((deps.lidService || require('./whatsappLidService')).applyStoredMappings(deps), null);

  const wq = require('./workQueueService');
  const [waMessages, labDrafts, stateDocs, newApps, declRows, overrideDocs] = await Promise.all([
    // Inbox = direct chats + group messages addressed to the operator (archived group chatter
    // is excluded here, but still stored for search — see archiveOutbound / wa-search).
    safe(WhatsAppMessage.find({ direction: 'inbound', $or: [{ is_group: { $ne: true } }, { addressed_me: true }] }).sort({ received_at: -1 }).limit(500).lean(), []),
    safe(EmailDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(100).lean(), []),
    safe(InboxThreadState.find().lean(), []),
    safe(wq.newApplications(), []),
    // LIVE «Декларация» read (source of truth) — used to resolve orders, since the Mongo
    // Declaration replica is empty (whatsapp-match-empty-replica-bug).
    safe((deps.readDeclaration || wq.defaultReadDeclaration)(), []),
    safe(ApplicationOverride.find({ status: 'not_new' }).lean(), []),
  ]);

  const threadStates = {};
  for (const s of stateDocs) threadStates[s.phone_key] = s;
  const applicationOverrides = new Map();
  for (const o of (overrideDocs || [])) if (o.app_key) applicationOverrides.set(o.app_key, o);

  const labEmails = labDrafts.map(d => ({
    id: d._id, subject: d.subject, to: d.to_email, client_name: d.client_name,
    order_id: d.order_id, created_at: d.created_at,
  }));

  const declByPhone = declIndexFromRows(declRows || []);
  const declByName = declNameIndexFromRows(declRows || []);   // name fallback when phone doesn't match

  // WhatsApp-сигналы по номерам новых заявок (ОБЕ стороны) — чтобы решить «новая/старая»:
  // отвечали ли мы клиенту, отправляли ли просчёт (сумму/протоколы), когда он писал последний раз.
  const newAppKeys = [...new Set((newApps || []).map(a => (a.phone ? matchKey(a.phone) : '')).filter(Boolean))];
  const waSignalsByKey = new Map();
  if (newAppKeys.length) {
    const msgs = await safe(WhatsAppMessage.find({ phone_key: { $in: newAppKeys } }).sort({ received_at: -1 }).limit(3000).lean(), []);
    for (const m of msgs) {
      const k = m.phone_key || matchKey(m.from_phone) || matchKey(m.to_phone); if (!k) continue;
      let s = waSignalsByKey.get(k);
      if (!s) { s = { lastInboundAt: null, lastOutboundAt: null, hasOutbound: false, offerSent: false, inboundTexts: [] }; waSignalsByKey.set(k, s); }
      const at = new Date(m.received_at || m.sent_at || m.created_at || 0).getTime();
      if (m.direction === 'outbound') {
        s.hasOutbound = true;
        if (at && (!s.lastOutboundAt || at > s.lastOutboundAt)) s.lastOutboundAt = at;
        if (!s.offerSent && m.body && weSentCalc(m.body)) s.offerSent = true;   // мы отправили клиенту КП/стоимость
      } else {
        if (at && (!s.lastInboundAt || at > s.lastInboundAt)) s.lastInboundAt = at;
        if (m.body) s.inboundTexts.push(String(m.body));                        // desc → [0] самое свежее
      }
    }
  }

  // Смысловой разбор отказа (§4): по последнему входящему неоднозначных заявок — LLM ТОЧЕЧНО
  // (regex-фолбэк внутри), с бюджетом и кэшем, вне пути рендера. Нет ключа/ошибка → без сигнала.
  const semanticRefusedKeys = new Set();
  try {
    const messageIntent = deps.messageIntent || require('./messageIntentService');
    let budget = Number.isFinite(deps.llmBudget) ? deps.llmBudget : 4;
    for (const pk of newAppKeys) {
      if (budget <= 0) break;
      const decl = declByPhone[pk];
      if (decl) continue;                                  // в Декларации — и так скрыт, LLM не тратим
      const s = waSignalsByKey.get(pk);
      const last = s && s.inboundTexts[0]; if (!last) continue;
      if (isRefused(last)) continue;                       // regex уже поймает — LLM не нужен
      const r = await messageIntent.classifyDecision(last, deps);
      if (r && r.decision === 'refuse' && (r.confidence || 0) >= 0.7) semanticRefusedKeys.add(pk);
      if (r && r.method === 'llm') budget--;
    }
  } catch (_) { /* классификатор недоступен → без смыслового сигнала */ }

  return buildTasks({
    waMessages, threadStates, labEmails, newApplications: newApps || [],
    declByPhone, declByName, semanticRefusedKeys, waSignalsByKey, applicationOverrides, now: Date.now(),
  });
}

// ─── DB: one thread's DOSSIER — so the operator instantly sees: who the client is (ИП/ОсОО),
// payment, where they came from, their history (WhatsApp + lab email), where we're heading
// (status + next step), and the agent's SUGGESTED reply. Read-only. ────────────────────────
async function thread(phone, deps = {}) {
  const models = deps.models || require('../models');
  const { WhatsAppMessage, LeadMessageDraft, LabCommThread, EmailDraft, Order } = models;
  const key = matchKey(phone);
  if (!key) return { found: false, reason: 'bad_phone' };
  const safe = async (p, d) => { try { return await p; } catch (_) { return d; } };

  // Last 10 messages with this client, chronological.
  const recent = await safe(WhatsAppMessage.find({ $or: [{ phone_key: key }, { from_phone: phone }, { to_phone: phone }] })
    .sort({ received_at: -1 }).limit(10).lean(), []);
  const messages = recent.slice().reverse().map(m => ({
    direction: m.direction || 'inbound',
    body: m.body || ((m.attachments || []).length ? '[вложение]' : ''),
    at: m.received_at || m.sent_at || m.created_at || null,
    is_group: !!m.is_group, addressed_reason: m.addressed_reason || null,
    has_media: (m.attachments || []).length > 0,
  }));

  // Entity + Declaration (client name, payment col G, orders w/ stage + next actor) — read sheet.
  const entity = await safe(require('./clientEntityService').buildByPhone(phone), null);
  const ent = entity && entity.found ? entity : null;

  // ОТКУДА клиент + КУДА идём (next step): from the entity's origin + active order stage.
  const origin = ent
    ? (ent.in_declaration ? 'Заказ в «Декларации»' : (ent.is_new_application ? 'Новая форма (заявка)' : 'Контакт из WhatsApp'))
    : 'Неизвестный контакт (нет в таблице)';
  const active = ent && (ent.orders || []).find(o => o.stage !== 'done');
  const next_step = active
    ? { status: active.status, actor_ru: active.next_actor_ru || null }
    : (ent && ent.is_new_application ? { status: 'новая заявка', actor_ru: 'оператор' } : null);

  // Lab / email HISTORY by client NAME (matched_order_id is unreliable — the matcher points at
  // the empty Mongo replica; whatsapp-match-empty-replica-bug). Best-effort.
  //
  // ПРАВИЛО ОПЕРАТОРА (2026-07-05): искать письмо на почте ТОЛЬКО если клиент УЖЕ в «Декларации»
  // И статус НЕ «Запустить» — иначе заказ в лабораторию не отправлен и переписки нет. Экономит
  // поиск и не путает оператора пустотой.
  const names = [...new Set([ent && ent.legal_entity, ...((ent && ent.orders) || []).map(o => o.client)].filter(Boolean))];
  const launchedOrders = (ent && ent.in_declaration)
    ? (ent.orders || []).filter(o => o.status && String(o.status).trim() && String(o.status).trim() !== 'Запустить')
    : [];
  const shouldFindEmails = launchedOrders.length > 0;
  let email_history = [];
  let email_search_reason = null;
  if (!ent || !ent.in_declaration) email_search_reason = 'Клиента нет в «Декларации» — писем по заказу пока не ищем.';
  else if (!shouldFindEmails) email_search_reason = 'Заказ на статусе «Запустить» — в лабораторию ещё не отправлен, писем нет.';

  if (shouldFindEmails && names.length) {
    const [emailDrafts, orders] = await Promise.all([
      safe(EmailDraft.find({ client_name: { $in: names } }).sort({ created_at: -1 }).limit(20).lean(), []),
      safe(Order.find({ $or: [{ 'client.name': { $in: names } }, { 'client.companyName': { $in: names } }] }).select('_id').limit(50).lean(), []),
    ]);
    const orderIds = orders.map(o => o._id);
    const threads = orderIds.length ? await safe(LabCommThread.find({ order_id: { $in: orderIds } }).sort({ created_at: -1 }).limit(20).lean(), []) : [];
    email_history = [
      ...threads.map(t => ({ kind: 'lab', recipient: t.recipient_email || null, status: t.status || null, at: t.reply_detected_at || t.sent_at || t.created_at || null, has_attachment: !!t.reply_has_attachment, needs_reply: t.status === 'reply_received' || t.status === 'awaiting_our_reply' })),
      ...emailDrafts.map(d => ({ kind: 'draft', recipient: d.to_email || null, status: `черновик · ${d.state || ''}`, at: d.created_at || null, subject: d.subject || null, needs_reply: d.state === 'pending_approval' })),
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 10);
    if (!email_history.length) email_search_reason = 'Заказ запущен, но письма по нему пока не найдены (проверьте почту лаборатории).';
  }

  // AGENT SUGGESTED REPLY (always present): a stored agent draft if one exists, else generated.
  const drafts = await safe(LeadMessageDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(50).lean(), []);
  const draftDoc = drafts.find(d => matchKey(d.to_handle) === key) || null;
  const proposed_reply = draftDoc
    ? { text: draftDoc.proposed_text, kind: draftDoc.kind, reason: 'готовый черновик агента', draft_id: String(draftDoc._id), state: draftDoc.state }
    : proposeReply(ent);

  // Client-card additions: New-Form application fields (multi-match aware), days since the last
  // WhatsApp message, and a short agent summary of the conversation.
  const application = await safe(applicationCardByPhone(phone, deps), { found: false });
  const now = deps.now || Date.now();
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const lastAt = lastMsg && lastMsg.at ? new Date(lastMsg.at).getTime() : null;
  const days_since_last = lastAt != null ? Math.floor((now - lastAt) / 86400000) : null;
  const conversation_summary = conversationSummary(messages, { now });

  return {
    found: true,
    phone, phone_key: key,
    entity: ent,
    application,                                  // ← «Новая форма»: компания/ИП/ФИО/ТНВЭД/производитель/страна
    payment: ent ? { paid: ent.paid_total, debt: ent.debt_total, is_paid: ent.is_paid } : { paid: 0, debt: 0, is_paid: false },
    origin, next_step,
    messages,
    days_since_last,                              // ← сколько дней после последнего сообщения
    conversation_summary,                         // ← краткое резюме переписки (агент)
    email_history,
    email_search_reason,                          // почему писем нет (не в Декларации / статус «Запустить»)
    email_status: email_history[0] || null,     // back-compat: latest item
    proposed_reply,
    recommend_only: true,
  };
}

// ─── DB: operator UI-state mutation (read / done / snooze) — the ONLY write ──────
async function markThread(phone, action, opts = {}, deps = {}) {
  const models = deps.models || require('../models');
  const { InboxThreadState } = models;
  const key = matchKey(phone);
  if (!key) return { ok: false, reason: 'bad_phone' };

  const set = { updated_by: opts.updated_by || 'operator' };
  if (action === 'seen')  set.last_seen_at = new Date();
  else if (action === 'done')  { set.done = true; set.last_seen_at = new Date(); }
  else if (action === 'snooze') set.snoozed_until = opts.until ? new Date(opts.until) : new Date(Date.now() + 24 * 3600 * 1000);
  else return { ok: false, reason: 'bad_action' };

  await InboxThreadState.updateOne({ phone_key: key }, { $set: set }, { upsert: true });
  return { ok: true, phone_key: key, action };
}

// ─── PURE: the override key for an application (phone match key, else the form row) ──────
function appKeyFor({ phone, phone_key, sheet_row } = {}) {
  const pk = phone_key || (phone ? matchKey(phone) : null);
  if (pk) return pk;
  if (sheet_row != null && String(sheet_row).trim() !== '') return `row:${sheet_row}`;
  return null;
}

// ─── DB: operator marks an application «не новая» (already replied / not relevant / …) ──────
// The inbox then trusts this over the agent's guess (highest priority). Idempotent per app_key.
async function markApplication({ phone, sheet_row, client_name, reason, note, operator } = {}, deps = {}) {
  const models = deps.models || require('../models');
  const { ApplicationOverride, APPLICATION_OVERRIDE_REASONS } = models;
  const app_key = appKeyFor({ phone, sheet_row });
  if (!app_key) return { ok: false, reason: 'no_key' };            // need a phone or a row to key on
  const r = APPLICATION_OVERRIDE_REASONS.includes(reason) ? reason : 'other';
  const phone_key = phone ? matchKey(phone) : null;
  await ApplicationOverride.updateOne(
    { app_key },
    { $set: {
        app_key, status: 'not_new', reason: r, note: note || undefined,
        phone_key: phone_key || undefined,
        sheet_row: sheet_row != null && String(sheet_row).trim() !== '' ? Number(sheet_row) : undefined,
        client_name: client_name || undefined,
        set_by: operator || 'operator',
      } },
    { upsert: true },
  );
  return { ok: true, app_key, reason: r, status: 'not_new' };
}

// ─── DB: operator reopens an application (undo the override → it can be «new» again) ────────
async function reopenApplication({ phone, sheet_row } = {}, deps = {}) {
  const models = deps.models || require('../models');
  const { ApplicationOverride } = models;
  const app_key = appKeyFor({ phone, sheet_row });
  if (!app_key) return { ok: false, reason: 'no_key' };
  const res = await ApplicationOverride.deleteOne({ app_key });
  return { ok: true, app_key, removed: res.deletedCount || 0 };
}

// ─── Archive search — over ALL stored WhatsApp (both directions, all chats) ─────
// For analysing old conversations. q = full-text; phone = one client's thread. Read-only.
async function searchArchive({ q, phone, limit = 60 } = {}, deps = {}) {
  const models = deps.models || require('../models');
  const { WhatsAppMessage } = models;
  const query = {};
  if (phone) { const k = matchKey(phone); if (k) query.$or = [{ phone_key: k }, { from_phone: phone }, { to_phone: phone }]; }
  if (q && String(q).trim()) query.$text = { $search: String(q).trim() };
  const msgs = await WhatsAppMessage.find(query).sort({ received_at: -1 }).limit(Math.min(Number(limit) || 60, 500)).lean();
  return msgs.map(m => ({
    direction: m.direction || 'inbound',
    from: m.from_phone || m.lid || null, to: m.to_phone || null,
    body: m.body || ((m.attachments || []).length ? '[вложение]' : ''),
    at: m.received_at || m.sent_at || m.created_at || null,
    is_group: !!m.is_group, group_subject: m.group_subject || null, chat_id: m.chat_id || null,
  }));
}

// ─── Client card: the New-Form application fields for a phone (multi-match aware) ──────
// Reads the form rows via formFieldMapper (the rich mapper the inbox uses) and returns the
// card fields the operator needs. If several rows share the phone → newest wins, but match_count
// and the list are returned so the UI can let the operator choose. READ-ONLY.
async function applicationCardByPhone(phone, deps = {}) {
  const key = matchKey(phone);
  if (!key) return { found: false };
  const mapper = deps.mapper || require('./formFieldMapper');
  const readRows = deps.readRows || require('./mockupGenerationService').defaultReadRows;
  let header = [], rows = [];
  try { ({ header, rows } = await readRows()); } catch (_) { return { found: false, reason: 'read_failed' }; }

  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    let app; try { app = mapper.mapRow(header, rows[i], { docType: null }); } catch (_) { continue; }
    const ph = app && app.applicant && app.applicant.phone;
    if (ph && matchKey(ph) === key) matches.push({ sheet_row: i + 2, app, submitted_at: app.submitted_at || null });
  }
  if (!matches.length) return { found: false };
  matches.sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));  // newest first
  const a = matches[0].app;
  const tnved = a.tnved_text || (a.items || []).map(x => x.tnved).filter(Boolean).join(', ') || null;
  const card = {
    sheet_row:          matches[0].sheet_row,
    submitted_at:       a.submitted_at || null,
    company_name:       (a.applicant && a.applicant.name) || a.legal_entity || null,
    entity_type:        a.legal_entity || null,          // «ИП» / «ОсОО или ООО или ТОО»
    fio:                (a.applicant && a.applicant.name) || null,
    inn:                (a.applicant && a.applicant.inn) || null,
    reg_country:        a.l_e_country || null,
    tnved,
    goods:              a.items_text || null,
    producer:           (a.manufacturer && a.manufacturer.name) || null,
    production_country: (a.manufacturer && a.manufacturer.country) || null,
    brand:              a.brand || null,
    age_group:          a.age || null,
  };
  return {
    found: true, card, match_count: matches.length,
    matches: matches.map(x => ({ sheet_row: x.sheet_row, submitted_at: x.submitted_at, name: x.app.applicant && x.app.applicant.name })),
  };
}

// ─── Client card: a short RU summary of the WhatsApp conversation (PURE, rule-based) ──────
// Example: «Последний контакт 12 дн. назад. Клиент ждёт стоимость. Ответа после нашего сообщения
// не было.» Built from the message stream + signals — no LLM, deterministic.
function conversationSummary(messages = [], opts = {}) {
  if (!messages.length) return 'Переписки в WhatsApp пока нет.';
  const now = opts.now || Date.now();
  const last = messages[messages.length - 1];
  const lastAt = last.at ? new Date(last.at).getTime() : null;
  const days = lastAt != null ? Math.floor((now - lastAt) / 86400000) : null;
  const parts = [];
  if (days != null) parts.push(days <= 0 ? 'Последний контакт сегодня.' : `Последний контакт ${days} дн. назад.`);

  const outbound = messages.filter(m => m.direction === 'outbound');
  const inbound = messages.filter(m => m.direction !== 'outbound');
  const weSentOffer = outbound.some(m => weSentCalc(m.body || ''));
  const lastInbound = inbound.length ? inbound[inbound.length - 1] : null;
  const lastText = lastInbound && lastInbound.body ? String(lastInbound.body) : '';

  if (lastText && isRefused(lastText)) parts.push('Клиент написал отказ — уточнить актуальность.');
  else if (lastText && clientSaidPaid(lastText)) parts.push('Клиент сообщил об оплате.');
  else if (weSentOffer) parts.push('Мы отправляли стоимость — клиент ждёт/рассматривает.');
  else if (inbound.length && !outbound.length) parts.push('Клиент писал, мы ещё не отвечали.');

  // Who owes the next move.
  if (last.direction === 'outbound') parts.push('Ответа после нашего сообщения не было.');
  else parts.push('Клиент ждёт нашего ответа.');

  return parts.join(' ');
}

module.exports = { buildTasks, threadKey, waName, declIndexFromRows, declNameIndexFromRows, normClientName, proposeReply, fmtSom, isRefused, clientSaidPaid, weSentCalc, classifyApplication, tasks, thread, markThread, searchArchive, appKeyFor, markApplication, reopenApplication, applicationCardByPhone, conversationSummary };
