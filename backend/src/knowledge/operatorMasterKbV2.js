'use strict';

// knowledge/operatorMasterKbV2.js — Dokumenty.pro Master Knowledge Base V2.
//
// AUTHORITY: Operator. PRIORITY: highest. STATUS: approved.
// This is OPERATOR-AUTHORED knowledge (not YouTube-extracted), supplied verbatim by
// the operator and approved by them. The seeder (knowledgeBaseService.seedOperatorKnowledge)
// persists these as status:'approved', source:'operator' — directly usable by the
// WhatsApp agent. It supersedes V1.
//
// Each entry: { category, type, text, value?, possibly_outdated?, hold_for_review?, note? }
//   • possibly_outdated  → flag for periodic re-confirmation (prices/timelines).
//   • hold_for_review    → seeded as PENDING (not activated) because it conflicts with
//                          already-canonical operational data; needs an operator decision.

const VERSION = 'V2';
const SOURCE  = 'operator_master_kb_v2';
const TITLE   = 'Operator Master Knowledge Base V2';

const PRICE = (text, amount, currency = 'сом') => ({ category: 'Payments', type: 'price', text, value: { amount, currency }, possibly_outdated: true });
const RULE  = (category, text, extra = {}) => ({ category, type: 'rule', text, ...extra });
const FACT  = (category, text, extra = {}) => ({ category, type: 'fact', text, ...extra });
const TIME  = (category, text, value, extra = {}) => ({ category, type: 'timeline', text, value, possibly_outdated: true, ...extra });

