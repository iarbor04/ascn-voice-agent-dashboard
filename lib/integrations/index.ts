import { getCallRecord, listCallTranscript, recordIntegrationResult, type IntegrationStatus } from "@/lib/calls";
import { currentTenantId } from "@/lib/tenant-context";
import { getVoiceSettings, type VoiceConnectionSettings } from "@/lib/voice-agents";
import { amoDestination } from "./amocrm.ts";
import { bitrixDestination } from "./bitrix.ts";
import { sheetsDestination } from "./sheets.ts";
import { buildCallExport, IntegrationError, type CallExport, type Destination } from "./types.ts";

export const destinations: Destination[] = [bitrixDestination, amoDestination, sheetsDestination];

// Пауза перед второй и третьей попыткой. Повторяем только то, что имеет шанс
// пройти: сеть, таймаут, 429 и пятисотые.
const RETRY_DELAYS = [5_000, 30_000];

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retriable(error: unknown) {
  if (error instanceof IntegrationError) return error.retriable;
  const message = error instanceof Error ? error.message : "";
  return /timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message);
}

function message(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Неизвестная ошибка выгрузки";
}

async function deliver(destination: Destination, call: CallExport, settings: VoiceConnectionSettings): Promise<IntegrationStatus> {
  const at = () => new Date().toISOString();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await destination.send(call, settings);
      return { status: "sent", detail: result.detail, entityId: result.entityId, at: at() };
    } catch (error) {
      const canRetry = retriable(error) && attempt < RETRY_DELAYS.length;
      if (!canRetry) {
        const attempts = attempt + 1;
        const suffix = attempts > 1 ? ` (попыток: ${attempts})` : "";
        return { status: "failed", detail: `${message(error)}${suffix}`, entityId: "", at: at() };
      }
      await wait(RETRY_DELAYS[attempt]);
    }
  }
}

// Выгрузка звонка во все настроенные системы. Ошибка одной не мешает другим,
// поэтому Promise.allSettled, а не последовательный проход.
export async function exportCall(callId: string) {
  const call = await getCallRecord(callId);
  if (!call) return;
  const settings = await getVoiceSettings(false);
  const active = destinations.filter((destination) => destination.configured(settings));
  if (!active.length) return;

  const messages = await listCallTranscript(callId);
  const dialogue = messages.map((item) => `${item.direction === "inbound" ? "Собеседник" : "Агент"}: ${item.text}`).join("\n");
  const payload = buildCallExport(call, dialogue, currentTenantId(), settings);

  await Promise.allSettled(active.map(async (destination) => {
    const result = await deliver(destination, payload, settings);
    // Результат нужен в панели даже когда выгрузка провалилась: иначе про
    // потерянный звонок никто не узнает.
    await recordIntegrationResult(callId, destination.id, result);
    if (result.status === "failed") console.error(`Выгрузка звонка ${callId} в ${destination.label} не удалась: ${result.detail}`);
  }));
}

// Отправка в фоне: шлюз не должен ждать три внешних API, пока держит трубку.
export function exportCallInBackground(callId: string) {
  void exportCall(callId).catch((error) => {
    console.error(`Выгрузка звонка ${callId} упала целиком`, error);
  });
}

export async function probeDestination(id: string) {
  const destination = destinations.find((item) => item.id === id);
  if (!destination) return null;
  const settings = await getVoiceSettings(false);
  return { id: destination.id, label: destination.label, ...(await destination.probe(settings)) };
}
