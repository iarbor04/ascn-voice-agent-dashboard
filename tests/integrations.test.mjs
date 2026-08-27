import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { amoDestination } from "../lib/integrations/amocrm.ts";
import { bitrixDestination } from "../lib/integrations/bitrix.ts";
import { sheetsDestination } from "../lib/integrations/sheets.ts";
import { transport } from "../lib/integrations/transport.ts";
import { buildCallExport, detailText, IntegrationError } from "../lib/integrations/types.ts";
import { extractSpreadsheetId, parseServiceAccountKey } from "../lib/voice-agents.ts";
import { recordingToken, recordingUrl, verifyRecordingToken } from "../lib/recording-link.ts";

const baseSettings = {
  bitrixWebhookUrl: "https://portal.bitrix24.ru/rest/7/secrettoken/",
  amoBaseUrl: "https://acme.amocrm.ru",
  amoAccessToken: "amo-token",
  sheetsSpreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  sheetsSheetName: "",
  sheetsServiceAccountKey: "",
  attachRecording: true,
};

const endedCall = {
  id: "11111111-2222-4333-8444-555555555555",
  direction: "inbound",
  phone: "+79001234567",
  agentName: "Оператор поддержки",
  recordedSeconds: 95,
  outcome: { resolved: true, summary: "Записали на замену колеса", confirmation: "A-155", operator: "Игорь", nextStep: "" },
  variables: { caller_purpose: "Уточнить наличие" },
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:01:35.000Z",
  endedAt: "2026-08-27T10:01:35.000Z",
};

// Транспорт подменяем целиком: настоящий по делу не пускает запросы на localhost.
function record(responses) {
  const sent = [];
  const original = transport.call;
  transport.call = async (url, options = {}) => {
    sent.push({ url, method: options.method || "POST", body: options.body, headers: options.headers || {} });
    const next = responses.shift();
    if (!next) throw new Error(`Незапланированный запрос: ${url}`);
    return { status: next.status ?? 200, text: JSON.stringify(next.json ?? {}), json: next.json ?? {} };
  };
  return { sent, restore: () => { transport.call = original; } };
}

test("payload звонка собирается из записи и итога", () => {
  const call = buildCallExport(endedCall, "Собеседник: Привет\nАгент: Здравствуйте", "default", baseSettings);
  assert.equal(call.durationSeconds, 95, "длительность берём из записи, она точнее отметок");
  assert.equal(call.phone, "+79001234567");
  assert.equal(call.recordingUrl, "", "без RECORDING_LINK_SECRET ссылки не выдаём");

  const text = detailText(call);
  assert.match(text, /Длительность: 1:35/);
  assert.match(text, /Итог: Записали на замену колеса/);
  assert.match(text, /Подтверждение: A-155/);
  assert.match(text, /Собеседник: Привет/);
  assert.doesNotMatch(text, /Дальше:/, "пустые поля итога в описание не попадают");
});

