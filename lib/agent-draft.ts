export type BuilderDraft = { name: string; description: string; instructions: string; firstMessage: string; keyterms: string; guardrails: string };
export type BuilderAnswer = { reply: string; ready: boolean; draft: BuilderDraft | null };

// Модель просят вернуть JSON, но она может обернуть его в текст или в ```json.
// Разбираем терпимо: берём первый объект с нужными полями.
export function parseBuilderAnswer(raw: string): BuilderAnswer {
  const text = String(raw || "").trim();
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed !== "object" || !parsed) continue;
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      if (!reply) continue;
      const source = parsed.draft && typeof parsed.draft === "object" ? parsed.draft as Record<string, unknown> : null;
      const field = (name: string, limit: number) => (source && typeof source[name] === "string" ? String(source[name]).trim().slice(0, limit) : "");
      const instructions = field("instructions", 30000);
      const draft = instructions ? {
        name: field("name", 80) || "Голосовой агент",
        description: field("description", 500),
        instructions,
        firstMessage: field("firstMessage", 1000),
        keyterms: field("keyterms", 600),
        guardrails: field("guardrails", 2000),
      } : null;
      return { reply, ready: Boolean(draft) && parsed.ready !== false, draft };
    } catch {
      continue;
    }
  }
  // Модель ответила обычным текстом — это ещё вопрос к пользователю, не сбой.
  return { reply: text.slice(0, 4000), ready: false, draft: null };
}
