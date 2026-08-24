import { deleteVoiceAgent, listVoiceAgents, saveVoiceAgent } from "@/lib/voice-agents";

export async function GET() {
  return Response.json({ agents: await listVoiceAgents() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  try {
    return Response.json({ agent: await saveVoiceAgent(body) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось создать агента" }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null) as { id?: string } | null;
  if (!body?.id) return Response.json({ error: "Не указан агент" }, { status: 400 });
  try {
    return Response.json({ agent: await saveVoiceAgent(body, body.id) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить агента" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") || "";
  return (await deleteVoiceAgent(id)) ? Response.json({ ok: true }) : Response.json({ error: "Агент не найден" }, { status: 404 });
}
