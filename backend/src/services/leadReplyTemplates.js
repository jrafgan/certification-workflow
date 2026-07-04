'use strict';

// services/leadReplyTemplates.js — outbound text the Lead Conversion Agent proposes.
//
// Education content (pricing RANGES, timelines, required docs, PI / TN VED concepts) is
// sourced from the operator-tunable config (config/pricing.js) — the SAME single source of
// truth as piCalculationService + the Master KB — so the agent never quotes a stale price.
//   ДС: от <with_workshop> сом, ~2 недели, 1–3 года (зависит от документов на цех)
//   СС: местные от <base> сом, зарубежные <foreign> сом, 1–1.5 месяца, 1 год
//   Отказное письмо: 5 000 сом
//   Первый ПИ включён; доп. ПИ: ДС +<ds>, СС +<ss> (зарубеж +<ss_foreign>)
//   ТН ВЭД: 61 — трикотаж, 62 — швейка (несовместимы); детское/взрослое — отдельно
// EXACT pricing is never quoted here — only "от …" ranges; the final price is operator-set.

const { PRICING, CURRENCY } = require('../config/pricing');
const DS = PRICING['ДС'], SS = PRICING['СС'];

// Client-facing thousands formatting: 17000 → "17 000".
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
//
// auto_allowed map mirrors the spec's two lists. Per the operator's decision, ALL kinds are
// still produced as drafts (never auto-sent); auto_allowed only marks what the spec WOULD
// permit to auto-release.

// Application form link is a configurable BUSINESS SETTING — never hardcoded here.
// Resolution order: ctx.application_form_url (from the KB business setting, resolved by the
// caller) → env APPLICATION_FORM_URL (legacy LEAD_APPLICATION_URL) → null ("not configured").
const NOT_CONFIGURED_URL = '[ссылка на заявку не настроена — задайте application_form_url в Базе знаний]';
function applicationFormUrl(ctx = {}) {
  return ctx.application_form_url || process.env.APPLICATION_FORM_URL || process.env.LEAD_APPLICATION_URL || null;
}

// Which kinds the spec permits without operator approval (still drafted).
const AUTO_ALLOWED = {
  greeting: true,
  education: true,
  application_link: true,
  reminder: true,
  whatsapp_request: true,
  // Operator-gated (exact price / PI / payment / recovery):
  calculation_offer: false,
  payment_instructions: false,
  recovery: false,
};

function isAutoAllowed(kind) { return AUTO_ALLOWED[kind] === true; }

// Short KB-sourced facts per service category (ranges only).
const SERVICE_BLURB = {
  declaration:    `Декларация соответствия (ДС): стоимость от ${fmt(DS.variants.with_workshop.base)} ${CURRENCY}, срок изготовления около 2 недель, действует 1–3 года (зависит от документов на цех).`,
  certificate:    `Сертификат соответствия (СС): для местных ИП/ОсОО от ${fmt(SS.base)} ${CURRENCY}, для зарубежных юрлиц ${fmt(SS.foreign_legal_entity.base)} ${CURRENCY}; срок от 1 до 1.5 месяцев, действует ${SS.validity}.`,
  refusal_letter: 'Отказное письмо: стоимость 5 000 сом — это отдельный документ.',
  sgr:            'СГР (свидетельство о госрегистрации) — отдельный вид документа; стоимость и сроки рассчитываются индивидуально.',
  mpstats:        'MPStats — аналитика маркетплейсов; подскажем по подключению.',
  wildbox:        'Wildbox — аналитика для продавцов; подскажем по подключению.',
  unknown:        'Подскажите, какой документ вас интересует — декларация, сертификат, отказное письмо или СГР?',
};

const PI_EXPLAINER =
  'ПИ — это протокол испытаний. Первый ПИ входит в стоимость документа. Дополнительные ПИ нужны, ' +
  `если разные составы товара: доп. ПИ для ДС — +${fmt(DS.additional_pi)} ${CURRENCY}, для СС — +${fmt(SS.additional_pi)} ${CURRENCY} ` +
  `(для зарубежных юрлиц +${fmt(SS.foreign_legal_entity.additional_pi)} ${CURRENCY}). Точное количество зависит от составов и требований лаборатории.`;

