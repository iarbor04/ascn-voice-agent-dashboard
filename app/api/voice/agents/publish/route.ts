import { publishVoiceAgent, toSafeAgent, unpublishVoiceAgent } from "@/lib/voice-agents";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { id?: string; live?: boolean } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "Укажите агента" }, { status: 400 });
  const agent = body?.live === false ? await unpublishVoiceAgent(id) : await publishVoiceAgent(id);
  return agent ? Response.json({ agent: toSafeAgent(agent) }) : Response.json({ error: "Агент не найден" }, { status: 404 });
}
