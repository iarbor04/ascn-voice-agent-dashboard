import { tenantRoute } from "@/lib/guard";
import { askTextModel } from "@/lib/text-model";
import { aiProviders, getVoiceSettings, type AiProvider } from "@/lib/voice-agents";

const system = `Ты редактор системных промптов для голосового ИИ-агента, который говорит по телефону на русском языке.
Перепиши присланный промпт так, чтобы он работал лучше в голосовом разговоре:
- короткие реплики, живая речь, без канцелярита и без зачитывания списков вслух;
- явные правила: что делать, если собеседник молчит, перебивает, отказывает, просит человека;
- обязательное подтверждение результата в конце разговора;
- сохрани все подстановки вида {{variable}} и весь смысл исходного промпта, ничего не выдумывай про бизнес.
Верни только готовый промпт, без пояснений, без markdown-заголовков и без кода.`;

async function handlePOST(request: Request) {
  const body = await request.json().catch(() => null) as { provider?: string; instructions?: string; name?: string; description?: string } | null;
  const instructions = typeof body?.instructions === "string" ? body.instructions.trim().slice(0, 30000) : "";
  if (!instructions) return Response.json({ error: "Промпт пустой — сначала напишите основу" }, { status: 400 });
  const provider = (aiProviders as readonly string[]).includes(String(body?.provider)) ? body!.provider as AiProvider : "yandex";
  const settings = await getVoiceSettings(false);
  const context = [body?.name ? `Агент: ${body.name}` : "", body?.description ? `Задача: ${body.description}` : "", "Промпт:", instructions].filter(Boolean).join("\n");
  try {
    return Response.json({ instructions: await askTextModel(provider, settings, system, context) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 502 });
  }
}

export const POST = tenantRoute(handlePOST);