test("выключенный тумблер убирает ссылку на запись, но не ломает выгрузку", (t) => {
  t.after(() => { delete process.env.RECORDING_LINK_SECRET; delete process.env.PUBLIC_APP_URL; });
  process.env.RECORDING_LINK_SECRET = "секрет-для-теста";
  process.env.PUBLIC_APP_URL = "https://voice.example.test";

  const withRecording = buildCallExport(endedCall, "", "default", baseSettings);
  assert.match(withRecording.recordingUrl, /^https:\/\/voice\.example\.test\/api\/voice\/recordings\/public\/default\//);

  const without = buildCallExport(endedCall, "", "default", { ...baseSettings, attachRecording: false });
  assert.equal(without.recordingUrl, "");
});

test("подпись ссылки на запись проверяется и не подходит к чужому звонку", (t) => {
  t.after(() => { delete process.env.RECORDING_LINK_SECRET; });
  process.env.RECORDING_LINK_SECRET = "секрет-для-теста";

  const token = recordingToken("default", endedCall.id);
  assert.equal(token.length, 32);
  assert.equal(verifyRecordingToken("default", endedCall.id, token), true);
  assert.equal(verifyRecordingToken("default", "99999999-2222-4333-8444-555555555555", token), false, "токен не должен подходить к другому звонку");
  assert.equal(verifyRecordingToken("11111111-1111-4111-8111-111111111111", endedCall.id, token), false, "токен не должен подходить другому тенанту");
  assert.equal(verifyRecordingToken("default", endedCall.id, ""), false);
  assert.equal(verifyRecordingToken("default", endedCall.id, "0".repeat(32)), false);
});

test("без секрета ссылки на записи не выдаются вовсе", () => {
  assert.equal(recordingToken("default", endedCall.id), "");
  assert.equal(recordingUrl("default", endedCall.id), "");
});

test("Bitrix кладёт звонок найденному контакту и не плодит лидов", async () => {
  const stub = record([
    { json: { result: { CONTACT: [412] } } },
    { json: { result: 9001 } },
  ]);
  try {
    const call = buildCallExport(endedCall, "Собеседник: Привет", "default", baseSettings);
    const result = await bitrixDestination.send(call, baseSettings);

    assert.equal(stub.sent.length, 2, "поиск дубля и добавление дела, создания лида быть не должно");
    assert.match(stub.sent[0].url, /\/rest\/7\/secrettoken\/crm\.duplicate\.findbycomm\.json$/);
    assert.match(stub.sent[1].url, /crm\.activity\.add\.json$/);

    const fields = JSON.parse(stub.sent[1].body).fields;
    assert.equal(fields.TYPE_ID, 2, "тип дела — звонок");
    assert.equal(fields.DIRECTION, 1, "входящий");
    assert.equal(fields.OWNER_TYPE_ID, 3, "владелец — контакт");
    assert.equal(fields.OWNER_ID, 412);
    assert.equal(fields.COMPLETED, "Y");
    assert.equal(fields.RESPONSIBLE_ID, 7, "ответственного берём из ссылки вебхука");
    assert.equal(result.entityId, "9001");
  } finally {
    stub.restore();
  }
});

test("Bitrix создаёт лид, когда номер незнакомый", async () => {
  const stub = record([
    { json: { result: {} } },
    { json: { result: {} } },
    { json: { result: 555 } },
    { json: { result: 9002 } },
  ]);
  try {
    const call = buildCallExport({ ...endedCall, direction: "outbound" }, "", "default", baseSettings);
    const result = await bitrixDestination.send(call, baseSettings);

    assert.equal(stub.sent.length, 4, "два поиска, создание лида, добавление дела");
    assert.match(stub.sent[2].url, /crm\.lead\.add\.json$/);
    const fields = JSON.parse(stub.sent[3].body).fields;
    assert.equal(fields.OWNER_TYPE_ID, 1, "владелец — лид");
    assert.equal(fields.OWNER_ID, 555);
    assert.equal(fields.DIRECTION, 2, "исходящий");
    assert.match(result.detail, /создан лид 555/);
  } finally {
    stub.restore();
  }
});

test("отказ Bitrix объясняется словами и не считается повторяемым", async () => {
  const stub = record([{ status: 401, json: { error: "INVALID_CREDENTIALS", error_description: "Неверный токен" } }]);
  try {
    const call = buildCallExport(endedCall, "", "default", baseSettings);
    await assert.rejects(bitrixDestination.send(call, baseSettings), (error) => {
      assert.ok(error instanceof IntegrationError);
      assert.match(error.message, /Неверный токен/);
      assert.equal(error.retriable, false, "4xx — это неверная настройка, повтор не поможет");
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("amoCRM создаёт контакт до звонка: иначе звонок молча пропадёт", async () => {
  const stub = record([
    { status: 204 },
    { json: { _embedded: { contacts: [{ id: 77 }] } } },
    { json: {} },
  ]);
  try {
    const call = buildCallExport(endedCall, "Собеседник: Привет", "default", baseSettings);
    const result = await amoDestination.send(call, baseSettings);

    assert.equal(stub.sent.length, 3);
    assert.equal(stub.sent[0].method, "GET");
    assert.match(stub.sent[0].url, /\/api\/v4\/contacts\?query=%2B79001234567$/);
    assert.match(stub.sent[1].url, /\/api\/v4\/contacts$/);
    assert.match(stub.sent[2].url, /\/api\/v4\/calls$/);

    const payload = JSON.parse(stub.sent[2].body)[0];
    assert.equal(payload.direction, "inbound");
    assert.equal(payload.duration, 95);
    assert.equal(payload.phone, "+79001234567");
    assert.equal(payload.uniq, endedCall.id);
    assert.equal(payload.call_status, 4, "разговор состоялся");
    assert.equal(stub.sent[2].headers.authorization, "Bearer amo-token");
    assert.match(result.detail, /Создан контакт 77/);
  } finally {
    stub.restore();
  }
});

test("amoCRM не создаёт второй контакт, если номер уже в базе", async () => {
  const stub = record([
    { json: { _embedded: { contacts: [{ id: 31 }] } } },
    { json: {} },
  ]);
  try {
    const call = buildCallExport({ ...endedCall, recordedSeconds: 0 }, "", "default", baseSettings);
    const result = await amoDestination.send(call, baseSettings);

    assert.equal(stub.sent.length, 2, "поиск и добавление звонка");
    assert.match(stub.sent[1].url, /\/api\/v4\/calls$/);
    assert.equal(JSON.parse(stub.sent[1].body)[0].call_status, 6, "без расшифровки — не дозвонились");
    assert.match(result.detail, /контакту 31/);
  } finally {
    stub.restore();
  }
});

test("Google Таблицы подписывают JWT и дописывают строку, а не перезаписывают", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = JSON.stringify({
    client_email: "ascn-voice@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  const settings = { ...baseSettings, sheetsServiceAccountKey: key, sheetsSheetName: "Звонки" };
  const stub = record([
    { json: { access_token: "google-token", expires_in: 3600 } },
    { json: { updates: { updatedRange: "Звонки!A2:K2" } } },
  ]);
  try {
    const call = buildCallExport(endedCall, "Собеседник: Привет", "default", settings);
    const result = await sheetsDestination.send(call, settings);

    const [tokenRequest, appendRequest] = stub.sent;
    assert.match(tokenRequest.url, /oauth2\.googleapis\.com\/token$/);
    const assertion = new URLSearchParams(tokenRequest.body).get("assertion");
    assert.equal(assertion.split(".").length, 3, "JWT из трёх частей");
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    assert.equal(claims.iss, "ascn-voice@example.iam.gserviceaccount.com");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets");

    assert.match(appendRequest.url, /:append\?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS$/);
    assert.match(appendRequest.url, /'%D0%97%D0%B2%D0%BE%D0%BD%D0%BA%D0%B8'!A%3AK/, "имя листа в апострофах и закодировано");
    const row = JSON.parse(appendRequest.body).values[0];
    assert.equal(row.length, 11);
    assert.equal(row[1], "Входящий");
    assert.equal(row[2], "+79001234567");
    assert.equal(row[5], "да");
    assert.match(result.detail, /Звонки!A2:K2/);
  } finally {
    stub.restore();
  }
});

test("нехватка доступа к таблице объясняется тем, что надо сделать", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const settings = {
    ...baseSettings,
    sheetsServiceAccountKey: JSON.stringify({
      client_email: "share-me@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  };
  const stub = record([
    { json: { access_token: "google-token", expires_in: 3600 } },
    { status: 403, json: { error: { message: "The caller does not have permission" } } },
  ]);
  try {
    const call = buildCallExport(endedCall, "", "default", settings);
    await assert.rejects(sheetsDestination.send(call, settings), /Расшарьте таблицу на адрес сервисного аккаунта/);
  } finally {
    stub.restore();
  }
});

test("ссылку на таблицу принимаем и целиком, и одним идентификатором", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(extractSpreadsheetId(id), id);
  assert.equal(extractSpreadsheetId(""), "");
  assert.throws(() => extractSpreadsheetId("совсем не ссылка"), /разобрать ссылку/);
});

test("битый ключ сервисного аккаунта отбивается при сохранении, а не при звонке", () => {
  assert.throws(() => parseServiceAccountKey("не json"), /JSON-файлом из Google Cloud/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ client_email: "a@b.c" })), /нет client_email или private_key/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----" })), /нет client_email или private_key/);
});

test("повторяем сеть и пятисотые, но не отказ по настройке", () => {
  assert.equal(new IntegrationError("Bitrix24 ответил 500", 500).retriable, true);
  assert.equal(new IntegrationError("слишком часто", 429).retriable, true);
  assert.equal(new IntegrationError("Неверный токен", 401).retriable, false);
  assert.equal(new IntegrationError("Таблица не найдена", 404).retriable, false);
  assert.equal(new IntegrationError("Webhook timeout").retriable, true);
  assert.equal(new IntegrationError("ECONNRESET").retriable, true);
  assert.equal(new IntegrationError("Webhook must be a credential-free HTTPS URL").retriable, false);
});

test("ненастроенная интеграция не считается подключённой", () => {
  assert.equal(bitrixDestination.configured({ ...baseSettings, bitrixWebhookUrl: "" }), false);
  assert.equal(bitrixDestination.configured(baseSettings), true);
  assert.equal(amoDestination.configured({ ...baseSettings, amoAccessToken: "" }), false);
  assert.equal(amoDestination.configured(baseSettings), true);
  assert.equal(sheetsDestination.configured({ ...baseSettings, sheetsSpreadsheetId: "" }), false);
});

test("подписанная ссылка на запись пропускается middleware, и только она", async () => {
  const { readFile } = await import("node:fs/promises");
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");

  // Без этой строки ссылка из карточки CRM отдаёт 401 вместо записи —
  // на этом уже спотыкались при первом деплое.
  assert.match(proxy, /pathname\.startsWith\(SIGNED_RECORDING_PREFIX\)\) return NextResponse\.next\(\)/);
  assert.match(proxy, /SIGNED_RECORDING_PREFIX = "\/api\/voice\/recordings\/public\/"/);

  // Открывать без сессии можно только вход, регистрацию, health и записи по подписи.
  const listed = proxy.match(/const PUBLIC_PATHS = \[(.*?)\]/s)[1];
  assert.deepEqual(
    listed.split(",").map((item) => item.trim().replace(/"/g, "")).filter(Boolean),
    ["/login", "/register", "/api/health"],
  );

  // Авторизованный маршрут записи обязан остаться под tenantRoute.
  const guarded = await readFile(new URL("../app/api/voice/recordings/[id]/route.ts", import.meta.url), "utf8");
  assert.match(guarded, /export const GET = tenantRoute\(handleGET\)/);
});

test("лимит инструментов одинаков на фронтенде и в backend", async () => {
  const { readFile } = await import("node:fs/promises");
  const { TOOL_LIMIT } = await import("../lib/voice-agents.ts");
  const editor = await readFile(new URL("../frontend/app/components/AgentEditor.vue", import.meta.url), "utf8");
  const frontendLimit = Number(editor.match(/const TOOL_LIMIT = (\d+)/)[1]);

  // Разойдутся — панель разрешит добавить лишние инструменты, а backend их
  // молча срежет при сохранении, и агент потеряет их без объяснения.
  assert.equal(frontendLimit, TOOL_LIMIT, "лимиты обязаны совпадать");
  assert.ok(TOOL_LIMIT > 7, "семь встроенных инструментов не должны занимать весь лимит");
});
