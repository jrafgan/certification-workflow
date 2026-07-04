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

// Максимальный возраст «новой заявки» в инбоксе — заявки старше уже неактуальны (клиент
// пропал), их прячем из списка «Новые заявки». Env: NEW_APP_MAX_AGE_DAYS.
const NEW_APP_MAX_AGE_DAYS = parseInt(process.env.NEW_APP_MAX_AGE_DAYS, 10) || 30;

// isRefused(text) — клиент по переписке ЯВНО отказался делать документ у нас. Консервативно:
// прячем заявку только на однозначных формулировках отказа (ложное сокрытие = потерянный
// лид, поэтому без догадок). RU/KY. PURE.
const REFUSED_RE = /переду?мал|отказ(ыва|ыва[ю]сь|ался|аться|ное(?!\s*письмо))|не\s+буд[уе]м?\b|не\s+актуальн|в\s+другом\s+месте|(нашл[иа]|сделал[иа]?|оформил[иа]?|заказал[иа]?)\s+(в\s+)?друг|уже\s+(сделал|оформил|получил|заказал)|(спасибо|благодар)\w*[,\s].{0,15}не\s+(над|нуж)|не\s+интересует|не\s+нужн\w*\s+(больше|уже)|башка\s+жерден|кереги\s+жок/i;
function isRefused(text = '') { return REFUSED_RE.test(String(text || '')); }

