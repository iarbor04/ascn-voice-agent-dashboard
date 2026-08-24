import { parseBuilderAnswer } from "@/lib/agent-draft";
import { askTextModel } from "@/lib/text-model";
import { aiProviders, getVoiceSettings, type AiProvider } from "@/lib/voice-agents";

const system = `Ты помогаешь владельцу бизнеса собрать голосового ИИ-агента для телефонных звонков на русском языке.
Задавай по одному короткому вопросу за раз: чем занимается бизнес, что агент должен делать в звонке, что ему запрещено, куда переводить сложные случаи.
Максимум три вопроса — потом собирай агента сам, разумно достроив недосказанное.

Отвечай ВСЕГДА одним JSON-объектом без markdown:
{"reply": "твоя реплика собеседнику", "ready": false, "draft": null}
Когда данных достаточно:
{"reply": "короткое описание, что получилось", "ready": true, "draft": {"name": "...", "description": "...", "instructions": "...", "firstMessage": "...", "keyterms": "...", "guardrails": "..."}}

Требования к instructions: промпт для голосового разговора по телефону — короткие реплики, живая речь, правила на молчание, отказ и просьбу дать человека, обязательное подтверждение результата в конце. Подставляемые значения оформляй как {{variable}}.
guardrails — построчно то, что агенту запрещено. keyterms — через запятую названия и слова, которые будут звучать в звонках.`;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { provider?: string; messages?: Array<{ role?: string; text?: string }> } | null;
  const history = (Array.isArray(body?.messages) ? body!.messages : [])
    .slice(-12)
    .map((item) => `${item?.role === "assistant" ? "Помощник" : "Владелец"}: ${String(item?.text || "").slice(0, 4000)}`)
    .filter((line) => line.length > 12);
  if (!history.length) return Response.json({ error: "Напишите, какой агент нужен" }, { status: 400 });
  const provider = (aiProviders as readonly string[]).includes(String(body?.provider)) ? body!.provider as AiProvider : "xai";
  const settings = await getVoiceSettings(false);
  try {
    // Помощник вызывается на каждую реплику, поэтому берём самую дешёвую модель.
    const answer = await askTextModel(provider, settings, system, history.join("\n"), "cheap");
    return Response.json(parseBuilderAnswer(answer));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 502 });
  }
}
