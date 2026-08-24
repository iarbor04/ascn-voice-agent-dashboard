import { realtimeModelCatalog, type AiProvider, type VoiceConnectionSettings } from "@/lib/voice-agents";

export type RealtimeEndpoint = { url: string; headers: Record<string, string>; model: string; rate: number };

export function realtimeEndpoint(provider: AiProvider, settings: VoiceConnectionSettings, model?: string): RealtimeEndpoint | { error: string } {
  const fallbackModel = realtimeModelCatalog.find((item) => item.provider === provider)?.id || "";
  const chosen = model && realtimeModelCatalog.some((item) => item.id === model && item.provider === provider) ? model : fallbackModel;
  if (provider === "openai") {
    if (!settings.openaiApiKey) return { error: "Ключ OpenAI не сохранён" };
    return {
      url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(chosen)}`,
      headers: { Authorization: `Bearer ${settings.openaiApiKey}`, ...(settings.openaiProjectId ? { "OpenAI-Project": settings.openaiProjectId } : {}) },
      model: chosen,
      rate: 24000,
    };
  }
  if (provider === "xai") {
    if (!settings.xaiApiKey) return { error: "Ключ xAI не сохранён" };
    return { url: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(chosen)}`, headers: { Authorization: `Bearer ${settings.xaiApiKey}` }, model: chosen, rate: 24000 };
  }
  if (!settings.yandexApiKey) return { error: "Ключ Yandex не сохранён" };
  if (!settings.yandexFolderId) return { error: "Не указан идентификатор каталога Yandex" };
  return {
    url: `wss://ai.api.cloud.yandex.net/v1/realtime?model=${encodeURIComponent(`gpt://${settings.yandexFolderId}/${chosen}`)}`,
    headers: { Authorization: `Api-Key ${settings.yandexApiKey}` },
    model: chosen,
    rate: 24000,
  };
}

export function previewSession(provider: AiProvider, voice: string, phrase: string, rate: number) {
  const instructions = `Произнеси ровно эту фразу и ничего больше: ${phrase}`;
  if (provider === "xai") {
    return { type: "session.update", session: { instructions, voice, modalities: ["audio"], input_audio_format: "pcm16", output_audio_format: "pcm16" } };
  }
  if (provider === "openai") {
    return { type: "session.update", session: { type: "realtime", instructions, output_modalities: ["audio"], audio: { output: { format: { type: "audio/pcm" }, voice } } } };
  }
  return { type: "session.update", session: { instructions, output_modalities: ["audio"], audio: { output: { format: { type: "audio/pcm", rate }, voice } } } };
}

export function wavFromPcm16(pcm: Buffer, rate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
