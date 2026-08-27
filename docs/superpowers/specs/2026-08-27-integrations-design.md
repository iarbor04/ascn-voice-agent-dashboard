# Интеграции ASCN Voice: Bitrix24, amoCRM, Google Sheets, внешний MCP

Дата: 27 августа 2026. Статус: согласовано владельцем.

## Задача

После звонка итог должен сам уходить в CRM клиента, а к агенту должен подключаться
любой внешний MCP-сервер — как в консоли Grok.

## Принятые решения

Четыре развилки закрыты владельцем, остальное — выбор реализации.

| Развилка | Решение |
| --- | --- |
| Направление данных | **Только итог после звонка.** Живых CRM-инструментов в разговоре не делаем: `ascn_contact_context`, `ascn_move_pipeline` и прочие остаются работать с локальным хранилищем и не переключаются на внешнюю CRM. |
| Вид записи в CRM | **Звонок в карточке клиента**, а не новый лид на каждый звонок. |
| Доступ к Bitrix | **Входящий вебхук.** Локальное приложение с OAuth не делаем. |
| Ссылка на запись разговора в CRM | **Включаем**, с тумблером в настройках. |

## Шаг 0: база, на которой строим

Прод в `/opt/ascn-voice` собран руками из `main` + PR #1 + PR #2 и не содержит git.
Ветки, совпадающей с продом, не существует.

Перед первой строкой функционала: ветка `integrations` = `main` + `pr1` + `pr2`,
сверенная с продом по контрольным суммам файлов. Расхождения выписать отдельно —
это следы ручных правок на сервере, их нельзя потерять молча.

Без этого шага любая правка снова уедет на прод вручную и разойдётся с репозиторием.

## Архитектура

### Контракт

Новый каталог `lib/integrations/`. Каждая CRM — отдельный файл, реализующий один
интерфейс и не знающий про остальные. Добавить четвёртую систему = один новый файл.

```ts
type CallExport = {
  phone: string;
  direction: "inbound" | "outbound";
  agentName: string;
  startedAt: string;          // ISO-8601 с зоной
  durationSeconds: number;
  transcript: string;         // «Собеседник: … / Агент: …»
  recordingUrl: string;       // пусто, если тумблер выключен
  outcome: CallOutcome | null;
  variables: Record<string, string>;
};

type SendResult = { entityId: string; detail: string };

type Destination = {
  id: "bitrix" | "amocrm" | "sheets";
  configured(settings: VoiceConnectionSettings): boolean;
  send(call: CallExport, settings: VoiceConnectionSettings): Promise<SendResult>;
  probe(settings: VoiceConnectionSettings): Promise<{ ok: boolean; detail: string }>;
};
```

`probe()` обслуживает кнопку «Проверить» в настройках и не создаёт сущности в CRM
клиента — только чтение. Конкретно: Bitrix — `crm.status.list` без параметров, amoCRM —
`GET /api/v4/account`, Sheets — `GET /v4/spreadsheets/<id>?fields=properties.title`,
что заодно проверяет, расшарена ли таблица.

### Точка отправки

`finishCall()` в `app/api/voice/runtime/route.ts:61`, сразу после `notifyByMail`.
К этому моменту уже готовы расшифровка, длительность и разбор итога моделью
(`resolved`, `summary`, `confirmation`, `operator`, `nextStep`).

Отправка не блокирует ответ шлюзу. Рядом есть расхождение, которое надо поправить
заодно: комментарий над `notifyByMail` обещает «отправляем в фоне, чтобы шлюз не ждал
SMTP», а вызов сделан через `await` — шлюз ждёт SMTP. Добавлять к этому три
последовательных HTTP-запроса в CRM нельзя.

### Транспорт

Своего HTTP-клиента не пишем. В PR #1 есть `voice-gateway/public-webhook.mjs` с
`postPublicWebhook()`: только HTTPS, URL без логина и пароля, DNS резолвится один раз
и пинится через `lookup` (защита от DNS rebinding), редиректы запрещены, лимиты
128 КБ на запрос и 100 КБ на ответ, есть тесты в `tests/public-webhook.test.mjs`.