// clientSaidPaid(text) — клиент по переписке сообщил, что оплатил (мягкий сигнал в дополнение
// к Декларации кол. G). Совпадает с leadIntent.payment_made. PURE.
const CLIENT_PAID_RE = /оплатил|оплачен|перев[её]л|перечислил|чек(?![а-яё])|квитанц|оплату\s+(отправил|скинул|кинул)|тол[её]д[уи]м/i;
function clientSaidPaid(text = '') { return CLIENT_PAID_RE.test(String(text || '')); }

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
  // phone_key'и, которые смысловой классификатор (LLM точечно) распознал как отказ — считаются
  // отдельно и передаются готовыми, чтобы buildTasks оставалась ЧИСТОЙ (без LLM/I-O).
  const semanticRefused = input.semanticRefusedKeys instanceof Set
    ? input.semanticRefusedKeys : new Set(input.semanticRefusedKeys || []);
  const now = input.now || Date.now();

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

  // Index inbound WhatsApp text per client phone_key — used to hide new applications where the
  // client already refused OR reported payment in chat (we "сшиваем" the form row with the WA
  // thread + «Декларация» to decide, per operator request).
  const waTextByKey = new Map();
  for (const m of waMessages) {
    if (m.direction && m.direction !== 'inbound') continue;
    const k = threadKey(m);
    if (!k || !m.body) continue;
    const arr = waTextByKey.get(k) || []; arr.push(String(m.body)); waTextByKey.set(k, arr);
  }

  // 3) New applications with no price calculation yet. The submission date (col A) lets the
  //    operator spot STALE applications the client may have abandoned.
  // HIDDEN from the list (per operator request): older than NEW_APP_MAX_AGE_DAYS, already paid
  //    (Декларация col G > 0 OR client said so in WhatsApp), or refused in WhatsApp.
  let hiddenNewApps = 0;
  for (const a of newApplications) {
    const subMs = a.submitted_at ? Date.parse(a.submitted_at) : null;
    const ageMs = subMs ? Math.max(0, now - subMs) : 0;
    const days = subMs ? Math.floor(ageMs / 86400000) : null;

    const pk = a.phone ? matchKey(a.phone) : '';
    const decl = pk ? (declByPhone[pk] || null) : null;
    const waTexts = pk ? (waTextByKey.get(pk) || []) : [];
    const tooOld  = days != null && days > NEW_APP_MAX_AGE_DAYS;
    const isPaid  = (decl && decl.paid > 0) || waTexts.some(clientSaidPaid);
    const refused = waTexts.some(isRefused) || (pk && semanticRefused.has(pk));   // regex ИЛИ смысловой (LLM)
    if (tooOld || isPaid || refused) { hiddenNewApps++; continue; }

    const stale = days != null && days >= 14;                // ~2 weeks silent → likely abandoned
    const dateRu = subMs ? new Date(subMs).toLocaleDateString('ru-RU') : 'дата неизвестна';
    tasks.push({
      kind: 'new_application',
      phone: null, phone_key: null,
      title: `Новая заявка · ${a.applicant || a.legal_entity || '—'}`,
      subtitle: `${dateRu}${days != null ? ` · ${days} дн. назад` : ''}${stale ? ' · ⚠ давняя' : ''}`,
      last_message: 'нет просчёта — нужно подготовить',
      channel: 'application',
      age_ms: ageMs,
      last_at: a.submitted_at || null,
      submitted_at: a.submitted_at || null,
      age_days: days,
      stale,
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
  const { WhatsAppMessage, EmailDraft, InboxThreadState } = models;
  const safe = async (p, d) => { try { return await p; } catch (_) { return d; } };

  const wq = require('./workQueueService');
  const [waMessages, labDrafts, stateDocs, newApps, declRows] = await Promise.all([
    // Inbox = direct chats + group messages addressed to the operator (archived group chatter
    // is excluded here, but still stored for search — see archiveOutbound / wa-search).
    safe(WhatsAppMessage.find({ direction: 'inbound', $or: [{ is_group: { $ne: true } }, { addressed_me: true }] }).sort({ received_at: -1 }).limit(500).lean(), []),
    safe(EmailDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(100).lean(), []),
    safe(InboxThreadState.find().lean(), []),
    safe(wq.newApplications(), []),
    // LIVE «Декларация» read (source of truth) — used to resolve orders, since the Mongo
    // Declaration replica is empty (whatsapp-match-empty-replica-bug).
    safe((deps.readDeclaration || wq.defaultReadDeclaration)(), []),
  ]);

  const threadStates = {};
  for (const s of stateDocs) threadStates[s.phone_key] = s;

  const labEmails = labDrafts.map(d => ({
    id: d._id, subject: d.subject, to: d.to_email, client_name: d.client_name,
    order_id: d.order_id, created_at: d.created_at,
  }));

  const declByPhone = declIndexFromRows(declRows || []);

  // Смысловой разбор (§4 ТЗ): для новых заявок, где отказ не ловится регуляркой, распознаём его
  // по СМЫСЛУ (LLM точечно) и передаём готовый набор ключей в чистую buildTasks. LLM НЕ на пути
  // рендера каждой строки: только последнее входящее по неоднозначным заявкам, с бюджетом и
  // кэшем (messageIntentService). Устойчиво: нет ключа/ошибка → просто без смыслового сигнала.
  const semanticRefusedKeys = new Set();
  try {
    const messageIntent = deps.messageIntent || require('./messageIntentService');
    const latestInbound = new Map();                       // phone_key → текст последнего входящего
    for (const m of waMessages) {
      if (m.direction && m.direction !== 'inbound') continue;
      const k = threadKey(m); if (!k || !m.body) continue;
      if (!latestInbound.has(k)) latestInbound.set(k, m.body);   // waMessages newest-first
    }
    let budget = Number.isFinite(deps.llmBudget) ? deps.llmBudget : 4;   // максимум LLM-вызовов за загрузку
    for (const a of (newApps || [])) {
      if (budget <= 0) break;
      const pk = a.phone ? matchKey(a.phone) : ''; if (!pk) continue;
      const decl = declByPhone[pk];
      if (decl && decl.paid > 0) continue;                 // оплачен — и так скрыт, LLM не тратим
      const subMs = a.submitted_at ? Date.parse(a.submitted_at) : null;
      if (subMs && (Date.now() - subMs) / 86400000 > NEW_APP_MAX_AGE_DAYS) continue;   // старая — и так скрыта
      const last = latestInbound.get(pk); if (!last) continue;
      if (isRefused(last)) continue;                        // regex уже поймает — LLM не нужен
      const r = await messageIntent.classifyDecision(last, deps);
      if (r && r.decision === 'refuse' && (r.confidence || 0) >= 0.7) semanticRefusedKeys.add(pk);
      if (r && r.method === 'llm') budget--;
    }
  } catch (_) { /* классификатор недоступен → без смыслового сигнала */ }

  return buildTasks({
    waMessages, threadStates, labEmails, newApplications: newApps || [],
    declByPhone, semanticRefusedKeys, now: Date.now(),
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
  const names = [...new Set([ent && ent.legal_entity, ...((ent && ent.orders) || []).map(o => o.client)].filter(Boolean))];
  let email_history = [];
  if (names.length) {
    const [emailDrafts, orders] = await Promise.all([
      safe(EmailDraft.find({ client_name: { $in: names } }).sort({ created_at: -1 }).limit(20).lean(), []),
      safe(Order.find({ $or: [{ 'client.name': { $in: names } }, { 'client.companyName': { $in: names } }] }).select('_id').limit(50).lean(), []),
    ]);
    const orderIds = orders.map(o => o._id);
    const threads = orderIds.length ? await safe(LabCommThread.find({ order_id: { $in: orderIds } }).sort({ created_at: -1 }).limit(20).lean(), []) : [];
    email_history = [
      ...threads.map(t => ({ kind: 'lab', recipient: t.recipient_email || null, status: t.status || null, at: t.reply_detected_at || t.sent_at || t.created_at || null, has_attachment: !!t.reply_has_attachment })),
      ...emailDrafts.map(d => ({ kind: 'draft', recipient: d.to_email || null, status: `черновик · ${d.state || ''}`, at: d.created_at || null, subject: d.subject || null })),
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 10);
  }

  // AGENT SUGGESTED REPLY (always present): a stored agent draft if one exists, else generated.
  const drafts = await safe(LeadMessageDraft.find({ state: { $in: ['pending_approval', 'changes_requested'] } }).sort({ created_at: -1 }).limit(50).lean(), []);
  const draftDoc = drafts.find(d => matchKey(d.to_handle) === key) || null;
  const proposed_reply = draftDoc
    ? { text: draftDoc.proposed_text, kind: draftDoc.kind, reason: 'готовый черновик агента', draft_id: String(draftDoc._id), state: draftDoc.state }
    : proposeReply(ent);

  return {
    found: true,
    phone, phone_key: key,
    entity: ent,
    payment: ent ? { paid: ent.paid_total, debt: ent.debt_total, is_paid: ent.is_paid } : { paid: 0, debt: 0, is_paid: false },
    origin, next_step,
    messages,
    email_history,
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

module.exports = { buildTasks, threadKey, waName, declIndexFromRows, proposeReply, fmtSom, isRefused, clientSaidPaid, tasks, thread, markThread, searchArchive };
