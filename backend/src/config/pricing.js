'use strict';

// config/pricing.js — operator-tunable prices, validity and samples (single source of truth).
//
// These CHANGE OVER TIME, so they are env-overridable — edit .env, no code change needed.
// Both piCalculationService (calculation) and the Master KB (client-facing answers) read
// from here, so prices/validity stay in sync everywhere.
//
// ДС depends on ДОКУМЕНТЫ НА ШВЕЙНЫЙ ЦЕХ (two issuing bodies — see labRecipients.js):
//   • нет документов на цех → дороже база, срок 3 года;
//   • есть документы на цех  → дешевле база, срок 1 год.

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v, d) => (v != null && String(v).trim() ? String(v).trim() : d);

const CURRENCY = process.env.LAB_PRICE_CURRENCY || 'сом';

const PRICING = {
  'ДС': {
    samples_per_composition: num(process.env.LAB_DS_SAMPLES_PER_COMPOSITION, 2), // всегда 2/состав
    laboratory:              process.env.LAB_DS_LABORATORY_LABEL || 'уточняется',
    variants: {
      // НЕТ документов на цех: 18 000, доп. ПИ 9 000, 2 образца/состав, БЕЗ ГАРАНТИИ (протокол из Казахстана).
      no_workshop:   { base: num(process.env.LAB_PRICE_DS_NO_WORKSHOP, 18000),   additional_pi: num(process.env.LAB_PRICE_DS_NO_WORKSHOP_ADDITIONAL_PI, 9000),   validity: str(process.env.LAB_DS_NO_WORKSHOP_VALIDITY, '3 года'), samples_per_composition: num(process.env.LAB_DS_NO_WORKSHOP_SAMPLES, 2), guarantee: false },
      // ЕСТЬ документы на цех (тех. паспорт ИЛИ договор аренды): 17 000, доп. ПИ 10 000, 2 образца/состав, с гарантией.
      with_workshop: { base: num(process.env.LAB_PRICE_DS_WITH_WORKSHOP, 17000), additional_pi: num(process.env.LAB_PRICE_DS_WITH_WORKSHOP_ADDITIONAL_PI, 10000), validity: str(process.env.LAB_DS_WITH_WORKSHOP_VALIDITY, '1 год'), samples_per_composition: num(process.env.LAB_DS_WITH_WORKSHOP_SAMPLES, 2), guarantee: true },
    },
    default_variant: 'no_workshop',
  },
  'СС': {
    base:                    num(process.env.LAB_PRICE_SS, 35000),              // местные ИП/ОсОО
    additional_pi:           num(process.env.LAB_PRICE_SS_ADDITIONAL_PI, 10000),
    samples_per_composition: num(process.env.LAB_SS_SAMPLES_PER_COMPOSITION, 2),
    laboratory:              process.env.LAB_SS_LABORATORY_LABEL || 'Бермет',
    validity:                str(process.env.LAB_SS_VALIDITY, '1 год'),
    // СС для ЗАРУБЕЖНЫХ юрлиц — отдельная цена и доп. протокол (местные остаются на base выше).
    foreign_legal_entity: {
      base:          num(process.env.LAB_PRICE_SS_FOREIGN, 50000),
      additional_pi: num(process.env.LAB_PRICE_SS_FOREIGN_ADDITIONAL_PI, 13000),
    },
  },
};

// ДС top-level base/validity/additional_pi mirror the default variant (backward-compatible
// reads). Доп-ПИ теперь per-variant (с цехом 10000 / без цеха 9000); top-level = default.
PRICING['ДС'].base          = PRICING['ДС'].variants[PRICING['ДС'].default_variant].base;
PRICING['ДС'].validity      = PRICING['ДС'].variants[PRICING['ДС'].default_variant].validity;
PRICING['ДС'].additional_pi = PRICING['ДС'].variants[PRICING['ДС'].default_variant].additional_pi;

module.exports = { PRICING, CURRENCY };