Расширяем до `callPublicApi(url, { method, headers, body, contentType })`, сохранив
`postPublicWebhook()` тонкой обёрткой — тесты PR #1 продолжают проходить без правок.
Нужно потому, что amoCRM требует `GET` для поиска контакта, а Google — тело в
`application/x-www-form-urlencoded`.

Модуль остаётся на месте, в `voice-gateway/`, и импортируется из `lib/integrations/`.
Переносить его нельзя: это файл из незамёрженного PR #1, перемещение даст конфликт.

## Адаптер Bitrix24

Доступ — входящий вебхук, scope `crm`. Одна ссылка вида
`https://portal.bitrix24.ru/rest/<user>/<token>/`, клиент вставляет её в панель.

Порядок вызовов:

1. `crm.duplicate.findbycomm` — поиск по номеру, `type=PHONE`, `entity_type=CONTACT`,
   затем `LEAD`.
2. Не нашли — `crm.lead.add` с телефоном в `FIELDS.PHONE` и
   `TITLE` = `Звонок <номер> — <имя агента>`.
3. `crm.activity.add` с `TYPE_ID: 2` (звонок), `DIRECTION` 1 для входящего и 2 для
   исходящего, `OWNER_TYPE_ID`/`OWNER_ID` на найденную сущность, `COMMUNICATIONS` с
   номером, `START_TIME`/`END_TIME`, `COMPLETED: 'Y'`, `SUBJECT` с итогом одной
   строкой, `DESCRIPTION` с расшифровкой и ссылкой на запись.

Почему не телефонный API: `telephony.externalcall.register` документирован дословно
как «The method works only in the context of an application» — через входящий вебхук
он недоступен, вебхуку из телефонных методов доступны только `externalcall.show` и
`externalcall.hide`. Полноценная телефония потребовала бы локального приложения с
OAuth и часовыми токенами; владелец выбрал простую настройку.

Известная цена решения: `crm.activity.add` помечен «Method development has been
discontinued. Use crm.activity.todo.add». Замена не подходит — `todo.add` создаёт дело,
а не звонок, у него нет ни `DIRECTION`, ни вложений. Метод работает, Bitrix держит
deprecated REST-методы годами. Контракт `Destination` оставляет возможность добавить
OAuth-режим позже, не переписывая ничего вокруг.

## Адаптер amoCRM

Доступ — долгосрочный токен приватной интеграции, заголовок `Authorization: Bearer`.
OAuth не нужен.

Порядок вызовов:

1. `GET /api/v4/contacts?query=<телефон>` — поиск контакта.
2. Не нашли — `POST /api/v4/contacts` с номером в `custom_fields_values`.
3. `POST /api/v4/calls` с обязательными `direction`, `duration`, `source`, `phone` и
   необязательными `uniq` (id звонка у нас), `link` (запись), `call_result` (итог),
   `call_status`.

Шаг 1–2 обязателен, а не подстраховка: документация amoCRM прямо говорит «Если
сущности с таким номером нет в базе, то звонок добавлен не будет» — звонок с
незнакомого номера молча исчезает. Сопоставление у amo идёт по последним 10 цифрам
номера.

Один путь на оба направления звонка, без ветвления по `direction`.

## Адаптер Google Sheets

Сервисный аккаунт один на весь сервис, наш. Клиент делает два действия: расшаривает
свою таблицу на адрес сервисного аккаунта и вставляет ссылку на таблицу в панель.
Ни Google Cloud Console, ни верификации приложения в Google, ни refresh-токенов на
каждого тенанта.

Механика: JWT RS256 подписываем через `node:crypto` (claims `iss` = client_email,
`scope` = `https://www.googleapis.com/auth/spreadsheets`, `aud` =
`https://oauth2.googleapis.com/token`), меняем на access token, дописываем строку через
`POST /v4/spreadsheets/<id>/values/<range>:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`.
Токен кешируем в памяти на время жизни минус минута. Новых зависимостей ноль.

Колонки строки в этом порядке: дата и время, направление, номер, агент, длительность,
итог решён или нет, краткий итог, подтверждение, следующий шаг, ссылка на запись,
расшифровка. Диапазон по умолчанию — `A:K` первого листа; имя листа настраивается
полем, пустое значение означает первый лист. Заголовок строкой шапки не пишем: таблица
принадлежит клиенту, он мог оформить её по-своему.

