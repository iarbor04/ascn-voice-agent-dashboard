import { providerTransport, type AiProvider, type VoiceConnectionSettings } from "@/lib/voice-agents";

// Текстовые модели для служебных задач панели. Два уровня: cheap — для частых
// вызовов вроде чата-помощника, quality — для разовых, где важен результат.
// Внутри уровня список, потому что xAI регулярно отдаёт «модель перегружена».
// Замер 20 августа 2026 на одном и том же вопросе: grok-build-0.1 — 10,6 с и
// 809 токенов размышлений, grok-4.3 — 7,2 с и 445, grok-4.5 — 6,1 с,
// grok-4.20-0309-non-reasoning — 2,1 с и ноль размышлений. Размышления
// тарифицируются как выход, поэтому «дешёвая по прайсу» модель выходила и
// медленнее, и дороже. В быстрый уровень ставим модель без размышлений.
export type ModelTier = "cheap" | "quality";

const textModels: Record<string, Record<ModelTier, string[]>> = {
  xai: { cheap: ["grok-4.20-0309-non-reasoning", "grok-4.3", "grok-4.5"], quality: ["grok-4.5", "grok-4.3"] },
  openai: { cheap: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"], quality: ["gpt-4.1", "gpt-4o"] },
  yandex: { cheap: ["yandexgpt-lite/latest", "yandexgpt/latest"], quality: ["yandexgpt/latest", "yandexgpt-lite/latest"] },
};

function overloaded(message: string) {
  return /capacity|overload|rate limit|429|try again/i.test(message);
}

async function askXaiOrOpenAi(base: string, headers: Record<string, string>, model: string, system: string, user: string) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 4000 }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } | string };
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : data.error?.message || `Провайдер вернул ${response.status}`);
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("Провайдер вернул пустой ответ");
  return text;
}

async function askYandex(apiKey: string, folderId: string, model: string, system: string, user: string) {
  const response = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Api-Key ${apiKey}` },
    body: JSON.stringify({
      modelUri: `gpt://${folderId}/${model}`,
      completionOptions: { temperature: 0.3, maxTokens: 4000 },
      messages: [{ role: "system", text: system }, { role: "user", text: user }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await response.json().catch(() => ({})) as { result?: { alternatives?: Array<{ message?: { text?: string } }> }; message?: string };
  if (!response.ok) throw new Error(data.message || `Yandex вернул ${response.status}`);
  const text = data.result?.alternatives?.[0]?.message?.text?.trim() || "";
  if (!text) throw new Error("Yandex вернул пустой ответ");
  return text;
}

export async function askTextModel(provider: AiProvider, settings: VoiceConnectionSettings, system: string, user: string, tier: ModelTier = "quality") {
  const transport = providerTransport(provider);
  const models = textModels[transport]?.[tier] || [];
  let lastError = new Error("Нет доступной текстовой модели");
  for (const model of models) {
    try {
      if (transport === "xai") {
        if (!settings.xaiApiKey) throw new Error("Ключ xAI не подключён");
        return await askXaiOrOpenAi("https://api.x.ai/v1", { authorization: `Bearer ${settings.xaiApiKey}` }, model, system, user);
      }
      if (transport === "openai") {
        if (!settings.openaiApiKey) throw new Error("Ключ OpenAI не подключён");
        const headers: Record<string, string> = { authorization: `Bearer ${settings.openaiApiKey}` };
        if (settings.openaiProjectId) headers["OpenAI-Project"] = settings.openaiProjectId;
        return await askXaiOrOpenAi("https://api.openai.com/v1", headers, model, system, user);
      }
      if (!settings.yandexApiKey || !settings.yandexFolderId) throw new Error("Yandex AI Studio не подключена");
      return await askYandex(settings.yandexApiKey, settings.yandexFolderId, model, system, user);
    } catch (error) {
      lastError = error as Error;
      if (!overloaded(lastError.message)) throw lastError;
    }
  }
  throw lastError;
}
