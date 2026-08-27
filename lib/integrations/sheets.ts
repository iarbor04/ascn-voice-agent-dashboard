import { createSign } from "node:crypto";
import { parseServiceAccountKey, type VoiceConnectionSettings } from "@/lib/voice-agents";
import { callPublicApi } from "../../voice-gateway/public-webhook.mjs";
import { IntegrationError, type CallExport, type Destination } from "./types.ts";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const COLUMNS = "A:K";

type GoogleResponse = { status: number; text: string; json: unknown };

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Общий ключ сервисного аккаунта живёт в окружении: клиенту достаточно
// расшарить таблицу на его адрес. Свой ключ в настройках его перекрывает.
function resolveKey(settings: VoiceConnectionSettings) {
  const raw = settings.sheetsServiceAccountKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim() || "";
  if (!raw) return null;
  return parseServiceAccountKey(raw);
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(clientEmail: string, privateKey: string) {
  const cached = tokenCache.get(clientEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = { iss: clientEmail, scope: SCOPE, aud: TOKEN_ENDPOINT, iat: issuedAt, exp: issuedAt + 3600 };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(privateKey);
  const assertion = `${unsigned}.${base64url(signature)}`;

  const response = await callPublicApi(TOKEN_ENDPOINT, {
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    contentType: "application/x-www-form-urlencoded",
  }) as GoogleResponse;
  const body = response.json && typeof response.json === "object" ? response.json as Record<string, unknown> : {};
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (!token) {
    const reason = typeof body.error_description === "string" ? body.error_description : `ответ ${response.status}`;
    throw new IntegrationError(`Google не выдал токен: ${reason}`, response.status);
  }
  const lifetime = Number(body.expires_in) || 3600;
  // Минута запаса, чтобы не отправить запрос с истёкшим токеном.
  tokenCache.set(clientEmail, { token, expiresAt: Date.now() + (lifetime - 60) * 1000 });
  return token;
}

function describeError(response: GoogleResponse) {
  const body = response.json && typeof response.json === "object" ? response.json as Record<string, unknown> : {};
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  const message = typeof error.message === "string" ? error.message : "";
  if (response.status === 403) return `Google отказал в доступе${message ? `: ${message}` : ""}. Расшарьте таблицу на адрес сервисного аккаунта`;
  if (response.status === 404) return "Таблица не найдена: проверьте ссылку";
  return message ? `Google ответил: ${message}` : `Google ответил ${response.status}`;
}

function range(settings: VoiceConnectionSettings) {
  const sheet = settings.sheetsSheetName.trim();
  // Имя листа в диапазоне берётся в апострофы, внутренние апострофы удваиваются.
  return sheet ? `'${sheet.replace(/'/g, "''")}'!${COLUMNS}` : COLUMNS;
}

async function sheetsRequest(settings: VoiceConnectionSettings, path: string, options: { method?: string; body?: unknown } = {}) {
  const key = resolveKey(settings);
  if (!key) throw new IntegrationError("Ключ сервисного аккаунта Google не настроен", 400);
  const token = await accessToken(key.clientEmail, key.privateKey);
  const response = await callPublicApi(`${SHEETS_API}/${settings.sheetsSpreadsheetId}${path}`, {
    method: options.method || "GET",
    headers: { authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }) as GoogleResponse;
  if (response.status < 200 || response.status >= 300) throw new IntegrationError(describeError(response), response.status);
  return response.json;
}

function row(call: CallExport) {
  const minutes = Math.floor(call.durationSeconds / 60);
  const seconds = call.durationSeconds % 60;
  return [
    call.startedAt,
    call.direction === "inbound" ? "Входящий" : "Исходящий",
    call.phone,
    call.agentName,
    `${minutes}:${String(seconds).padStart(2, "0")}`,
    call.outcome ? (call.outcome.resolved ? "да" : "нет") : "не разобран",
    call.outcome?.summary || "",
    call.outcome?.confirmation || "",
    call.outcome?.nextStep || "",
    call.recordingUrl,
    call.transcript,
  ];
}

export const sheetsDestination: Destination = {
  id: "sheets",
  label: "Google Таблицы",

  configured(settings) {
    return Boolean(settings.sheetsSpreadsheetId && (settings.sheetsServiceAccountKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim()));
  },

  async send(call: CallExport, settings: VoiceConnectionSettings) {
    // Шапку не пишем: таблица принадлежит клиенту, он мог оформить её по-своему.
    const result = await sheetsRequest(settings, `/values/${encodeURIComponent(range(settings))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: { values: [row(call)] },
    });
    const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const updates = body.updates && typeof body.updates === "object" ? body.updates as Record<string, unknown> : {};
    const updated = typeof updates.updatedRange === "string" ? updates.updatedRange : "";
    return { entityId: updated, detail: updated ? `Строка добавлена в ${updated}` : "Строка добавлена" };
  },

  async probe(settings) {
    if (!settings.sheetsSpreadsheetId) return { ok: false, detail: "Ссылка на таблицу не указана" };
    if (!resolveKey(settings)) return { ok: false, detail: "Ключ сервисного аккаунта не настроен" };
    try {
      const info = await sheetsRequest(settings, "?fields=properties.title");
      const properties = info && typeof info === "object" ? (info as Record<string, unknown>).properties : null;
      const title = properties && typeof properties === "object" ? (properties as Record<string, unknown>).title : "";
      return { ok: true, detail: typeof title === "string" && title ? `Доступна таблица «${title}»` : "Таблица доступна" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Не удалось обратиться к Google" };
    }
  },
};

// Адрес сервисного аккаунта показываем в панели: клиенту надо расшарить
// таблицу именно на него, и угадывать его он не должен.
export function serviceAccountEmail(settings: VoiceConnectionSettings) {
  try { return resolveKey(settings)?.clientEmail || ""; } catch { return ""; }
}
