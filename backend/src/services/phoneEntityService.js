'use strict';

// services/phoneEntityService.js — Phone ↔ Legal Entity Registry (Phase 2).
//
// Persists and resolves the WhatsApp# ↔ legal-entity binding. Invariant: ONE number →
// ONE CONFIRMED entity. Fully GATED + recommend-only: propose() creates a 'proposed' row,
// an operator confirm()s or reject()s. NOTHING is written to Declaration / Google Sheets /
// Email / WhatsApp here — this is an internal registry of proposals/confirmations.
//
// Consumed by order / application / email matching and the Status Verification Engine via
// resolve(phone) and findByEntity(name). The reasoning helpers are PURE (no I/O) + exported.

const { matchKey } = require('../utils/phoneUtils');
const errorUtils = require('../utils/errorUtils');

// ─── Pure helpers ─────────────────────────────────────────────────────────────

// Legal-form tokens are ignored when comparing entity names (ИП Иванов ≈ Иванов).
const ORG = new Set(['ип', 'осоо', 'оао', 'тоо', 'ооо', 'зао', 'чп', 'llc', 'ip']);

function entityTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^0-9a-zа-яё]+/gi, ' ')
    .split(' ')
    .filter(t => t.length >= 3 && !ORG.has(t));
}

// sameEntity — true when two entity names share their meaningful (non-legal-form) tokens.
// Empty/uncomparable names never match (avoids false "same").
function sameEntity(a, b) {
  const ta = entityTokens(a);
  const tb = entityTokens(b);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  return ta.some(t => setB.has(t));
}

// assessProposal — given the existing CONFIRMED link for a number (or null) and a proposed
// entity, decide whether the proposal conflicts with the confirmed binding. PURE.
//   → { conflict, type, detail }
//     no_confirmed     — number has no confirmed entity yet (proposal is clean)
//     matches_confirmed— proposed entity matches the confirmed one (idempotent)
//     conflict         — proposed entity differs from the confirmed one (operator must resolve)
function assessProposal(existingConfirmed, proposedEntity) {
  if (!existingConfirmed) return { conflict: false, type: 'no_confirmed', detail: 'Нет подтверждённой привязки для номера.' };
  if (sameEntity(existingConfirmed.legal_entity, proposedEntity)) {
    return { conflict: false, type: 'matches_confirmed', detail: `Совпадает с подтверждённым «${existingConfirmed.legal_entity}».` };
  }
  return {
    conflict: true,
    type: 'conflict',
    detail: `Номер уже подтверждён за «${existingConfirmed.legal_entity}», предложено другое юр.лицо «${proposedEntity}» — нужно решение оператора.`,
  };
}

// normalizeKey — exposed so callers can derive the same join key the registry stores.
function normalizeKey(phone) { return matchKey(phone); }

// ─── DB helpers ───────────────────────────────────────────────────────────────

function model(deps = {}) {
  return deps.PhoneEntityLink || require('../models/PhoneEntityLink').PhoneEntityLink;
}

// confirmedFor — the single confirmed link for a number, or null.
async function confirmedFor(phoneKey, deps = {}) {
  if (!phoneKey) return null;
  return model(deps).findOne({ phone_key: phoneKey, status: 'confirmed' }).lean();
}

// propose — create a 'proposed' link (GATED; never auto-confirms). Records a conflict flag
// when the number already has a different confirmed entity. Idempotent on an existing OPEN
// proposal for the same (number, entity).
async function propose({ phone, legal_entity, client_name, order_id, declaration_id, source = 'conversation', evidence = [], notes } = {}, deps = {}) {
  const PhoneEntityLink = model(deps);
  const phone_key = matchKey(phone);
  if (!phone_key) throw errorUtils.validationError('Не удалось определить номер (phone_key пуст).');
  if (!legal_entity || !String(legal_entity).trim()) throw errorUtils.validationError('Не указано юр.лицо (legal_entity).');

  const existing = await confirmedFor(phone_key, deps);
  const assessment = assessProposal(existing, legal_entity);

  // Idempotency: an open proposal for the same number+entity → return it unchanged.
  const dup = await PhoneEntityLink.findOne({ phone_key, status: 'proposed' }).lean();
  if (dup && sameEntity(dup.legal_entity, legal_entity)) return { link: dup, assessment, created: false };

  // Already confirmed to the same entity → nothing to propose.
  if (assessment.type === 'matches_confirmed') return { link: existing, assessment, created: false };

  const doc = await PhoneEntityLink.create({
    phone_key,
    phone_raw: phone,
    legal_entity: String(legal_entity).trim(),
    client_name,
    order_id: order_id || undefined,
    declaration_id: declaration_id || undefined,
    source,
    status: 'proposed',
    conflict: assessment.conflict,
    conflict_detail: assessment.conflict ? assessment.detail : undefined,
    evidence,
    notes,
  });
  return { link: doc.toObject(), assessment, created: true };
}

