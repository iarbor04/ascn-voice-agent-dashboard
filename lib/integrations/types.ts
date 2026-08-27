import type { CallOutcome, CallRecord } from "@/lib/calls";
import type { VoiceConnectionSettings } from "@/lib/voice-agents";
import { recordingUrl } from "@/lib/recording-link";

// Всё, что уходит во внешнюю систему. Адаптеры видят только этот объект и
// настройки — про базу и про звонок в трубке они не знают ничего.
export type CallExport = {
  callId: string;
  phone: string;
  direction: "inbound" | "outbound";
  agentName: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  transcript: string;
  recordingUrl: string;
  outcome: CallOutcome | null;
  variables: Record<string, string>;
};

// Повторять имеет смысл только то, что может пройти со второй попытки: сеть,
// таймаут, 429 и пятисотые. Отказ 4xx означает неверную настройку — повтор
// её не исправит, и молчать про это нельзя.
export class IntegrationError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "IntegrationError";
    this.status = status;
  }

  get retriable() {
    if (this.status) return this.status === 429 || this.status >= 500;
    return /timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(this.message);
  }
}

export type Destination = {
  id: string;
  label: string;
  configured(settings: VoiceConnectionSettings): boolean;
  send(call: CallExport, settings: VoiceConnectionSettings): Promise<{ entityId: string; detail: string }>;
  probe(settings: VoiceConnectionSettings): Promise<{ ok: boolean; detail: string }>;
};

// Расшифровку обрезаем: транспорт вебхуков не пропускает запрос больше 128 КБ,
// а длинный разговор в карточке CRM всё равно никто не читает целиком.
const TRANSCRIPT_LIMIT = 40_000;

export function buildCallExport(call: CallRecord, dialogue: string, tenantId: string, settings: VoiceConnectionSettings): CallExport {
  const endedAt = call.endedAt || call.updatedAt;
  const started = Date.parse(call.createdAt);
  const ended = Date.parse(endedAt);
  const measured = Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 1000) : 0;
  return {
    callId: call.id,
    phone: call.phone,
    direction: call.direction,
    agentName: call.agentName,
    startedAt: call.createdAt,
    endedAt,
    // Длительность записи точнее разницы отметок, когда запись велась.
    durationSeconds: Math.max(0, call.recordedSeconds || measured),
    transcript: dialogue.slice(0, TRANSCRIPT_LIMIT),
    recordingUrl: settings.attachRecording ? recordingUrl(tenantId, call.id) : "",
    outcome: call.outcome,
    variables: call.variables,
  };
}

// Человеческая сводка одной строкой — заголовок дела в Bitrix и поле итога в amo.
export function summaryLine(call: CallExport) {
  const direction = call.direction === "inbound" ? "Входящий" : "Исходящий";
  const state = call.outcome ? (call.outcome.resolved ? "задача выполнена" : "задача не закрыта") : "итог не разобран";
  return `${direction} звонок ${call.phone} — ${state}`;
}

// Подробное описание для карточки клиента.
export function detailText(call: CallExport) {
  const minutes = Math.floor(call.durationSeconds / 60);
  const seconds = call.durationSeconds % 60;
  return [
    `Агент: ${call.agentName || "не указан"}`,
    `Длительность: ${minutes}:${String(seconds).padStart(2, "0")}`,
    call.variables.caller_purpose ? `Задача звонка: ${call.variables.caller_purpose}` : "",
    call.outcome?.summary ? `Итог: ${call.outcome.summary}` : "",
    call.outcome?.confirmation ? `Подтверждение: ${call.outcome.confirmation}` : "",
    call.outcome?.operator ? `Сотрудник на линии: ${call.outcome.operator}` : "",
    call.outcome?.nextStep ? `Дальше: ${call.outcome.nextStep}` : "",
    call.recordingUrl ? `Запись разговора: ${call.recordingUrl}` : "",
    "",
    "Расшифровка:",
    call.transcript || "расшифровка пуста",
  ].filter((line) => line !== "").join("\n");
}
