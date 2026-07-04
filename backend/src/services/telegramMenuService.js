'use strict';

// services/telegramMenuService.js — instant answers for the Telegram bot's command menu
// (/start, /uslugi, /ceny, /zayavka, /help). These are READ-ONLY, non-committal FAQ replies
// (service list, "от …" price ranges, application link, contacts) sourced from the SAME
// pricing config + reply templates the rest of the agent uses — so the menu never quotes a
// stale price. Substantive actions (exact calc, payment, order) remain operator-gated drafts.
//
// Auto-reply is the point of a menu (the client expects an instant answer); it is limited to
// these approved static answers and can be turned off with TELEGRAM_MENU_AUTOREPLY=false
// (then the commands just feed the normal gated-draft flow).

const { PRICING, CURRENCY } = require('../config/pricing');
const templates = require('./leadReplyTemplates');

const DS = PRICING['ДС'], SS = PRICING['СС'];
const fmt = templates.fmt; // client-facing thousands formatting (17000 → "17 000")
const MENU_COMMANDS = ['start', 'uslugi', 'ceny', 'zayavka', 'help'];

function autoReplyEnabled() {
  return String(process.env.TELEGRAM_MENU_AUTOREPLY || 'true').toLowerCase() !== 'false';
}

// parseCommand('/ceny@bot') → 'ceny' (lowercased, @mention stripped); null if not a /command.
function parseCommand(text = '') {
  const m = String(text).trim().match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?\b/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  return MENU_COMMANDS.includes(cmd) ? cmd : null;
}

// answerFor(command, ctx) → instant reply text, or null if the command has no canned answer
// (e.g. /start, which the normal new-lead greeting flow handles). ctx: { application_form_url }.
// PURE — exported for testing.
function answerFor(command, ctx = {}) {
  switch (command) {
    case 'start':
      return `${templates.render('greeting', { language: 'ru' })}\n\n` +
        'Команды: /uslugi — что оформляем, /ceny — стоимость, /zayavka — оставить заявку, /help — помощь.';
    case 'uslugi':
      return 'Мы оформляем документы для маркетплейсов:\n' +
        `• ${SERVICE_SHORT.declaration}\n• ${SERVICE_SHORT.certificate}\n• ${SERVICE_SHORT.refusal}\n• ${SERVICE_SHORT.sgr}\n\n` +
        'Напишите, какой у вас товар и площадка — подскажем, какой документ нужен.';
    case 'ceny':
      return 'Ориентировочная стоимость (точную сумму подтвердит специалист после расчёта):\n' +
        `• ДС, есть документы на цех: от ${fmt(DS.variants.with_workshop.base)} ${CURRENCY}\n` +
        `• ДС, нет документов на цех: ${fmt(DS.variants.no_workshop.base)} ${CURRENCY}\n` +
        `• Доп. протокол к ДС: +${fmt(DS.additional_pi)} ${CURRENCY}\n` +
        `• СС (местные ИП/ОсОО): от ${fmt(SS.base)} ${CURRENCY}; зарубежные юрлица: ${fmt(SS.foreign_legal_entity.base)} ${CURRENCY}\n` +
        `• Доп. протокол к СС: +${fmt(SS.additional_pi)} ${CURRENCY} (зарубеж +${fmt(SS.foreign_legal_entity.additional_pi)} ${CURRENCY})\n` +
        '• Отказное письмо: 5 000 ' + CURRENCY;
    case 'zayavka':
      return templates.render('application_link', ctx);
    case 'help':
      return 'Напишите ваш вопрос — на сообщения отвечает специалист dokumenty.pro. ' +
        'Можно сразу указать товар, состав и площадку (Wildberries/Ozon). ' +
        `Оставить заявку: ${templates.applicationFormUrl(ctx) || 'ссылку пришлёт специалист'}.`;
    default:
      return null;
  }
}

const SERVICE_SHORT = {
  declaration: 'Декларация соответствия (ДС)',
  certificate: 'Сертификат соответствия (СС)',
  refusal:     'Отказное письмо',
  sgr:         'СГР (свидетельство о госрегистрации)',
};

module.exports = { MENU_COMMANDS, parseCommand, answerFor, autoReplyEnabled };