Разовая задача владельца: создать сервисный аккаунт, включить Sheets API, положить
ключ в env как `GOOGLE_SERVICE_ACCOUNT_KEY`. Пока переменной нет, интеграция в UI
показана как недоступная с объяснением причины, а не молча не работает.

Для клиентов, не готовых давать доступ третьей стороне, остаётся поле «свой ключ
сервисного аккаунта» — оно переопределяет общий.

## Публичная ссылка на запись разговора

CRM нужен URL, который откроет менеджер. Записи сейчас за авторизацией, presigned-ссылок
в PR #1 нет.

Роут `GET /api/voice/recordings/public/<tenantId>/<callId>?token=<hmac>`:

- `token` = HMAC-SHA256 от строки `<tenantId>:<callId>` на секрете
  `RECORDING_LINK_SECRET`, первые 32 hex-символа, сравнение постоянного времени.
- `callId` проверяется на формат UUID до любого обращения к диску — так же, как это
  уже сделано в `voice-gateway/recorder.mjs`.
- Срока жизни нет: запись в CRM живёт годами, ссылка с суточным сроком там бесполезна.
  Отзыв — ротацией `RECORDING_LINK_SECRET`, она обнуляет все выданные ссылки сразу.
- Отдаём `audio/wav`, `Content-Disposition: inline`.
- Роут работает без сессии и потому **не** оборачивается в `tenantRoute()`: тенант
  берётся из пути и подставляется через `withTenant()` вручную. Это будет третий
  неавторизованный роут в приложении после входа и регистрации — при ревизии
  безопасности его надо помнить.
- Если `RECORDING_LINK_SECRET` не задана, ссылки не генерируются вовсе, а UI пишет,
  почему тумблер недоступен.

Цена решения, названная прямо: это публичная ссылка на запись телефонного разговора,
то есть персональные данные, доступные без авторизации любому, у кого есть ссылка. Она
попадёт в CRM, а оттуда в письма, выгрузки и историю клиента. Владелец решение принял.
Тумблер «прикладывать запись к карточке в CRM» в настройках, по умолчанию включён;
выключенный — `recordingUrl` уходит пустым, остальное отправляется как обычно.

## Внешний MCP-коннектор

Механика уже написана: тип в `lib/voice-agents.ts:35`, передача провайдеру в
`voice-gateway/server.mjs:50`. Работы три.

1. **Вернуть в каталог инструментов.** Убран 24 августа по решению «убери пока
   подключения», механика осталась живой.
2. **Починить перевёрнутый фильтр** в `app/voice-agents.tsx:732`. Сейчас при
   переключении на xAI код вырезает инструменты типа `mcp` — то есть у провайдера,
   который MCP принимает (проверено живой сессией 24 августа). OpenAI Realtime тоже
   принимает, тем же форматом: `type: "mcp"`, `server_label`, `server_url`,
   `authorization`, `headers`, `allowed_tools`, `require_approval`, `server_description`.
   Yandex и DeepSeek не принимают — там инструмент гасим с внятной подписью в UI, а не
   молча выбрасываем.
3. **Поля.** Добавить `allowed_tools` — список разрешённых инструментов сервера,
   ограничивает то, что агент может вызвать. `require_approval` прибить на `never` и
   убрать из UI: в телефонном звонке подтверждать вызов некому, значение `always`
   повесит разговор в тишину до таймаута.

## Интерфейс

Прод отдаёт наружу Nuxt (`frontend`, порт 3100), Next обслуживает только API. Значит
UI идёт в `frontend/app/components/IntegrationsSettings.vue`.

Повторяем существующий паттерн `voice-settings-card` из `ConnectionSettings.vue`:
логотип, заголовок, пилюля «Подключён / Не подключён», поля, кнопка «Проверить» рядом
с результатом проверки. Логотипы Bitrix24, amoCRM и Google Sheets в
`frontend/public/logos/`.

В списке звонков — значок статуса выгрузки и кнопка «Отправить снова» на упавших.

## Секреты и надёжность