const TNVED_EXPLAINER =
  'ТН ВЭД — это код товара. Трикотаж — группа 61 (тянется: футболки, худи, свитшоты), швейка — ' +
  'группа 62 (не тянется: рубашки, брюки, куртки). Трикотаж и швейка, как и детское и взрослое, ' +
  'оформляются отдельно. Если кода нет — поможем подобрать.';

const GREETINGS = {
  ru: 'Здравствуйте! Это dokumenty.pro. Помогаем с сертификатами, декларациями и отказными письмами. Подскажите, что нужно оформить?',
  ky: 'Саламатсызбы! Бул dokumenty.pro. Сертификат, декларация жана отказное каттарга жардам беребиз. Эмне керек экенин жазыңыз.',
  en: 'Hello! This is dokumenty.pro. We help with certificates, declarations and refusal letters. What do you need to certify?',
  unknown: 'Здравствуйте! Это dokumenty.pro. Подскажите, что нужно оформить — сертификат, декларацию или отказное письмо?',
};

// render(kind, ctx) → proposed text. ctx: { language, service_category, lead, calc, amount }.
function render(kind, ctx = {}) {
  const lang = ctx.language || 'ru';
  switch (kind) {
    case 'greeting':
      return GREETINGS[lang] || GREETINGS.unknown;

    case 'education': {
      const blurb = SERVICE_BLURB[ctx.service_category] || SERVICE_BLURB.unknown;
      const extra = ctx.include_pi ? `\n\n${PI_EXPLAINER}` : ctx.include_tnved ? `\n\n${TNVED_EXPLAINER}` : '';
      return `${blurb}${extra}\n\nЭто ориентировочные условия — точную стоимость подтвердит специалист после расчёта.`;
    }

    case 'application_link':
      return `Чтобы начать, заполните короткую заявку: ${applicationFormUrl(ctx) || NOT_CONFIGURED_URL}\n\n` +
        'Укажите, пожалуйста: название товара, состав (это важно для расчёта количества ПИ) и ТН ВЭД, если есть ' +
        '(код помогает точнее определить документ и испытания). Если ТН ВЭД нет — поможем подобрать.';

    case 'reminder': {
      const n = ctx.reminder_no || 1;
      const tail = n >= 3 ? ' Это последнее напоминание — если интересно, ответьте, и мы продолжим.' : '';
      return `Напоминаем про оформление документа — заявку можно заполнить здесь: ${applicationFormUrl(ctx) || NOT_CONFIGURED_URL}.${tail}`;
    }

    case 'whatsapp_request':
      return 'Дальше нам удобнее вести оформление в WhatsApp — там весь рабочий процесс. ' +
        'Подскажите ваш номер WhatsApp, и специалист продолжит с вами там.';

    case 'calculation_offer': {
      const c = ctx.calc || {};
      return `Предварительный расчёт (требует подтверждения специалиста): ` +
        `${c.doc_type || 'документ'}, ПИ: ${c.pi_count ?? '?'} (доп.: ${c.additional_pi ?? 0}), ` +
        `ориентировочно ${c.total_estimate ?? '?'} ${c.currency || 'сом'}${c.is_minimum ? ' (от)' : ''}.`;
    }

    case 'payment_instructions':
      return `Для запуска оформления необходимо внести оплату${ctx.amount ? `: ${ctx.amount} сом` : ''}. ` +
        'Реквизиты пришлёт специалист. После оплаты пришлите, пожалуйста, чек.';

    case 'recovery':
      return 'Здравствуйте! Вы интересовались оформлением документов на dokumenty.pro. ' +
        'Подскажите, актуально ли ещё — будем рады помочь и ответить на вопросы.';

    default:
      return 'Здравствуйте! Чем можем помочь?';
  }
}

module.exports = {
  AUTO_ALLOWED,
  isAutoAllowed,
  render,
  fmt,
  SERVICE_BLURB,
  PI_EXPLAINER,
  TNVED_EXPLAINER,
  applicationFormUrl,
  NOT_CONFIGURED_URL,
};
