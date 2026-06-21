'use strict';

// services/piCalculationService.js — PI (протокол испытаний) calculation engine.
//
// PURE + deterministic. Computes the number of test protocols (ПИ), the sample count,
// and an ESTIMATED cost from an application's compositions, using the operator-approved
// Master KB V2 rules:
//   • Первый ПИ входит в стоимость документа.
//   • Дополнительный ПИ: ДС +7 000 сом, СС +9 000 сом.
//   • Количество ПИ = количество РАЗНЫХ составов (+ требования лаборатории).
//   • База: ДС от 15 000 сом (Дастан, 1 образец/состав); СС от 35 000 сом (Бермет, 2 образца/состав).
//
// Per KB rule #18 the agent NEVER finalizes price: this returns an estimate plus the
// basis and a needs_operator_confirmation flag. No I/O, no production actions.

const errorUtils = require('../utils/errorUtils');

// Mirrors operator Master KB V2 (Payments / PI / Laboratories / Samples).
const PRICING = {
  'ДС': { base: 15000, additional_pi: 7000, samples_per_composition: 1, laboratory: 'Дастан', validity: '3 года' },
  'СС': { base: 35000, additional_pi: 9000, samples_per_composition: 2, laboratory: 'Бермет', validity: '1 год' },
};
const CURRENCY = 'сом';

// normalizeDocType — accept RU/EN/abbrev forms → 'ДС' | 'СС'.
function normalizeDocType(t) {
  const s = String(t || '').trim().toLowerCase();
  if (/^(дс|ds|деклараци|declaration)/.test(s)) return 'ДС';
  if (/^(сс|cc|ss|сертификат|certificate)/.test(s)) return 'СС';
  return null;
}

// countCompositions — distinct non-empty составы (case/space-insensitive). Accepts an
// array of strings or a number; minimum 1.
function countCompositions(input) {
  if (typeof input === 'number' && isFinite(input)) return Math.max(1, Math.floor(input));
  if (Array.isArray(input)) {
    const set = new Set(input.map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
    return Math.max(1, set.size);
  }
  return 1;
}

// computePi({ doc_type, compositions?, pi_count?, base_price? }) → estimate + basis.
function computePi({ doc_type, compositions, pi_count, base_price } = {}) {
  const dt = normalizeDocType(doc_type);
  if (!dt) throw errorUtils.validationError(`Unknown doc_type "${doc_type}" (use ДС or СС)`);
  const cfg = PRICING[dt];

  const count = pi_count != null ? Math.max(1, Math.floor(pi_count)) : countCompositions(compositions);
  const additional = Math.max(0, count - 1);
  const base = base_price != null ? base_price : cfg.base;
  const additional_cost = additional * cfg.additional_pi;
  const total = base + additional_cost;
  const samples = count * cfg.samples_per_composition;

  const basis = [
    `Документ: ${dt} (лаборатория ${cfg.laboratory}, действует ${cfg.validity}).`,
    `Количество ПИ = число разных составов = ${count}.`,
    `Первый ПИ включён в стоимость; дополнительных ПИ: ${additional} × ${cfg.additional_pi} ${CURRENCY} = ${additional_cost} ${CURRENCY}.`,
    `База${base_price == null ? ' (от)' : ''}: ${base} ${CURRENCY}. Итог${base_price == null ? ' (от)' : ''}: ${total} ${CURRENCY}.`,
    `Образцы: ${count} состав(ов) × ${cfg.samples_per_composition} = ${samples} образец(ов).`,
  ];

  return {
    doc_type: dt,
    laboratory: cfg.laboratory,
    pi_count: count,
    included_pi: 1,
    additional_pi: additional,
    base_price: base,
    additional_pi_unit: cfg.additional_pi,
    additional_cost,
    total_estimate: total,
    is_minimum: base_price == null,      // base is "от" → estimate is a floor
    currency: CURRENCY,
    samples_required: samples,
    samples_per_composition: cfg.samples_per_composition,
    basis,
    reasoning: basis.join(' '),
    confidence: Array.isArray(compositions) || pi_count != null ? 'MEDIUM' : 'LOW',
    needs_operator_confirmation: true,   // KB rule #18 — operator finalizes price
  };
}

module.exports = { PRICING, CURRENCY, normalizeDocType, countCompositions, computePi };