Токены живут в `VoiceConnectionSettings`, который уже пер-тенантный. Наружу отдаются по
существующему паттерну `SafeVoiceSettings`: только `bitrixWebhookConfigured: true`,
никогда само значение. Частичный PUT настроек не должен обнулять неприсланные поля —
на этих граблях проект уже стоял с номерами телефонов.

Отправка: три попытки с паузами 5 с и 30 с, результат каждой пишется в
`CallRecord.integrations` как `{ bitrix: { status, detail, entityId, at } }`, где
`status` — `sent`, `failed` или `skipped` (интеграция не настроена). После третьей
неудачи — `failed` и ручной повтор из UI. Ошибка одной CRM не мешает остальным:
адаптеры независимы, `Promise.allSettled`. Повторяем только сетевые ошибки и коды 5xx;
4xx означает неверную настройку, его повтор не исправит.

Новые переменные окружения: `RECORDING_LINK_SECRET` (обязательна для ссылок на записи)
и `GOOGLE_SERVICE_ACCOUNT_KEY` (обязательна для Sheets без своего ключа у клиента).
Обе добавить в `.env.example`.

## Тесты

Node test runner, файлы `tests/*.test.mjs` — как уже принято в проекте.

- сборка `CallExport` из `CallRecord` и `CallOutcome`, включая пустой `outcome`;
- ветка amoCRM «контакт не найден» создаёт контакт до звонка;
- Bitrix: не нашли дубль — создаём лид, нашли — не создаём;
- маскировка секретов в ответе настроек;
- подпись и проверка HMAC ссылки на запись, отказ на чужом токене и на не-UUID;
- падение адаптера при недоступной CRM не роняет остальные и не роняет `finishCall`;
- `postPublicWebhook()` после расширения ведёт себя как раньше.

## Не делаем в этой итерации

- Живые CRM-инструменты в разговоре — владелец выбрал только выгрузку итога.
- amoCRM «Неразобранное» через `/api/v4/leads/unsorted/sip` для входящих с незнакомых
  номеров — отложено владельцем, эндпоинт работает только для входящих и требует
  отдельной ветки логики.
- Bitrix через локальное приложение и `telephony.externalcall.*`.
- Двусторонняя синхронизация с Google Sheets: только добавление строки.
- Коннекторы Gmail и Google Calendar — отклонены владельцем 20 августа, не предлагать.

## Проверенные факты и источники

Проверено 27 августа 2026, потому что на этом проекте документация провайдера уже
однажды обещала не то, что работает.

| Факт | Источник |
| --- | --- |
| «The method works only in the context of an application» — телефонный API Bitrix недоступен входящему вебхуку | [apidocs.bitrix24.com, telephony.externalCall.register](https://apidocs.bitrix24.com/api-reference/telephony/telephony-external-call-register.html) |
| Вебхуку доступны только `telephony.externalcall.show` и `hide` | [bitrix24.ru/apps/webhooks.php](https://www.bitrix24.ru/apps/webhooks.php) |
| `crm.activity.add`: «Method development has been discontinued. Use crm.activity.todo.add», при этом `TYPE_ID: 2`, `DIRECTION`, `FILES`, scope `crm` | [b24restdocs, crm-activity-add.md](https://github.com/bitrix24/b24restdocs/blob/main/api-reference/crm/timeline/activities/activity-base/crm-activity-add.md) |
| amoCRM: «Если сущности с таким номером нет в базе, то звонок добавлен не будет»; сопоставление по последним 10 цифрам; поля `direction`, `duration`, `source`, `phone` обязательны | [amocrm.ru, calls-api](https://www.amocrm.ru/developers/content/crm_platform/calls-api) |
| amoCRM `unsorted/sip`: `metadata` с `phone`, `called_at`, `duration`, `link`, `service_code`, `is_call_event_needed`, только для входящих | [amocrm.ru, unsorted-api](https://www.amocrm.ru/developers/content/crm_platform/unsorted-api) |
| OpenAI Realtime принимает MCP: `type: "mcp"`, `server_label`, `server_url`, `authorization`, `headers`, `allowed_tools`, `require_approval` | [developers.openai.com, realtime-mcp](https://developers.openai.com/api/docs/guides/realtime-mcp) |
| xAI принимает MCP в realtime-сессии | живая проверка 24 августа 2026, отражена в `voice-gateway/server.mjs:43` |
