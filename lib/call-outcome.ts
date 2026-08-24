import type { CallOutcome } from "@/lib/calls";

export const analysisInstruction = `Ты аналитик телефонных звонков. По расшифровке верни ТОЛЬКО JSON без пояснений и без markdown:
{"resolved": true|false, "summary": "итог звонка одним-двумя предложениями", "confirmation": "номер подтверждения, заявки или заказа, если назывался, иначе пустая строка", "operator": "имя сотрудника на другой стороне, если называл, иначе пустая строка", "nextStep": "что нужно сделать дальше, иначе пустая строка"}
resolved = true, только если задача звонка действительно выполнена. Не выдумывай данные, которых нет в расшифровке.`;

export function parseOutcome(raw: string): CallOutcome | null {
  const text = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const field = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 2000) : "");
    return { resolved: parsed.resolved === true, summary: field(parsed.summary), confirmation: field(parsed.confirmation), operator: field(parsed.operator), nextStep: field(parsed.nextStep) };
  } catch { return null; }
}
