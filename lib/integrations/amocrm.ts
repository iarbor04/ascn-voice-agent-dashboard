import type { VoiceConnectionSettings } from "@/lib/voice-agents";
import { callPublicApi } from "../../voice-gateway/public-webhook.mjs";
import { detailText, IntegrationError, type CallExport, type Destination } from "./types.ts";

// Коды результата звонка в amoCRM: 4 — разговор состоялся, 6 — не дозвонились.
const STATUS_TALKED = 4;
const STATUS_NO_ANSWER = 6;

type AmoResponse = { status: number; text: string; json: unknown };

function describeError(response: AmoResponse) {
  const body = response.json && typeof response.json === "object" ? response.json as Record<string, unknown> : {};
  const title = typeof body.title === "string" ? body.title : "";
  const detail = typeof body.detail === "string" ? body.detail : "";
  if (title || detail) return `amoCRM отказал: ${[title, detail].filter(Boolean).join(" — ")}`;
  if (response.status === 401) return "amoCRM отклонил токен: проверьте долгосрочный токен интеграции";
  return `amoCRM ответил ${response.status}`;
}

async function amo(settings: VoiceConnectionSettings, path: string, options: { method?: string; body?: unknown } = {}) {
  const url = `${settings.amoBaseUrl.replace(/\/+$/, "")}${path}`;
  const response = await callPublicApi(url, {
    method: options.method || "GET",
    headers: { authorization: `Bearer ${settings.amoAccessToken}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }) as AmoResponse;
  // Пустой результат поиска amoCRM отдаёт как 204 без тела — это не ошибка.
  if (response.status === 204) return null;
  if (response.status < 200 || response.status >= 300) throw new IntegrationError(describeError(response), response.status);
  return response.json;
}

function embedded(payload: unknown, collection: string) {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const container = root._embedded && typeof root._embedded === "object" ? root._embedded as Record<string, unknown> : {};
  const list = container[collection];
  return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

// Звонок с номера, которого нет в базе, amoCRM молча не добавляет —
// документация про /api/v4/calls говорит это прямым текстом. Поэтому контакт
// создаём заранее, а не надеемся на автосоздание.
async function ensureContactId(settings: VoiceConnectionSettings, call: CallExport) {
  const found = await amo(settings, `/api/v4/contacts?query=${encodeURIComponent(call.phone)}`);
  const existing = Number(embedded(found, "contacts")[0]?.id) || 0;
  if (existing) return { contactId: existing, created: false };

  const created = await amo(settings, "/api/v4/contacts", {
    method: "POST",
    body: [{
      name: call.phone,
      custom_fields_values: [{ field_code: "PHONE", values: [{ value: call.phone }] }],
    }],
  });
  const contactId = Number(embedded(created, "contacts")[0]?.id) || 0;
  if (!contactId) throw new IntegrationError("amoCRM не вернул идентификатор созданного контакта", 502);
  return { contactId, created: true };
}

export const amoDestination: Destination = {
  id: "amocrm",
  label: "amoCRM",

  configured(settings) {
    return Boolean(settings.amoBaseUrl && settings.amoAccessToken);
  },

  async send(call: CallExport, settings: VoiceConnectionSettings) {
    const { contactId, created } = await ensureContactId(settings, call);
    await amo(settings, "/api/v4/calls", {
      method: "POST",
      body: [{
        direction: call.direction,
        phone: call.phone,
        duration: call.durationSeconds,
        source: "ASCN Voice",
        uniq: call.callId,
        ...(call.recordingUrl ? { link: call.recordingUrl } : {}),
        call_status: call.transcript ? STATUS_TALKED : STATUS_NO_ANSWER,
        call_result: detailText(call).slice(0, 5000),
      }],
    });
    return {
      entityId: String(contactId),
      detail: created ? `Создан контакт ${contactId}, звонок добавлен` : `Звонок добавлен контакту ${contactId}`,
    };
  },

  async probe(settings) {
    if (!settings.amoBaseUrl) return { ok: false, detail: "Адрес аккаунта не указан" };
    if (!settings.amoAccessToken) return { ok: false, detail: "Токен не указан" };
    try {
      const account = await amo(settings, "/api/v4/account");
      const name = account && typeof account === "object" ? (account as Record<string, unknown>).name : "";
      return { ok: true, detail: typeof name === "string" && name ? `Подключён аккаунт «${name}»` : "Токен принят" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Не удалось обратиться к amoCRM" };
    }
  },
};
