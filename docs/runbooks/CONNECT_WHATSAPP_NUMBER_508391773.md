# Runbook — подключение номера 508391773 к WhatsApp Cloud API

**Цель:** сделать номер `+996 508 391 773` рабочим номером бота на официальном WhatsApp Cloud API
(Meta Graph API). Это **собственный номер бота**, отдельный от личного `507391773` оператора
(личный остаётся ручным каналом — см. память `whatsapp-test-vs-combat-numbers`).

**Разделение труда:** клики в кабинете Meta и чтение SMS-кода верификации делает **оператор**
(код приходит на физическую SIM 508391773 — иначе никак). Прописывание env на VPS, передеплой и
проверку делает **разработчик/агент**. Доступ к Facebook передавать не нужно.

**Важно (миграция, не очистка):** переключение на новый номер = **смена env-переменных**
(`WHATSAPP_PHONE_NUMBER_ID` + токен) и передеплой. **Старые данные не удаляем.**
Коллекция `whatsapp_messages` — реплика по номеру **клиента** (`phone_key`), а не по номеру бота;
история переписки и сопоставление заявок от смены номера бота не зависят. Стирать историю нельзя —
она нужна Части 3 (понять, «писал ли уже этот номер»).

---

## Предусловия

- Номер `508391773` НЕ должен быть сейчас активен в обычном приложении WhatsApp / WhatsApp Business
  на телефоне (иначе Meta не даст подключить его к Cloud API). При необходимости — удалить аккаунт
  WhatsApp на этом номере перед началом.
- Доступ к Meta Business Manager (business.facebook.com) и к приложению в
  Meta for Developers (developers.facebook.com), где уже заведён WhatsApp-продукт (тестовый US-номер).
- SIM 508391773 доступна для приёма SMS или входящего звонка.

---

## Шаги в кабинете Meta (выполняет оператор)

1. **Meta for Developers → ваше App → WhatsApp → API Setup** (или **WhatsApp Manager →
   Phone numbers**) → кнопка **Add phone number**.
2. Заполнить профиль бизнеса (display name и т.п., если попросит) → ввести номер в международном
   формате: `+996 508 391 773`.
3. Выбрать способ верификации (**SMS** или **Звонок**) → получить код **на SIM 508391773** → ввести код.
4. После верификации номер появится в списке. Скопировать:
   - **Phone number ID** — длинное число, это НЕ сам телефон (например `123456789012345`).
   - **WhatsApp Business Account ID** (WABA ID) — пригодится для шаблонов.
5. **Постоянный токен** (не 24-часовой тестовый):
   - Business Settings → **Users → System Users** → создать System User (роль Admin).
   - **Add Assets** → ваше App → дать доступ.
   - **Generate token** → выбрать App → права: `whatsapp_business_messaging`,
     `whatsapp_business_management` → сгенерировать и **сразу скопировать** (показывается один раз).
6. **App Secret:** App → **Settings → Basic → App Secret** (Show) — нужен для проверки подписи
   входящих webhook'ов.

После шагов 4–6 у оператора на руках 4 значения:
`PHONE_NUMBER_ID`, `PERMANENT_TOKEN`, `APP_SECRET`, и любой придуманный `VERIFY_TOKEN`.

---

## Шаги на сервере (выполняет разработчик/агент)

VPS: Hetzner Helsinki `157.180.38.103`, домен `dokumenty.win`
(`ssh -i ~/.ssh/cw_deploy root@157.180.38.103`). Источник в `/opt/...`, env compose-сервиса backend.

1. Прописать в env backend (тот же файл, где уже Gmail/Sheets/OpenAI ключи):

   ```
   WHATSAPP_PHONE_NUMBER_ID=<Phone number ID из шага 4>
   WHATSAPP_CLOUD_TOKEN=<PERMANENT_TOKEN из шага 5>
   WHATSAPP_VERIFY_TOKEN=<любая строка, та же, что вставите в webhook>
   WHATSAPP_APP_SECRET=<App Secret из шага 6>
   # GRAPH_API_VERSION=v21.0   # по умолчанию, менять не нужно
   ```

2. Передеплой backend:

   ```
   cd /opt/<project>
   docker compose build backend && docker compose up -d backend
   ```

3. Проверка готовности: `GET https://dokumenty.win/api/whatsapp/status` (под логином оператора)
   → должно вернуть `{ "configured": true }`.

---

## Webhook в Meta (выполняет оператор, значения от разработчика)

1. App → **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL:** `https://dokumenty.win/webhooks/whatsapp`
   - **Verify token:** ровно то же значение, что `WHATSAPP_VERIFY_TOKEN` в env.
   - Нажать **Verify and save** (Meta сделает GET-проверку; код уже это поддерживает —
     `routes/whatsappCloud.js`).
2. **Webhook fields → Subscribe** на поле **messages** (обязательно; без него входящие не приходят).

---

## Проверка end-to-end

1. **Входящее:** с любого другого телефона написать в WhatsApp на `+996 508 391 773` →
   сообщение должно появиться в инбоксе панели (Центр управления → Входящие/Главная) и осесть в
   `whatsapp_messages` (см. память `whatsapp-inbox-operator-visibility`).
2. **Исходящее (тест):** `POST https://dokumenty.win/api/whatsapp/send`
   `{ "to": "<номер, который только что написал>", "body": "тест" }` → клиент получает сообщение.
   (24-часовое окно открыто, т.к. клиент написал первым — свободный текст разрешён.)

---

## Шаблон для Части 3 — холодный контакт (одобряется Meta заранее)

Для сообщений номеру, который **нам не писал** (вне 24-часового окна), Meta требует
**заранее одобренный шаблон** — свободный текст будет отклонён.

1. **WhatsApp Manager → Account tools → Message templates → Create template:**
   - **Name:** `first_contact_check` (только латиница/цифры/подчёркивания).
   - **Category:** Utility.
   - **Language:** Russian.
   - **Body** (пример): `Здравствуйте! Вы оставляли у нас заявку на оформление документов? Подскажите, актуально ли ещё — будем рады помочь.`
   - Отправить на ревью, дождаться статуса **Approved** (обычно минуты–часы).
2. Прописать в env backend (правило «волатильные значения → env», память `declaration-cer-pricing-rules`):

   ```
   FIRST_CONTACT_TEMPLATE_NAME=first_contact_check
   FIRST_CONTACT_TEMPLATE_LANG=ru
   ```

3. Передеплой backend (как выше). После этого экран «Новые номера из заявок» в панели сможет
   отправлять одобренный шаблон по подтверждению оператора (агент сам не отправляет).

---

## Если что-то не работает

- `GET /api/whatsapp/status` → `{configured:false}`: не заданы `WHATSAPP_PHONE_NUMBER_ID` или
  `WHATSAPP_CLOUD_TOKEN`, либо backend не передеплоен.
- Webhook не верифицируется: `VERIFY_TOKEN` в env ≠ значению в Meta, или URL не на HTTPS/недоступен.
- Входящие не приходят: не подписан webhook-field **messages**; либо номер ещё не в статусе Connected.
- Исходящее вне 24ч окна отклонено (`api_error`, code 131047/132xxx): нужен одобренный шаблон
  (раздел выше) — свободный текст вне окна Meta не пропускает.
- Это типовая для RU-площадок проблема: Cloud API не работает с российских хостов
  (память `meta-blocked-on-ru-vps`) — поэтому бот живёт на Hetzner Helsinki, не трогаем.