const entries = [
  // ── Governance / agent mode (mapped to Client Communication) ──
  RULE('Client Communication', 'Приоритет источников правды: 1) Оператор, 2) Декларация, 3) Approved Knowledge Base, 4) Email, 5) WhatsApp History, 6) YouTube. При конфликте оператор всегда прав.'),
  RULE('Client Communication', 'Агент анализирует, объясняет, предлагает и готовит черновики, но не принимает окончательных решений — все действия проходят через подтверждение оператора.'),
  RULE('Client Communication', 'Агент может: искать клиента, заявку, статус, оплату; считать ПИ; готовить расчёты, письма и ответы.'),
  RULE('Client Communication', 'Агент НЕ имеет права без подтверждения оператора: отправлять сообщения, менять Декларацию, менять статусы, запускать документы, отправлять Email.'),
  RULE('Client Communication', 'Если агент не уверен — не придумывать. Показать найденные данные, доказательства, уровень уверенности и рекомендуемое действие, затем запросить решение оператора.'),

  // ── Certificates (СС) ──
  RULE('Certificates', 'Сертификат соответствия (СС) оформляется через лабораторию Бермет; требуется 2 образца на каждый состав.'),
  PRICE('Стоимость СС: от 35 000 сом.', 35000),
  TIME('Certificates', 'Срок изготовления СС: от 1 месяца до 1.5 месяцев.', { value: 1, value_to: 1.5, unit: 'месяц' }),
  FACT('Certificates', 'Срок действия СС: 1 год.', { possibly_outdated: true }),
  RULE('Certificates', 'Для СС могут потребоваться дополнительные документы: техпаспорт нежилого помещения, договор аренды помещения.'),

  // ── Declarations (ДС) ──
  RULE('Declarations', 'Декларация соответствия (ДС) оформляется через лабораторию Дастан; требуется 1 образец на каждый состав.'),
  PRICE('Стоимость ДС: от 15 000 сом.', 15000),
  TIME('Declarations', 'Срок изготовления ДС: около 2 недель.', { value: 2, unit: 'недель' }),
  FACT('Declarations', 'Срок действия ДС: 3 года.', { possibly_outdated: true }),
  RULE('Declarations', 'В Кыргызстане ДС оформляется только на ИП или ОсОО Кыргызстана.'),
  RULE('Declarations', 'Декларация — центральный рабочий документ: связывает WhatsApp, Email, клиентов, оплаты и статусы. Декларации доверяем; статусы допускается проверять и аудировать.'),
  RULE('Declarations', 'Обязательные данные заявки: название товара, состав, заявитель, производитель, ТН ВЭД.'),
  RULE('Declarations', 'Производитель: если предоставляет данные — используются его данные; если отказывается — допускается указать данные клиента как производителя ТОЛЬКО при подтверждении клиента (без подтверждения нельзя).'),
  RULE('Declarations', 'Зарубежный заказчик: получить название компании, страну, ИНН/налоговый номер, реквизиты; в дополнениях указать, что товар производится по заказу данного юр. лица.'),
  RULE('Declarations', 'Отказное письмо — отдельный документ.'),
  PRICE('Стоимость отказного письма: 5 000 сом.', 5000),
  RULE('Declarations', 'СГР — отдельный вид документа; стоимость и сроки определяются отдельно.'),

  // ── TN VED ──
  RULE('TN VED', 'Трикотаж — группа ТН ВЭД 61. Признаки: тянется, петлевая структура. Примеры: футболки, майки, худи, свитшоты.', { value: { group: '61' } }),
  RULE('TN VED', 'Швейка — группа ТН ВЭД 62. Признаки: тканое полотно, практически не тянется. Примеры: рубашки, брюки, костюмы, куртки.', { value: { group: '62' } }),
  RULE('TN VED', 'Швейка и трикотаж несовместимы — нужны отдельные документы (разные технические регламенты и разные испытания).'),
  RULE('TN VED', 'Детское и взрослое несовместимы — нужны отдельные документы (разные требования безопасности и испытания).'),
  RULE('TN VED', 'По умолчанию агент не определяет совместимость категорий сам; при сомнениях создаётся предупреждение оператору, окончательное решение принимает оператор.'),
  RULE('TN VED', 'Если ТН ВЭД отсутствует — агент сообщает, что компания может помочь подобрать код.'),

  // ── PI Calculations (ПИ / протоколы испытаний) ──
  RULE('PI Calculations', 'Первый ПИ входит в стоимость документа.'),
  RULE('PI Calculations', 'Дополнительный ПИ для ДС: +7 000 сом.', { value: { amount: 7000, currency: 'сом', doc: 'ДС' }, possibly_outdated: true }),
  RULE('PI Calculations', 'Дополнительный ПИ для СС: +9 000 сом.', { value: { amount: 9000, currency: 'сом', doc: 'СС' }, possibly_outdated: true }),
  RULE('PI Calculations', 'Количество ПИ определяется количеством разных составов и требованиями лаборатории.'),
  RULE('PI Calculations', 'Агент никогда не утверждает стоимость сам: показывает расчёт, количество ПИ, основания, итоговую сумму и уровень уверенности; финальную стоимость подтверждает оператор.'),

  // ── Laboratories ──
  RULE('Laboratories', 'Бермет — обычно сертификаты (СС), 2 образца на состав.'),
  RULE('Laboratories', 'Дастан — обычно декларации (ДС), 1 образец на состав.'),
  RULE('Laboratories', 'Тема письма в лабораторию: «ИП Иванов» или «ОсОО …». Повторные заказы: «ИП Иванов 2», «ИП Иванов 3», «ИП Иванов 4».'),
  RULE('Laboratories', 'В письме в лабораторию указывается: нужен ДС или СС, количество дополнительных ПИ, необходимые приложения.'),

  // ── Payments ──
  RULE('Payments', 'Желательна полная оплата; допускается запуск при частичной оплате.'),
  RULE('Payments', 'Минимальный платёж — не менее 10 000 сом. При любых условиях платёж не может быть меньше 10 000 сом.', { value: { amount: 10000, currency: 'сом' }, possibly_outdated: true }),
  RULE('Payments', 'Для крупных заказов — не менее 60% общей суммы.'),
  RULE('Payments', 'Оригинал документа не выдаётся до полной оплаты.'),
  PRICE('Дополнительная услуга MPStats: 2 400 сом.', 2400),
  PRICE('Дополнительная услуга Wildbox: 1 700 сом.', 1700),

  // ── Samples ──
  RULE('Samples', 'Образцы: ДС — 1 образец на каждый состав; СС — 2 образца на каждый состав. Образцы обязательны.'),
  RULE('Samples', 'Запуск может быть произведён после оплаты / получения заявки / получения документов заявителя — даже если образцы ещё не поступили. Агент обязан контролировать поступление образцов.'),

  // ── Client Communication (process) ──
  RULE('Client Communication', 'Первый контакт (клиент пишет впервые): 1) поздороваться; 2) узнать, что нужно оформить; 3) отправить ссылку на заявку; 4) попросить заполнить заявку; 5) попросить свидетельство ИП/ОсОО; 6) объяснить порядок работы.'),
  RULE('Client Communication', 'После заполнения заявки клиент обязан: написать в WhatsApp, сообщить что заявка заполнена, отправить свидетельство ИП/ОсОО.'),
  RULE('Client Communication', 'При жалобе клиента: не спорить; объяснить текущий этап, сроки и причину задержки; при необходимости подготовить задачу оператору для связи с лабораторией.'),

  // ── FAQ ──
  FACT('FAQ', 'Частые вопросы: сколько стоит ДС? сколько стоит СС? сколько времени делается? что такое ПИ? что такое ТН ВЭД? какие документы нужны? можно ли без образцов? можно ли оплатить частями? можно ли объединить товары? можно ли оформить на зарубежную компанию?'),

  // ── Client-facing lifecycle narrative (V2 §15) — APPROVED with a mapping onto the
  //    canonical 7 Declaration sheet statuses. Operator decision: this is an explanation
  //    for clients, NOT the operational status values. Sheet sync stays on the 7 statuses.
  {
    category: 'Client Communication', type: 'rule',
    text: 'Клиентское описание этапов (V2 §15) — для объяснения клиенту, НЕ операционные статусы. Операционный источник истины — 7 статусов листа Декларации. Соответствие: «Получена заявка» и «Ожидается оплата» = этап до создания строки Декларации (intake); «Запуск» → Запустить; «Запущен» → Ждем макет; «Получен макет» → На согласовании; «На согласовании» → На согласовании; «Согласован» → Ждем оригинал; «Документ готов» → Оригинал получен; «Завершен» → Завершен.',
    value: {
      kind: 'status_narrative_mapping',
      operational_source: 'declaration_sheet_7_statuses',
      mapping: {
        'Получена заявка':  'intake (pre-Declaration)',
        'Ожидается оплата': 'intake (pre-Declaration)',
        'Запуск':           'Запустить',
        'Запущен':          'Ждем макет',
        'Получен макет':    'На согласовании',
        'На согласовании':  'На согласовании',
        'Согласован':       'Ждем оригинал',
        'Документ готов':   'Оригинал получен',
        'Завершен':         'Завершен',
      },
    },
    note: 'Client-facing narrative only. Operational statuses remain the canonical 7 (Запустить/Ждем макет/На согласовании/Ждем оригинал/Оригинал получен/Завершен/Отменен); sheet sync unchanged.',
  },
];

module.exports = { VERSION, SOURCE, TITLE, entries };
