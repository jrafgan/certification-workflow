'use strict';

// services/piCalculationService.js — PI (протокол испытаний) calculation engine.
//
// PURE + deterministic. Computes the number of test protocols (ПИ), the sample count,
// and an ESTIMATED cost from an application's compositions, using the operator-approved
// Master KB V2 rules:
//   • Первый ПИ входит в стоимость документа.
//   • Дополнительный ПИ (доп. протокол): ДС +10 000 сом; СС местные +9 000, СС зарубеж +13 000.
//   • Количество ПИ = количество РАЗНЫХ составов (+ требования лаборатории).
//   • ДС зависит от ДОКУМЕНТОВ НА ШВЕЙНЫЙ ЦЕХ (агент уточняет у клиента):
//       – нет документов на цех → база 18 000, срок 3 года, 1 образец/состав, БЕЗ ГАРАНТИИ
//         (протокол из Казахстана, риск на таможне); орган svnsert7@gmail.com;
//       – есть документы на цех (тех. паспорт ИЛИ договор аренды) → база 17 000, срок 1 год,
//         2 образца/состав, с гарантией (орган — почта пока ждём).
//     По умолчанию (не уточнено) считаем как «нет документов» и помечаем needs_workshop_clarification.
//   • СС: местные ИП/ОсОО от 35 000; зарубежные юрлица 50 000 (foreign_entity). Бермет/Кыргыз
//     Тест, 2 образца/состав, срок 1 год.
//
// Per KB rule #18 the agent NEVER finalizes price: this returns an estimate plus the
// basis and a needs_operator_confirmation flag. No I/O, no production actions.

const errorUtils = require('../utils/errorUtils');

// Prices/validity/samples are operator-tunable (env) — single source of truth in config/pricing.
const { PRICING, CURRENCY } = require('../config/pricing');

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

// computePi({ doc_type, compositions?, pi_count?, base_price?, has_workshop_docs?, foreign_entity? })
// → estimate + basis. For ДС, has_workshop_docs (true/false) picks the variant (base, validity,
// samples); when omitted we use the default (no_workshop) and flag needs_workshop_clarification so
// the agent asks the client first. For СС, foreign_entity=true uses the foreign legal-entity price.
function computePi({ doc_type, compositions, pi_count, base_price, has_workshop_docs, foreign_entity } = {}) {
  const dt = normalizeDocType(doc_type);
  if (!dt) throw errorUtils.validationError(`Unknown doc_type "${doc_type}" (use ДС or СС)`);
  const cfg = PRICING[dt];

  // Per-variant resolution. ДС: цех-documents pick base/validity/samples. СС: foreign legal
  // entity has its own base + доп-protocol price; local stays on cfg.base.
  let variant = null, variantBase = cfg.base, validity = cfg.validity, needs_workshop_clarification = false;
  let additionalPiUnit = cfg.additional_pi;
  let samplesPer = cfg.samples_per_composition;
  let foreign = false;
  if (dt === 'ДС' && cfg.variants) {
    variant = has_workshop_docs === true ? 'with_workshop'
            : has_workshop_docs === false ? 'no_workshop'
            : cfg.default_variant;
    const v = cfg.variants[variant];
    variantBase = v.base;
    validity    = v.validity;
    if (v.additional_pi != null) additionalPiUnit = v.additional_pi; // доп-ПИ per-variant (с цехом 10000 / без 9000)
    if (v.samples_per_composition != null) samplesPer = v.samples_per_composition;
    needs_workshop_clarification = has_workshop_docs === undefined;
  } else if (dt === 'СС' && foreign_entity === true && cfg.foreign_legal_entity) {
    foreign = true;
    variantBase     = cfg.foreign_legal_entity.base;
    additionalPiUnit = cfg.foreign_legal_entity.additional_pi;
  }

  const count = pi_count != null ? Math.max(1, Math.floor(pi_count)) : countCompositions(compositions);
  const additional = Math.max(0, count - 1);
  const base = base_price != null ? base_price : variantBase;
  const additional_cost = additional * additionalPiUnit;
  const total = base + additional_cost;
  const samples = count * samplesPer;

  const dsTag = variant ? ` (${variant === 'with_workshop' ? 'есть документы на цех' : 'нет документов на цех'})` : '';
  const ssTag = foreign ? ' (зарубежное юрлицо)' : '';
  const basis = [
    `Документ: ${dt}${dsTag}${ssTag} (лаборатория ${cfg.laboratory}, действует ${validity}).`,
    `Количество ПИ = число разных составов = ${count}.`,
    `Первый ПИ включён в стоимость; дополнительных ПИ: ${additional} × ${additionalPiUnit} ${CURRENCY} = ${additional_cost} ${CURRENCY}.`,
    `База${base_price == null ? ' (от)' : ''}: ${base} ${CURRENCY}. Итог${base_price == null ? ' (от)' : ''}: ${total} ${CURRENCY}.`,
    `Образцы: ${count} состав(ов) × ${samplesPer} = ${samples} образец(ов).`,
  ];
  if (dt === 'ДС' && variant === 'no_workshop') {
    basis.push('БЕЗ ГАРАНТИИ: протокол оформляется из Казахстана — есть риск, что таможня не пропустит. С документами на цех (тех. паспорт или договор аренды) — с гарантией.');
  }
  if (needs_workshop_clarification) {
    basis.push('ВНИМАНИЕ: цех-документы не уточнены — расчёт предварительный как «нет документов на цех». Уточните у клиента (влияет на цену, срок и орган).');
  }

  return {
    doc_type: dt,
    laboratory: cfg.laboratory,
    declaration_variant: variant,
    foreign_entity: foreign,
    validity,
    needs_workshop_clarification,
    pi_count: count,
    included_pi: 1,
    additional_pi: additional,
    base_price: base,
    additional_pi_unit: additionalPiUnit,
    additional_cost,
    total_estimate: total,
    is_minimum: base_price == null,      // base is "от" → estimate is a floor
    currency: CURRENCY,
    samples_required: samples,
    samples_per_composition: samplesPer,
    basis,
    reasoning: basis.join(' '),
    confidence: Array.isArray(compositions) || pi_count != null ? 'MEDIUM' : 'LOW',
    needs_operator_confirmation: true,   // KB rule #18 — operator finalizes price
  };
}

module.exports = { PRICING, CURRENCY, normalizeDocType, countCompositions, computePi };
