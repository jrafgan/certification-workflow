'use strict';

// services/clientEntityService.js — the CLIENT ENTITY (сущность), keyed by WhatsApp phone.
//
// One client = one WhatsApp number (primary ID). Around it information accretes: legal entity
// (secondary ID), «Декларация» orders (status), application, mockups, lab emails — and (from
// WhatsApp, when that channel is live) the IP/OsOO certificate and payment receipts → debt.
//
// This aggregates ONLY confirmed sources, read-only: «Декларация» (J=phone, N=status, D=client),
// «Новая форма», and the operator-confirmed phone↔entity registry. The agent's job: know each
// entity's STAGE and WHO must act next, and never let an entity be forgotten until «Завершен».
//
// buildByPhone() composes; nextActorFor()/stageFor() are PURE and exported for tests.

const { matchKey } = require('../utils/phoneUtils');

const DECL_CLIENT_COL = 3;   // D — Клиент
const DECL_PHONE_COL  = 9;   // J — Номер тел (primary ID)
const DECL_STATUS_COL = 13;  // N — Статус

function norm(s) { return String(s || '').trim().toLowerCase(); }

// stageFor(status) — coarse stage from the free-text «Декларация» status (N). ADVISORY.
function stageFor(status) {
  const s = norm(status);
  if (!s || s === 'запустить') return 'intake';
  if (s.includes('заверш')) return 'done';
  if (s.includes('отказ')) return 'refusal';
  if (s.includes('ориги')) return 'awaiting_original';
  if (s.includes('на согласов')) return 'on_approval';
  if (s.includes('согласов')) return 'approved';
  if (s.includes('макет') || s.includes('запущ')) return 'awaiting_layout';
  return 'unknown';
}

// nextActorFor(status) — WHO must act next: 'operator' | 'lab' | 'client' | null (done). ADVISORY.
function nextActorFor(status) {
  switch (stageFor(status)) {
    case 'done':              return null;
    case 'intake':            return 'operator';   // нужно запустить / создать макет
    case 'awaiting_layout':   return 'lab';        // ждём макет от лаборатории
    case 'on_approval':       return 'client';     // клиент согласовывает макет
    case 'approved':          return 'lab';        // согласовано → лаборатория делает оригинал
    case 'awaiting_original': return 'lab';        // ждём оригинал
    case 'refusal':           return 'operator';   // проверить отказ
    default:                  return 'operator';   // неизвестный статус → оператор уточняет
  }
}

const ACTOR_RU = { operator: 'оператор', lab: 'лаборатория', client: 'клиент' };

// ─── Compose the entity by phone (read-only) ───────────────────────────────────
async function buildByPhone(phone, deps = {}) {
  const phone_key = matchKey(phone);
  if (!phone_key) return { found: false, reason: 'bad_phone' };

  const readDecl = deps.readDeclaration || require('./workQueueService').defaultReadDeclaration;
  const readForm = deps.readRows || require('./mockupGenerationService').defaultReadRows;
  const mapper   = deps.mapper || require('./formFieldMapper');
  const resolveEntity = deps.resolveEntity || ((p) => require('./phoneEntityService').resolve(p));

  const safe = async (p, d) => { try { return await p; } catch (_) { return d; } };

  // «Декларация» orders for this phone (J), verbatim status (N) + client (D).
  const declRows = (await safe(readDecl(), []))
    .filter(r => matchKey(r[DECL_PHONE_COL]) === phone_key)
    .map(r => ({ client: String(r[DECL_CLIENT_COL] || '').trim() || null, status: String(r[DECL_STATUS_COL] || '').trim() || null }));

  // «Новая форма» application for this phone.
  let application = null;
  const form = await safe(readForm(), { header: [], rows: [] });
  for (let i = (form.rows || []).length - 1; i >= 0; i--) {
    const app = mapper.mapRow(form.header, form.rows[i], { docType: null });
    if (app.applicant && app.applicant.phone && matchKey(app.applicant.phone) === phone_key && app.applicant.name) {
      application = { sheet_row: i + 2, name: app.applicant.name, legal_entity: app.legal_entity || null, age: app.age || null };
      break;
    }
  }

  // Confirmed phone↔entity registry (Phase 2).
  const link = await safe(resolveEntity(phone), null);

  // Secondary ID: registry → Declaration client (D) → form legal entity + name.
  const legal_entity = (link && link.legal_entity)
    || (declRows.find(d => d.client) || {}).client
    || (application ? [application.legal_entity, application.name].filter(Boolean).join(' ').trim() : null)
    || null;

  // Orders with advisory stage + next actor.
  const orders = declRows.map(d => ({
    client: d.client, status: d.status,
    stage: stageFor(d.status), next_actor: nextActorFor(d.status), next_actor_ru: ACTOR_RU[nextActorFor(d.status)] || null,
  }));
  const active = orders.filter(o => o.stage !== 'done');

  return {
    found: true,
    phone, phone_key,
    legal_entity,                                   // second ID
    entity_confirmed: !!(link && link.legal_entity),
    in_declaration: declRows.length > 0,
    is_new_application: declRows.length === 0 && !!application,
    application,
    orders,
    active_count: active.length,
    alive: active.length > 0 || declRows.length === 0,   // «живёт», пока не все «Завершен»
    // From WhatsApp — pending the WhatsApp channel (receive-only / not yet ingesting).
    whatsapp_pending: {
      certificate: 'из WhatsApp (канал не подключён)',
      payment_receipts: 'из WhatsApp (канал не подключён)',
      debt: 'считается после данных об оплате (из WhatsApp)',
    },
    recommend_only: true,
  };
}

module.exports = { stageFor, nextActorFor, ACTOR_RU, buildByPhone, DECL_PHONE_COL, DECL_STATUS_COL, DECL_CLIENT_COL };
