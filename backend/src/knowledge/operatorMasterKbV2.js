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

// Prices/validity/samples come from the operator-tunable config (env-overridable) so the
// KB the agent quotes to clients always matches the calculation engine. See config/pricing.js.
const { PRICING, CURRENCY } = require('../config/pricing');
const DS = PRICING['ДС'], SS = PRICING['СС'];

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
  RULE('Client Communication', 'Политика многоагентной обработки: агенты (WhatsApp, Email, Document и др.) работают ПАРАЛЛЕЛЬНО и анализируют независимо. НО проверка оператором — СТРОГО последовательная: одновременно активна только одна задача оператора. Все выводы агентов попадают в ЕДИНУЮ очередь проверки. Оператор обрабатывает: 1 задача → решение → следующая задача (предотвращает перегрузку и потерю деталей). Архитектура: параллельный анализ, последовательное одобрение. Количество активных агентов-анализаторов — настраиваемое; очередь проверки оператора по умолчанию = 1 активный элемент.', {
    value: {
      kind: 'multi_agent_processing_policy',
      analysis: { parallel: true, independent: true, agents_example: ['whatsapp', 'email', 'document'], active_agents_configurable: true, per_agent_active_limit: { whatsapp_conversation: 1, email_thread: 1, document_review: 1 } },
      review: { sequential: true, one_active_task_at_a_time: true, unified_queue: true, queue_default_active_items: 1, flow: ['task', 'decision', 'next_task'] },
      principle: 'parallel analysis, sequential approval',
      rationale: 'prevents operator overload and missed details',
    },
  }),

  // ── Certificates (СС) ──
  RULE('Certificates', `Сертификат соответствия (СС) оформляется через лабораторию Бермет (Кыргыз Тест); требуется ${SS.samples_per_composition} образца на каждый состав. Срок действия ${SS.validity}.`),
  RULE('Certificates', 'Запуск СС: сертификат можно легко запустить через Бермет (Кыргыз Тест) ТОЛЬКО когда заявитель и производитель у клиента — одно и то же лицо. Если заявитель ≠ производитель — так просто не запустить, нужно уточнить у оператора.', {
    value: { kind: 'certificate_launch_condition', requires: 'applicant_equals_manufacturer', lab: 'Бермет (Кыргыз Тест)' },
  }),
  PRICE(`Стоимость СС (местные ИП/ОсОО): от ${SS.base} ${CURRENCY}; дополнительный протокол +${SS.additional_pi} ${CURRENCY}.`, SS.base),
  RULE('Certificates', `СС для ЗАРУБЕЖНЫХ юрлиц: ${SS.foreign_legal_entity.base} ${CURRENCY}; дополнительный протокол испытания +${SS.foreign_legal_entity.additional_pi} ${CURRENCY}.`, {
    value: { kind: 'certificate_pricing', segment: 'foreign_legal_entity', base: SS.foreign_legal_entity.base, additional_pi: SS.foreign_legal_entity.additional_pi },
  }),
  TIME('Certificates', 'Срок изготовления СС: от 1 месяца до 1.5 месяцев.', { value: 1, value_to: 1.5, unit: 'месяц' }),
  FACT('Certificates', 'Срок действия СС: 1 год.', { possibly_outdated: true }),
  RULE('Certificates', 'Для СС могут потребоваться дополнительные документы: техпаспорт нежилого помещения, договор аренды помещения.'),

  // ── Declarations (ДС) ──
  RULE('Declarations', 'Декларация соответствия (ДС): Дастану БОЛЬШЕ НЕ ПИШЕМ (изменились рабочие процессы; орган сообщил об изменении требований в пятницу). Перед запуском ДС агент ОБЯЗАН уточнить у клиента: есть ли у него документы на швейный цех — от этого зависят цена, срок действия, гарантия и ОРГАН выдачи. Образцов: ВСЕГДА 2 на каждый состав (независимо от документов на цех).'),
  RULE('Declarations', `ДС, ЕСТЬ документы на цех: ${DS.variants.with_workshop.base} ${CURRENCY} (документ + 1-й протокол), доп. протокол +${DS.variants.with_workshop.additional_pi} ${CURRENCY}; срок действия ${DS.variants.with_workshop.validity}; ${DS.variants.with_workshop.samples_per_composition} образца на состав; С ГАРАНТИЕЙ. ТРЕБУЕТСЯ: тех. паспорт на цех ИЛИ договор аренды цеха + свидетельство ИП/ОсОО + оплата + образец товара. Орган: Айсулуу <servisstan@internet.ru>.`, {
    value: { kind: 'declaration_pricing', variant: 'with_workshop', base: DS.variants.with_workshop.base, additional_pi: DS.variants.with_workshop.additional_pi, validity: DS.variants.with_workshop.validity, samples_per_composition: DS.variants.with_workshop.samples_per_composition, guarantee: true, requires: ['тех_паспорт_цеха_или_договор_аренды', 'свидетельство_ИП_ОсОО', 'оплата', 'образец'] },
  }),
  RULE('Declarations', `ДС, НЕТ документов на цех: ${DS.variants.no_workshop.base} ${CURRENCY} (документ + 1-й протокол), доп. протокол +${DS.variants.no_workshop.additional_pi} ${CURRENCY}; срок действия ${DS.variants.no_workshop.validity}; ${DS.variants.no_workshop.samples_per_composition} образца на состав; БЕЗ ГАРАНТИИ — протокол оформляется из Казахстана, есть риск, что таможня не пропустит. Орган: Айгерим <svnsert7@gmail.com>.`, {
    value: { kind: 'declaration_pricing', variant: 'no_workshop', base: DS.variants.no_workshop.base, additional_pi: DS.variants.no_workshop.additional_pi, validity: DS.variants.no_workshop.validity, samples_per_composition: DS.variants.no_workshop.samples_per_composition, guarantee: false, note: 'протокол из Казахстана, риск на таможне' },
  }),
  TIME('Declarations', 'Срок изготовления ДС: около 2 недель.', { value: 2, unit: 'недель' }),
  RULE('Declarations', 'В Кыргызстане ДС оформляется только на ИП или ОсОО Кыргызстана.'),
  RULE('Declarations', 'Декларация — центральный рабочий документ: связывает WhatsApp, Email, клиентов, оплаты и статусы. Декларации доверяем; статусы допускается проверять и аудировать.'),
  RULE('Declarations', 'Приоритет источника телефона/WhatsApp: номер из Декларации авторитетнее номера из Новой формы. Декларация проверяется оператором вручную; Новая форма заполняется клиентом и может содержать опечатки, устаревшие, ассистентские или временные номера. Правила сопоставления: 1) телефон Декларации — первичная идентичность; 2) телефон Новой формы — только вторичное свидетельство; 3) никогда не перезаписывать телефон Декларации из Новой формы; 4) при расхождении сформировать заметку для проверки «Phone mismatch detected. Declaration phone retained as authoritative.». Не авто-исправлять, не авто-обновлять.', {
    value: {
      kind: 'phone_source_priority',
      primary: 'declaration',
      secondary: 'new_form',
      never_overwrite_from: 'new_form',
      on_mismatch: { action: 'review_note', note: 'Phone mismatch detected. Declaration phone retained as authoritative.', auto_correct: false, auto_update: false },
    },
  }),
  RULE('Declarations', 'Пустые строки, столбцы и поля — это НОРМА процесса (исторические данные, удалённые значения, заброшенные записи, зарезервированные поля, будущее использование, чистка оператором), а НЕ ошибки. ЗАПРЕЩЕНО: авто-удалять пустые строки или столбцы; авто-перепрофилировать пустые столбцы; выводить смысл из пустоты. При КАЖДОМ пустом или подозрительно разреженном столбце: явно показать его и статистику и спросить оператора — это резерв / устарело / намеренно не используется / запланировано на будущее. Удаление, переиспользование, изменение схемы или маппинга столбцов — ТОЛЬКО после подтверждения оператора. Принцип: «неизвестно» ≠ «не используется»; «не используется» ≠ «можно удалить»; «можно удалить» требует одобрения оператора.', {
    value: {
      kind: 'empty_field_governance',
      empty_is_error: false,
      empty_reasons: ['historical', 'deleted_values', 'abandoned_records', 'reserved', 'future_use', 'operator_cleanup'],
      never: ['auto_delete_rows', 'auto_delete_columns', 'auto_repurpose_columns', 'infer_meaning_from_emptiness'],
      on_empty_or_sparse: { action: 'surface_and_ask', show_statistics: true, questions: ['reserved?', 'deprecated?', 'intentionally_unused?', 'planned_for_future?'] },
      operator_confirmation_required_before: ['delete_columns', 'reuse_columns', 'change_schema', 'change_mappings'],
      principles: ['unknown != unused', 'unused != removable', 'removable requires operator approval'],
    },
  }),
  RULE('Declarations', 'Очистка пустых строк (столбцы — НЕ трогаем: их никогда не удалять и не перепрофилировать, всегда спрашивать оператора). ПОЛНОСТЬЮ пустую строку МОЖНО предложить к удалению. «Полностью пустая» = все ячейки пусты, нет формул, нет комментариев, нет заметок, нет метаданных. Порядок: 1) найти строки-кандидаты; 2) показать номера строк; 3) показать доказательства пустоты; 4) сформировать предложение на очистку; 5) СТОП — ждать одобрения оператора. Удалять строки можно ТОЛЬКО после явного одобрения. Никогда не авто-удалять строки. Никогда не удалять массово без проверки. Правило безопасности: если уверенность, что строка полностью пуста, НИЖЕ 100% — НЕ предлагать удаление, а пометить для проверки оператором.', {
    value: {
      kind: 'empty_row_cleanup',
      columns: { deletable: false, repurposable: false, always_ask: true },
      rows: {
        proposable_for_deletion: true,
        definition_completely_empty: { all_cells_empty: true, no_formulas: true, no_comments: true, no_notes: true, no_metadata: true },
        workflow: ['detect_candidates', 'show_row_numbers', 'show_emptiness_evidence', 'generate_cleanup_proposal', 'stop_wait_for_approval'],
        never_auto_delete: true,
        never_bulk_delete_without_review: true,
        delete_only_after_explicit_approval: true,
      },
      safety: { require_100pct_confidence_empty: true, below_100pct_action: 'flag_for_operator_review_not_deletion' },
    },
  }),
  RULE('Declarations', 'Обязательные данные заявки: название товара, состав, заявитель, производитель, ТН ВЭД.'),
  RULE('Declarations', 'Производитель: если предоставляет данные — используются его данные; если отказывается — допускается указать данные клиента как производителя ТОЛЬКО при подтверждении клиента (без подтверждения нельзя).'),
  RULE('Declarations', 'Зарубежный заказчик: получить название компании, страну, ИНН/налоговый номер, реквизиты; в дополнениях указать, что товар производится по заказу данного юр. лица.'),
  RULE('Declarations', 'Отказное письмо — отдельный документ.'),
  PRICE('Стоимость отказного письма: 5 000 сом.', 5000),
  RULE('Declarations', 'СГР — отдельный вид документа; стоимость и сроки определяются отдельно.'),
  RULE('Declarations', 'ГТД (грузовая таможенная декларация): если товар ПРОИЗВЕДЁН в Кыргызстане — ГТД НЕ нужна. Если товар ИМПОРТНЫЙ — без ГТД оформить СС или ДС НЕВОЗМОЖНО; допустимая альтернатива — инвойс на товар. Агент обязан уточнить происхождение товара (произведён в КР или импортирован) и при импорте запросить ГТД либо инвойс.', {
    value: { kind: 'gtd_requirement', produced_in_kg: { gtd_required: false }, imported: { gtd_required: true, alternative: 'invoice', without_gtd_or_invoice: 'cannot_issue_SS_or_DS' } },
  }),

  // ── TN VED ──
  RULE('TN VED', 'Трикотаж — группа ТН ВЭД 61. Признаки: тянется, петлевая структура. Примеры: футболки, майки, худи, свитшоты.', { value: { group: '61' } }),
  RULE('TN VED', 'Швейка — группа ТН ВЭД 62. Признаки: тканое полотно, практически не тянется. Примеры: рубашки, брюки, костюмы, куртки.', { value: { group: '62' } }),
  RULE('TN VED', 'Швейка и трикотаж несовместимы — нужны отдельные документы (разные технические регламенты и разные испытания).'),
  RULE('TN VED', 'Детское и взрослое несовместимы — нужны отдельные документы (разные требования безопасности и испытания).'),
  RULE('TN VED', 'По умолчанию агент не определяет совместимость категорий сам; при сомнениях создаётся предупреждение оператору, окончательное решение принимает оператор.'),
  RULE('TN VED', 'Если ТН ВЭД отсутствует — агент сообщает, что компания может помочь подобрать код.'),

  // ── PI Calculations (ПИ / протоколы испытаний) ──
  RULE('PI Calculations', 'Первый ПИ входит в стоимость документа.'),
  RULE('PI Calculations', `Дополнительный ПИ (доп. протокол) для ДС: с документами на цех +${DS.variants.with_workshop.additional_pi} ${CURRENCY}; без документов на цех +${DS.variants.no_workshop.additional_pi} ${CURRENCY}.`, { value: { with_workshop: DS.variants.with_workshop.additional_pi, no_workshop: DS.variants.no_workshop.additional_pi, currency: 'сом', doc: 'ДС' } }),
  RULE('PI Calculations', `Дополнительный ПИ (доп. протокол) для СС: местные +${SS.additional_pi} ${CURRENCY}; зарубежные юрлица +${SS.foreign_legal_entity.additional_pi} ${CURRENCY}.`, { value: { amount: SS.additional_pi, foreign_amount: SS.foreign_legal_entity.additional_pi, currency: 'сом', doc: 'СС' } }),
  RULE('PI Calculations', 'Количество ПИ определяется количеством разных составов и требованиями лаборатории.'),
  RULE('PI Calculations', 'Агент никогда не утверждает стоимость сам: показывает расчёт, количество ПИ, основания, итоговую сумму и уровень уверенности; финальную стоимость подтверждает оператор.'),

  // ── Laboratories ──
  RULE('Laboratories', 'Бермет (Кыргыз Тест) — сертификаты (СС), 2 образца на состав.'),
  RULE('Laboratories', 'Декларации (ДС): орган зависит от документов на швейный цех (два разных органа). Дастану больше не пишем. ЕСТЬ документы на цех → Айсулуу <servisstan@internet.ru>; НЕТ документов на цех → Айгерим <svnsert7@gmail.com>.'),
  RULE('Laboratories', 'ВНУТРЕННЯЯ информация — ТОЛЬКО для агента и оператора, НИКОГДА не сообщать клиенту: имена и почты органов/лабораторий (Айсулуу <servisstan@internet.ru> — есть документы на цех; Айгерим <svnsert7@gmail.com> — нет документов на цех). Клиенту НЕ называть ни email, ни имя органа. Email — канал только между нами и лабораторией; заявку на почту отправляет оператор/агент, клиент в переписку с лабораторией не вовлекается.', {
    value: { kind: 'internal_only', audience: ['agent', 'operator'], never_disclose_to_client: true, items: ['lab_recipient_names', 'lab_recipient_emails'] },
  }),
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
  RULE('Samples', 'Образцы: ВСЕГДА по 2 образца на каждый состав — и для ДС, и для СС (независимо от документов на цех). Образцы обязательны.'),
  RULE('Samples', 'Пакет с образцами ОБЯЗАТЕЛЬНО подписать: указать, какому юр. лицу (заявителю) принадлежат образцы — чтобы не перепутать образцы разных клиентов и заказов.', {
    value: { kind: 'sample_labeling', requirement: 'label_bag_with_legal_entity', reason: 'avoid_mixups_between_clients_orders' },
  }),
  RULE('Samples', 'Запуск может быть произведён после оплаты / получения заявки / получения документов заявителя — даже если образцы ещё не поступили. Агент обязан контролировать поступление образцов.'),

  // ── Client Communication (process) ──
  RULE('Client Communication', 'Первый контакт (клиент пишет впервые): 1) поздороваться; 2) узнать, что нужно оформить; 3) отправить ссылку на заявку; 4) попросить заполнить заявку; 5) попросить свидетельство ИП/ОсОО; 6) объяснить порядок работы.'),
  RULE('Client Communication', 'Новые клиенты — поток ПО УМОЛЧАНИЮ: НЕ начинать с длинной квалификационной анкеты. 1) приветствие; 2) отправить ссылку на заявку; 3) дождаться заполнения заявки; 4) продолжить обработку после получения заявки. Минимум вопросов до заявки. Ссылка берётся из настраиваемого параметра application_form_url (НЕ хардкодить).', {
    value: {
      kind: 'new_client_default_flow',
      no_long_questionnaire: true,
      steps: ['greeting', 'send_application_link', 'wait_for_submission', 'continue_after_submission'],
      application_link_source: 'application_form_url',
    },
    note: 'Refines the generic first-contact rule: the DEFAULT new-client flow is minimal (greet → link → wait). Reconcile with first-contact step 2 ("узнать что нужно оформить") — operator to confirm how much pre-application qualification, if any.',
  }),
  // Operator-editable business setting (NOT a code hardcode): the application form link.
  // Resolution order in code: this KB setting → env APPLICATION_FORM_URL → "not configured".
  {
    category: 'Client Communication', type: 'fact',
    text: 'Бизнес-настройка application_form_url (ссылка на заявку): https://dokumenty.pro/zayavka. Редактируется оператором в Базе знаний; в коде НЕ хардкодится.',
    value: { kind: 'business_setting', key: 'application_form_url', url: 'https://dokumenty.pro/zayavka' },
  },

  // ── Mockup Agent / draft document generation ──
  RULE('Declarations', 'Для генерации ЧЕРНОВИКОВ документов источник истины — Google-форма (заявка). Канонические поля: APPLICANT_L_E_NAME, INN, L_E_ADRESS, PHONE_NUMBER, EMAIL, MANUFACTURER_L_E_NAME, MANUFACTURER_COUNTRY, MANUFACTURER_ADRESS, BRAND_NAME, ITEMS, ITEM_COMPOSITION, TNVED. Черновики ДС/СС заполняются из данных формы; ничего не выдумывать.', {
    value: { kind: 'draft_source_of_truth', source: 'google_form', fields: ['APPLICANT_L_E_NAME', 'INN', 'L_E_ADRESS', 'PHONE_NUMBER', 'EMAIL', 'MANUFACTURER_L_E_NAME', 'MANUFACTURER_COUNTRY', 'MANUFACTURER_ADRESS', 'BRAND_NAME', 'ITEMS', 'ITEM_COMPOSITION', 'TNVED'] },
  }),
  RULE('Declarations', 'Правило ДС «4 на состав»: для ОДНОГО состава ткани максимум 4 наименования товара ИЛИ 4 кода ТН ВЭД внутри одной ДС. Если больше 4 товаров ИЛИ больше 4 кодов ТН ВЭД на состав — возможны дополнительные протоколы испытаний (ПИ). Mockup Agent ОБЯЗАН обнаружить это условие и выдать предупреждение «Possible additional PI required. Operator review needed.» Не решать автоматически.', {
    value: { kind: 'declaration_four_per_composition', max_products_per_composition: 4, max_tnved_per_composition: 4, on_exceed: { warning: 'Possible additional PI required. Operator review needed.', auto_decide: false } },
  }),
  RULE('Declarations', 'Несколько кодов ТН ВЭД: автоматически сформировать приложение (таблицу заявки) со столбцами Наименование товара / Состав / ТН ВЭД; основной документ ссылается на приложение.', {
    value: { kind: 'multi_tnved_attachment', trigger: 'more_than_one_tnved', attachment_columns: ['product_name', 'composition', 'tnved'], main_doc_references_attachment: true },
  }),
  RULE('Laboratories', 'Пакет для лаборатории (после одобрения оператора И клиента): 1) черновик ДС или СС; 2) свидетельство клиента ИП/ОсОО/ООО; 3) стандартный текст письма в лабораторию; 4) доп. файлы при необходимости. Формировать автоматически, НЕ отправлять автоматически — нужно одобрение оператора.', {
    value: { kind: 'lab_submission_package', contents: ['draft_document', 'client_registration_certificate', 'standard_lab_email_text', 'supporting_files'], auto_generate: true, auto_send: false, operator_approval_required: true },
  }),
  // §8 — client mockup-approval message (operator stated it exists; it did NOT — adding now).
  {
    category: 'Client Communication', type: 'fact',
    text: 'Шаблон сообщения клиенту после отправки черновика (макета) на согласование: «Здравствуйте! Проверьте пожалуйста все данные заявителя, наименования товаров, состав и коды ТН ВЭД в приложенном макете. Если всё верно — подтвердите, пожалуйста. Если нужны правки — напишите, что исправить.» Используется автоматически как утверждённый шаблон при отправке макета.',
    value: { kind: 'client_template', key: 'mockup_approval_request' },
  },
  // §2/§10 — first-contact auto-reply policy (CHANGES the prior "drafted, never auto-sent" stance
  // for these 5 educational template kinds only; everything else stays gated).
  RULE('Client Communication', 'Для НОВЫХ клиентов (первый контакт из рекламы: «Салам алейкум»/«Здравствуйте»/«интересует сертификация») разрешены АВТОМАТИЧЕСКИЕ ответы БЕЗ одобрения оператора, но ТОЛЬКО утверждёнными шаблонами: 1) информация об услугах; 2) цены из Базы знаний; 3) сроки из Базы знаний; 4) ссылка на заявку; 5) инструкция по заявке. Всё остальное остаётся под контролем оператора (gated).', {
    value: { kind: 'first_contact_autoreply_policy', auto_allowed_kinds: ['service_info', 'pricing_from_kb', 'timelines_from_kb', 'application_link', 'application_instructions'], everything_else: 'gated' },
  }),
  RULE('Client Communication', 'После заполнения заявки клиент обязан: написать в WhatsApp, сообщить что заявка заполнена, отправить свидетельство ИП/ОсОО.'),
  RULE('Client Communication', 'При жалобе клиента: не спорить; объяснить текущий этап, сроки и причину задержки; при необходимости подготовить задачу оператору для связи с лабораторией.'),

  // ── FAQ ──
  FACT('FAQ', 'Частые вопросы: сколько стоит ДС? сколько стоит СС? сколько времени делается? что такое ПИ? что такое ТН ВЭД? какие документы нужны? можно ли без образцов? можно ли оплатить частями? можно ли объединить товары? можно ли оформить на зарубежную компанию?'),

  // ── Client FAQ — готовые ОТВЕТЫ клиенту (источник ответов агента). Составлены из
  //    одобренных фактов БЗ выше; цены только «от …», точную сумму подтверждает специалист. ──
  FACT('Client FAQ', `Декларация (ДС): стоимость от ${DS.variants.with_workshop.base} сом (с документами на цех) / ${DS.variants.no_workshop.base} сом (без документов), изготовление около 2 недель, срок действия от 1 до 3 лет (зависит от документов на цех). Точную сумму подтвердит специалист после расчёта.`, { value: { kind: 'client_faq', q: 'стоимость и сроки ДС' } }),
  FACT('Client FAQ', `Сертификат (СС): для местных ИП/ОсОО от ${SS.base} сом; для зарубежных юрлиц ${SS.foreign_legal_entity.base} сом. Изготовление от 1 до 1.5 месяцев, действует 1 год. Точную сумму подтвердит специалист.`, { value: { kind: 'client_faq', q: 'стоимость и сроки СС' } }),
  FACT('Client FAQ', 'Отказное письмо — отдельный документ, стоимость 5 000 сом.', { value: { kind: 'client_faq', q: 'отказное письмо' } }),
  FACT('Client FAQ', `ПИ — это протокол испытаний. Первый ПИ входит в стоимость документа; дополнительные нужны при разных составах товара (доп. ПИ: ДС с документами на цех +${DS.variants.with_workshop.additional_pi} сом, ДС без документов +${DS.variants.no_workshop.additional_pi} сом, СС для местных ИП/ОсОО +${SS.additional_pi} сом, СС для зарубежных юрлиц +${SS.foreign_legal_entity.additional_pi} сом).`, { value: { kind: 'client_faq', q: 'что такое ПИ' } }),
  FACT('Client FAQ', 'ТН ВЭД — код товара. Трикотаж — группа 61 (тянется), швейка — группа 62 (не тянется). Трикотаж и швейка, как и детское и взрослое, оформляются отдельно. Если кода нет — поможем подобрать.', { value: { kind: 'client_faq', q: 'что такое ТН ВЭД' } }),
  FACT('Client FAQ', 'Для заявки нужны: название товара, состав, заявитель, производитель, ТН ВЭД, а также свидетельство ИП/ОсОО.', { value: { kind: 'client_faq', q: 'какие документы нужны' } }),
  FACT('Client FAQ', `Образцы обязательны — по ${SS.samples_per_composition} на каждый состав (и для ДС, и для СС), но не блокируют старт: запуск возможен после оплаты/получения заявки, даже если образцы ещё не поступили. Пакет с образцами подпишите: чьи это образцы (какое юр. лицо).`, { value: { kind: 'client_faq', q: 'можно ли без образцов' } }),
  FACT('Client FAQ', 'Можно запустить при частичной оплате (минимум 10 000 сом; для крупных заказов — не менее 60%). Оригинал документа выдаётся после полной оплаты.', { value: { kind: 'client_faq', q: 'оплата частями' } }),
  FACT('Client FAQ', 'Объединять в один документ можно только совместимые категории. Трикотаж и швейка, а также детское и взрослое — оформляются отдельными документами.', { value: { kind: 'client_faq', q: 'можно ли объединить товары' } }),
  FACT('Client FAQ', 'Для зарубежного заказчика нужны: название компании, страна, ИНН/налоговый номер, реквизиты; в дополнениях указывается, что товар произведён по заказу данного юр. лица.', { value: { kind: 'client_faq', q: 'зарубежная компания' } }),
  FACT('Client FAQ', 'Нужна ли ГТД? Если товар произведён в Кыргызстане — ГТД (грузовая таможенная декларация) не нужна. Если товар импортный — без ГТД оформить сертификат (СС) или декларацию (ДС) невозможно; как альтернативу можно предоставить инвойс на товар.', { value: { kind: 'client_faq', q: 'нужна ли ГТД' } }),

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
