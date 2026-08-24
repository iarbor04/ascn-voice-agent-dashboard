import type { CallOutcome } from "@/lib/calls";
import { analysisInstruction, parseOutcome } from "@/lib/call-outcome";
import { getVoiceSettings, type AiProvider } from "@/lib/voice-agents";

async function askYandex(apiKey: string, folderId: string, dialogue: string) {
  const response = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: { authorization: `Api-Key ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ modelUri: `gpt://${folderId}/yandexgpt/latest`, completionOptions: { temperature: 0, maxTokens: 700 }, messages: [{ role: "system", text: analysisInstruction }, { role: "user", text: dialogue }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Yandex returned ${response.status}`);
  const body = await response.json() as { result?: { alternatives?: Array<{ message?: { text?: string } }> } };
  return body.result?.alternatives?.[0]?.message?.text || "";
}

async function askXai(apiKey: string, dialogue: string) {
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.6", temperature: 0, messages: [{ role: "system", content: analysisInstruction }, { role: "user", content: dialogue }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`xAI returned ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content || "";
}

async function askOpenAi(apiKey: string, projectId: string, dialogue: string) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(projectId ? { "OpenAI-Project": projectId } : {}) },
    body: JSON.stringify({ model: "gpt-4.1-mini", temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: analysisInstruction }, { role: "user", content: dialogue }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content || "";
}

export async function analyzeCallTranscript(provider: AiProvider, dialogue: string): Promise<CallOutcome | null> {
  if (!dialogue.trim()) return null;
  const settings = await getVoiceSettings(false);
  try {
    const raw = provider === "openai"
      ? settings.openaiApiKey ? await askOpenAi(settings.openaiApiKey, settings.openaiProjectId, dialogue) : ""
      : provider === "xai"
        ? settings.xaiApiKey ? await askXai(settings.xaiApiKey, dialogue) : ""
        : settings.yandexApiKey && settings.yandexFolderId ? await askYandex(settings.yandexApiKey, settings.yandexFolderId, dialogue) : "";
    return raw ? parseOutcome(raw) : null;
  } catch { return null; }
}