// confirm — operator approves a proposed link. Enforces ONE confirmed entity per number:
// if a different entity is already confirmed, throws a conflict (operator must supersede
// explicitly). Confirming the SAME entity that is already confirmed supersedes the older row.
async function confirm(linkId, { confirmedBy = 'operator', supersede = false } = {}, deps = {}) {
  const PhoneEntityLink = model(deps);
  const link = await PhoneEntityLink.findById(linkId);
  if (!link) throw errorUtils.notFoundError('Привязка не найдена.');
  if (link.status === 'confirmed') return link;
  if (link.status !== 'proposed') throw errorUtils.conflictError(`Привязка уже «${link.status}».`);

  const existing = await confirmedFor(link.phone_key, deps);
  if (existing && String(existing._id) !== String(link._id)) {
    if (!sameEntity(existing.legal_entity, link.legal_entity) && !supersede) {
      throw errorUtils.conflictError(
        `Номер уже подтверждён за «${existing.legal_entity}». Для смены юр.лица требуется явное подтверждение (supersede).`
      );
    }
    // Supersede the previous confirmed binding (kept for auditability, never deleted).
    await PhoneEntityLink.updateOne(
      { _id: existing._id },
      { $set: { status: 'superseded', notes: `Заменено привязкой ${link._id} (${confirmedBy}).` } }
    );
  }

  link.status = 'confirmed';
  link.conflict = false;
  link.conflict_detail = undefined;
  link.confirmed_by = confirmedBy;
  link.confirmed_at = new Date();
  await link.save();
  return link;
}

// reject — operator dismisses a proposed link.
async function reject(linkId, { rejectedBy = 'operator' } = {}, deps = {}) {
  const PhoneEntityLink = model(deps);
  const link = await PhoneEntityLink.findById(linkId);
  if (!link) throw errorUtils.notFoundError('Привязка не найдена.');
  if (link.status !== 'proposed') throw errorUtils.conflictError(`Привязка уже «${link.status}».`);
  link.status = 'rejected';
  link.rejected_by = rejectedBy;
  link.rejected_at = new Date();
  await link.save();
  return link;
}

// resolve — the confirmed entity binding for a number (or null). Used by all matchers.
async function resolve(phone, deps = {}) {
  return confirmedFor(matchKey(phone), deps);
}

// findByEntity — confirmed numbers for an entity name (reverse / entity-based matching).
async function findByEntity(name, deps = {}) {
  const PhoneEntityLink = model(deps);
  const all = await PhoneEntityLink.find({ status: 'confirmed' }).lean();
  return all.filter(l => sameEntity(l.legal_entity, name));
}

// listForReview — proposals + conflicts awaiting the operator (conflicts first).
async function listForReview({ limit = 50 } = {}, deps = {}) {
  const PhoneEntityLink = model(deps);
  const rows = await PhoneEntityLink.find({ status: 'proposed' })
    .sort({ conflict: -1, created_at: -1 })
    .limit(limit)
    .lean();
  return rows;
}

// listConfirmed — the active registry (for matching support / inspection).
async function listConfirmed({ limit = 500 } = {}, deps = {}) {
  return model(deps).find({ status: 'confirmed' }).sort({ legal_entity: 1 }).limit(limit).lean();
}

module.exports = {
  // pure
  entityTokens,
  sameEntity,
  assessProposal,
  normalizeKey,
  // db (gated)
  propose,
  confirm,
  reject,
  resolve,
  findByEntity,
  listForReview,
  listConfirmed,
  confirmedFor,
};
